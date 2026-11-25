"""Neural Layout Policy & Closed-Loop Target-Guided Training Loop."""

from __future__ import annotations

import copy
import json
import math
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F

from . import (
    DEFAULT_CHECKPOINT_DIR,
    DEFAULT_CHECKPOINT_PATH,
    DEFAULT_HISTORY_PATH,
    DEFAULT_REPLAY_PATH,
)
from .perception import _box_iou, perceive_pdf

STRATEGIES: List[str] = [
    "PLANAR_GRID_SOLVER",
    "KEY_VALUE_SUBGRID_FLATTENER",
    "DUAL_TRACK_STREAM_SOLVER",
    "INDENTATION_CLAUSE_SOLVER",
    "HLINE_OPERATOR_EQUATION_SOLVER",
    "DENSITY_TRANSITION_SPLITTER",
]

FEATURE_DIM = 16
PARAM_DIM = 6

DEFAULT_WEIGHTS: Dict[str, float] = {
    "baselineYTolPt": 1.5,
    "justifyGapRatio": 1.8,
    "markerGapRatio": 0.35,
    "spaceGapRatio": 0.18,
    "bannerLuminanceMax": 242.0,
    "fullWidthBannerRatio": 0.70,
    "minCenterGutterPt": 6.0,
    "hDividerMinWidthRatio": 0.85,
    "xClusterTolPt": 4.0,
    "yRowClusterTolPt": 3.5,
    "paragraphLeadingRatio": 1.65,
    "leftAnchorTolPt": 5.0,
    "charWidthFactor": 0.50,
    "lineHeightMultiplier": 1.40,
    "cellPadVerticalPt": 4.0,
    "cellPadHorizontalPt": 4.0,
    "sectionGapPt": 6.0,
}


class LayoutPolicyNet(nn.Module):
    """Maps 16 normalized geometric container features to solver strategy logits and continuous compiler parameters."""

    def __init__(self, feature_dim: int = FEATURE_DIM, hidden_dim: int = 64, num_strategies: int = len(STRATEGIES)):
        super().__init__()
        self.in_proj = nn.Linear(feature_dim, hidden_dim)
        self.norm1 = nn.LayerNorm(hidden_dim)
        self.block = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, hidden_dim),
        )
        self.norm2 = nn.LayerNorm(hidden_dim)
        self.strategy_head = nn.Linear(hidden_dim, num_strategies)
        self.param_head = nn.Linear(hidden_dim, PARAM_DIM)

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        h = F.silu(self.norm1(self.in_proj(x)))
        h = self.norm2(h + self.block(h))
        strategy_logits = self.strategy_head(h)
        # Continuous parameters normalized to [0, 1] via sigmoid
        params_unit = torch.sigmoid(self.param_head(h))
        return strategy_logits, params_unit


def decode_continuous_params(params_unit: List[float], base_weights: Optional[Dict[str, float]] = None) -> Tuple[Dict[str, float], float]:
    """Decode [0,1]^6 neural outputs into bounded TypeScript CompilerWeights + colspan aggressiveness."""
    w = dict(DEFAULT_WEIGHTS)
    if base_weights:
        w.update(base_weights)

    u_lh, u_pv, u_ph, u_xt, u_yt, u_col = [max(0.0, min(1.0, float(v))) for v in params_unit[:6]]
    w["lineHeightMultiplier"] = round(1.12 + u_lh * 0.48, 4)   # [1.12, 1.60]
    w["cellPadVerticalPt"] = round(1.5 + u_pv * 4.5, 4)       # [1.5, 6.0]
    w["cellPadHorizontalPt"] = round(2.0 + u_ph * 4.0, 4)     # [2.0, 6.0]
    w["xClusterTolPt"] = round(2.5 + u_xt * 4.5, 4)           # [2.5, 7.0]
    w["yRowClusterTolPt"] = round(2.0 + u_yt * 4.0, 4)        # [2.0, 6.0]
    colspan_agg = round(u_col, 4)
    return w, colspan_agg


def _resolve_repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def compile_and_render_via_bridge(
    pdf_path: str,
    perception_layout: Dict[str, Any],
    weights: Dict[str, float],
    constraints: Dict[str, Any],
    work_dir: str,
    schema_version: str = "2008",
    enforce_page_parity: bool = False,
    include_full_result: bool = False,
) -> Dict[str, Any]:
    repo_root = _resolve_repo_root()
    bridge_script = os.path.join(repo_root, "src", "cli", "mlCompileBridge.ts")
    rendered_pdf_path = os.path.join(work_dir, "rendered_output.pdf")
    full_result_path = os.path.join(work_dir, "full_result.json") if include_full_result else None
    bridge_in_path = os.path.join(work_dir, "bridge_input.json")

    payload = {
        "pdfPath": pdf_path,
        "documentName": perception_layout.get("document", {}).get("name"),
        "schemaVersion": schema_version,
        "weights": weights,
        "calibrationConstraints": constraints,
        "preAnalyzedLayout": perception_layout,
        "renderedPdfOutPath": rendered_pdf_path,
        "fullResultOutPath": full_result_path,
        "includeFullResult": include_full_result,
        "enforcePageParity": enforce_page_parity,
    }
    with open(bridge_in_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)

    cmd = ["npx", "tsx", bridge_script, "--input", bridge_in_path]
    proc = subprocess.run(
        cmd,
        cwd=repo_root,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TypeScript compiler bridge failed ({proc.returncode}): {proc.stderr[-600:]}")

    return json.loads(proc.stdout)


def _rasterize_rendered_pdf_and_words(rendered_pdf_path: str, work_dir: str, dpi: int = 300) -> Tuple[List[str], List[List[Dict[str, Any]]]]:
    import fitz

    doc = fitz.open(rendered_pdf_path)
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    png_paths: List[str] = []
    words_by_page: List[List[Dict[str, Any]]] = []
    for idx in range(len(doc)):
        page = doc[idx]
        pix = page.get_pixmap(matrix=mat, alpha=False)
        out_png = os.path.join(work_dir, f"rendered_page_{idx + 1}.png")
        pix.save(out_png)
        png_paths.append(out_png)
        words_raw = page.get_text("words") or []
        words_by_page.append(
            [
                {"x0": float(w[0]), "y0": float(w[1]), "x1": float(w[2]), "y1": float(w[3]), "text": str(w[4])}
                for w in words_raw
                if str(w[4]).strip()
            ]
        )
    return png_paths, words_by_page


def evaluate_epoch_loss(
    target_png_paths: List[str],
    rendered_png_paths: List[str],
    target_words_by_page: List[List[Dict[str, Any]]],
    rendered_words_by_page: List[List[Dict[str, Any]]],
    bridge_summary: Dict[str, Any],
) -> Dict[str, Any]:
    import cv2
    import numpy as np
    from skimage.metrics import structural_similarity as ssim

    source_pages = int(bridge_summary.get("sourcePageCount", len(target_png_paths)))
    rendered_pages = int(bridge_summary.get("renderedPageCount", len(rendered_png_paths)))
    page_count_diff = abs(rendered_pages - source_pages)
    overlap_count = int(bridge_summary.get("collisionsCount", 0))
    clipped_row_count = int(bridge_summary.get("clippedRowsCount", 0))

    pair_count = min(len(target_png_paths), len(rendered_png_paths))
    ssim_scores: List[float] = []
    iou_scores: List[float] = []

    for p_idx in range(pair_count):
        img_a = cv2.imread(target_png_paths[p_idx], cv2.IMREAD_GRAYSCALE)
        img_b = cv2.imread(rendered_png_paths[p_idx], cv2.IMREAD_GRAYSCALE)
        if img_a is not None and img_b is not None:
            if img_a.shape != img_b.shape:
                img_b = cv2.resize(img_b, (img_a.shape[1], img_a.shape[0]), interpolation=cv2.INTER_AREA)
            score = float(ssim(img_a, img_b, data_range=255))
            ssim_scores.append(max(0.0, min(1.0, score)))

        t_words = target_words_by_page[p_idx] if p_idx < len(target_words_by_page) else []
        r_words = rendered_words_by_page[p_idx] if p_idx < len(rendered_words_by_page) else []
        if t_words and r_words:
            # Greedy spatial box IoU alignment per page
            sample_t = t_words[:180]
            page_ious: List[float] = []
            for tw in sample_t:
                tb = (tw["x0"], tw["y0"], tw["x1"], tw["y1"])
                best = 0.0
                for rw in r_words:
                    if abs(rw["y0"] - tw["y0"]) > 24.0:
                        continue
                    rb = (rw["x0"], rw["y0"], rw["x1"], rw["y1"])
                    v = _box_iou(tb, rb)
                    if v > best:
                        best = v
                page_ious.append(best)
            iou_scores.append(float(np.mean(page_ious)) if page_ious else 0.0)
        elif not t_words and not r_words:
            iou_scores.append(1.0)
        else:
            iou_scores.append(0.0)

    # Penalize unmatched pages by multiplying over source page count
    if source_pages > pair_count and ssim_scores:
        ssim_scores.extend([0.0] * (source_pages - pair_count))
    if source_pages > len(iou_scores) and iou_scores:
        iou_scores.extend([0.0] * (source_pages - len(iou_scores)))

    mean_ssim = float(sum(ssim_scores) / max(1, len(ssim_scores)))
    mean_iou = float(sum(iou_scores) / max(1, len(iou_scores)))

    total_loss = (
        10.0 * (1.0 - mean_ssim)
        + 5.0 * (1.0 - mean_iou)
        + 20.0 * float(page_count_diff)
        + 15.0 * float(overlap_count)
        + 10.0 * float(clipped_row_count)
    )

    return {
        "meanSsim": round(mean_ssim, 5),
        "meanIou": round(mean_iou, 5),
        "sourcePageCount": source_pages,
        "renderedPageCount": rendered_pages,
        "pageCountDiff": page_count_diff,
        "overlapCount": overlap_count,
        "clippedRowCount": clipped_row_count,
        "totalLoss": round(total_loss, 5),
    }


def _apply_counterexample_repair(
    constraints: Dict[str, Any],
    weights: Dict[str, float],
    bridge_summary: Dict[str, Any],
    colspan_agg: float,
) -> Tuple[Dict[str, Any], Dict[str, float], List[str]]:
    next_constraints = copy.deepcopy(constraints)
    next_weights = dict(weights)
    actions: List[str] = []

    page_overrides = list(next_constraints.get("pageOverrides") or [])
    spillovers = list(bridge_summary.get("pageSpillovers") or [])
    clipped = list(bridge_summary.get("clippedRows") or [])
    collisions = list(bridge_summary.get("collisions") or [])

    if colspan_agg >= 0.5:
        for sp in spillovers:
            pnum = int(sp.get("sourcePage", 1))
            ov = next((o for o in page_overrides if int(o.get("pageNumber", -1)) == pnum), None)
            if ov is None:
                ov = {"pageNumber": pnum}
                page_overrides.append(ov)
            ov["extendTrailingColSpan"] = True
            ov["mergeOverSplitRows"] = True
            cur_lh = float(ov.get("lineHeightMultiplier", next_weights["lineHeightMultiplier"]))
            ov["lineHeightMultiplier"] = round(max(1.12, cur_lh - 0.05), 4)
            cur_pv = float(ov.get("cellPadVerticalPt", next_weights["cellPadVerticalPt"]))
            ov["cellPadVerticalPt"] = round(max(1.0, cur_pv - 0.5), 4)
            actions.append(f"Repair P{pnum} spillover (colSpan+mergeRows+tighten)")

    if clipped:
        next_weights["lineHeightMultiplier"] = round(min(1.55, next_weights["lineHeightMultiplier"] + 0.04), 4)
        actions.append("Increase lineHeightMultiplier for clipped rows")

    if collisions:
        for col in collisions[:3]:
            pnum = int(col.get("page", 1))
            ov = next((o for o in page_overrides if int(o.get("pageNumber", -1)) == pnum), None)
            if ov is None:
                ov = {"pageNumber": pnum}
                page_overrides.append(ov)
            ov["sectionGapPt"] = round(float(ov.get("sectionGapPt", next_weights["sectionGapPt"])) + 2.0, 2)
        actions.append("Expand sectionGapPt for collisions")

    next_constraints["pageOverrides"] = page_overrides
    return next_constraints, next_weights, actions


def _load_json_safe(path: str, default: Any) -> Any:
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return default
    return default


def save_checkpoint(
    model: LayoutPolicyNet,
    weights: Dict[str, float],
    constraints: Dict[str, Any],
    best_ssim: float,
    best_loss: float,
    epoch_history: List[Dict[str, Any]],
    replay_samples: List[Dict[str, Any]],
    checkpoint_path: str = DEFAULT_CHECKPOINT_PATH,
) -> None:
    os.makedirs(os.path.dirname(checkpoint_path), exist_ok=True)
    torch.save(
        {
            "state_dict": model.state_dict(),
            "weights": weights,
            "constraints": constraints,
            "best_ssim": best_ssim,
            "best_loss": best_loss,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "strategies": STRATEGIES,
        },
        checkpoint_path,
    )
    with open(DEFAULT_HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(epoch_history, f, indent=2)
    with open(DEFAULT_REPLAY_PATH, "w", encoding="utf-8") as f:
        json.dump(replay_samples[-32:], f, indent=2)


def load_policy_checkpoint(checkpoint_path: str = DEFAULT_CHECKPOINT_PATH) -> Tuple[LayoutPolicyNet, Dict[str, Any]]:
    model = LayoutPolicyNet()
    if not os.path.isfile(checkpoint_path):
        return model, {
            "loaded": False,
            "weights": dict(DEFAULT_WEIGHTS),
            "constraints": {
                "forbidColumnSplits": [],
                "forceTablixSplitsY": [],
                "forceRowSplitsY": [],
                "strategyOverrides": [],
                "pageOverrides": [],
            },
            "best_ssim": 0.0,
            "best_loss": 9999.0,
        }
    ckpt = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    return model, {
        "loaded": True,
        "weights": ckpt.get("weights", dict(DEFAULT_WEIGHTS)),
        "constraints": ckpt.get("constraints", {"forbidColumnSplits": [], "forceTablixSplitsY": [], "forceRowSplitsY": [], "strategyOverrides": [], "pageOverrides": []}),
        "best_ssim": float(ckpt.get("best_ssim", 0.0)),
        "best_loss": float(ckpt.get("best_loss", 9999.0)),
        "updated_at": ckpt.get("updated_at"),
    }


def train_on_pdf(
    pdf_path: str,
    max_epochs: int = 12,
    target_ssim: float = 0.95,
    schema_version: str = "2008",
    checkpoint_path: str = DEFAULT_CHECKPOINT_PATH,
    on_epoch: Optional[Callable[[Dict[str, Any]], None]] = None,
    replay_samples: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    os.makedirs(DEFAULT_CHECKPOINT_DIR, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="reportgen_ml_train_") as work_dir:
        perception = perceive_pdf(pdf_path=pdf_path, work_dir=work_dir, dpi=300)
        containers = perception["containers"]
        target_pngs = perception["targetPngPaths"]
        target_words = perception["wordBoxesByPage"]
        layout_model = perception["layoutModel"]

        model, ckpt_meta = load_policy_checkpoint(checkpoint_path)
        model.train()
        optimizer = torch.optim.Adam(model.parameters(), lr=3e-3)

        if replay_samples is None:
            replay_samples = _load_json_safe(DEFAULT_REPLAY_PATH, [])

        feat_tensor = (
            torch.tensor([c["features"] for c in containers], dtype=torch.float32)
            if containers
            else torch.zeros((1, FEATURE_DIM), dtype=torch.float32)
        )

        best_loss = float("inf")
        best_ssim = 0.0
        best_weights = dict(ckpt_meta["weights"])
        best_constraints = copy.deepcopy(ckpt_meta["constraints"])
        running_constraints = copy.deepcopy(ckpt_meta["constraints"])
        baseline_loss: Optional[float] = None
        epochs_trace: List[Dict[str, Any]] = []

        for epoch in range(1, max_epochs + 1):
            logits, params_unit = model(feat_tensor)
            probs = F.softmax(logits, dim=-1)
            dist = torch.distributions.Categorical(probs)
            # Greedy on epoch 1 and final pass, exploratory sampling on intermediate epochs
            if epoch == 1:
                sampled_idx = torch.argmax(probs, dim=-1)
            else:
                sampled_idx = dist.sample()

            mean_params = params_unit.mean(dim=0)
            # Evolution Strategies perturbation after epoch 1
            noise = torch.zeros_like(mean_params) if epoch == 1 else torch.clamp(torch.randn_like(mean_params) * 0.08, -0.2, 0.2)
            perturbed_params = torch.clamp(mean_params.detach() + noise, 0.0, 1.0)
            epoch_weights, colspan_agg = decode_continuous_params(perturbed_params.tolist(), best_weights)

            strategy_overrides: List[Dict[str, Any]] = []
            for idx, cont in enumerate(containers):
                strat = STRATEGIES[int(sampled_idx[idx].item())]
                strategy_overrides.append(
                    {
                        "containerKey": cont["containerKey"],
                        "pageNumber": int(cont["pageNumber"]),
                        "strategy": strat,
                        "xRangePt": [cont["x0Pt"], cont["x1Pt"]],
                        "yRangePt": [cont["y0Pt"], cont["y1Pt"]],
                        "reason": f"ML epoch {epoch} policy",
                    }
                )
            epoch_constraints = copy.deepcopy(running_constraints)
            epoch_constraints["strategyOverrides"] = strategy_overrides

            ep_work = os.path.join(work_dir, f"ep_{epoch}")
            os.makedirs(ep_work, exist_ok=True)
            bridge_res = compile_and_render_via_bridge(
                pdf_path=pdf_path,
                perception_layout=layout_model,
                weights=epoch_weights,
                constraints=epoch_constraints,
                work_dir=ep_work,
                schema_version=schema_version,
                enforce_page_parity=(epoch == max_epochs),
                include_full_result=False,
            )

            rendered_pngs, rendered_words = _rasterize_rendered_pdf_and_words(
                bridge_res["renderedPdfOutPath"], ep_work, dpi=300
            )
            metrics = evaluate_epoch_loss(
                target_png_paths=target_pngs,
                rendered_png_paths=rendered_pngs,
                target_words_by_page=target_words,
                rendered_words_by_page=rendered_words,
                bridge_summary=bridge_res,
            )

            loss_val = metrics["totalLoss"]
            if baseline_loss is None:
                baseline_loss = loss_val
            advantage = baseline_loss - loss_val
            baseline_loss = 0.7 * baseline_loss + 0.3 * loss_val

            # REINFORCE + parameter MSE towards improving perturbation + replay buffer distillation
            log_probs = dist.log_prob(sampled_idx)
            pg_loss = -(log_probs.mean() * torch.tensor(advantage, dtype=torch.float32))
            if advantage >= 0:
                param_target = perturbed_params
            else:
                param_target = mean_params.detach()
            param_loss = F.mse_loss(mean_params, param_target)

            # Replay buffer cross-entropy regularization to prevent catastrophic forgetting on prior PDFs
            replay_loss = torch.tensor(0.0, dtype=torch.float32)
            if replay_samples:
                r_feats = torch.tensor([s["features"] for s in replay_samples[-24:]], dtype=torch.float32)
                r_targets = torch.tensor([int(s["strategyIndex"]) for s in replay_samples[-24:]], dtype=torch.long)
                r_logits, _ = model(r_feats)
                replay_loss = 0.35 * F.cross_entropy(r_logits, r_targets)

            total_torch_loss = pg_loss + 2.0 * param_loss + replay_loss
            optimizer.zero_grad()
            total_torch_loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

            # Counterexample structural repair if parity or overlap failed
            running_constraints, repaired_weights, repair_actions = _apply_counterexample_repair(
                constraints=epoch_constraints,
                weights=epoch_weights,
                bridge_summary=bridge_res,
                colspan_agg=colspan_agg,
            )
            if loss_val < best_loss:
                best_loss = loss_val
                best_ssim = metrics["meanSsim"]
                best_weights = dict(repaired_weights)
                best_constraints = copy.deepcopy(running_constraints)

            ep_record = {
                "epoch": epoch,
                "ssimParityPercent": round(metrics["meanSsim"] * 100.0, 2),
                "boxIouPercent": round(metrics["meanIou"] * 100.0, 2),
                "sourcePageCount": metrics["sourcePageCount"],
                "renderedPageCount": metrics["renderedPageCount"],
                "overlapCount": metrics["overlapCount"],
                "clippedRowCount": metrics["clippedRowCount"],
                "loss": round(loss_val, 3),
                "action": "; ".join(repair_actions) if repair_actions else "Policy gradient update",
            }
            epochs_trace.append(ep_record)
            if on_epoch is not None:
                on_epoch(ep_record)

            if (
                metrics["meanSsim"] >= target_ssim
                and metrics["pageCountDiff"] == 0
                and metrics["overlapCount"] == 0
                and metrics["clippedRowCount"] == 0
                and bool(bridge_res.get("validationValid", False))
            ):
                break

        # Final deterministic compile with best policy & 1:1 page parity enforced
        final_dir = os.path.join(work_dir, "final")
        os.makedirs(final_dir, exist_ok=True)
        final_bridge = compile_and_render_via_bridge(
            pdf_path=pdf_path,
            perception_layout=layout_model,
            weights=best_weights,
            constraints=best_constraints,
            work_dir=final_dir,
            schema_version=schema_version,
            enforce_page_parity=True,
            include_full_result=True,
        )
        with open(final_bridge["fullResultOutPath"], "r", encoding="utf-8") as f:
            full_result = json.load(f)

        # Update replay buffer with best container-strategy pairs from this PDF
        best_strat_map = {
            item["containerKey"]: STRATEGIES.index(item["strategy"])
            for item in best_constraints.get("strategyOverrides", [])
            if item.get("strategy") in STRATEGIES
        }
        for cont in containers:
            s_idx = best_strat_map.get(cont["containerKey"], 0)
            replay_samples.append(
                {
                    "docHash": perception["docHash"],
                    "features": cont["features"],
                    "strategyIndex": s_idx,
                    "bestLoss": best_loss,
                }
            )

        prev_history = _load_json_safe(DEFAULT_HISTORY_PATH, [])
        combined_history = (prev_history + epochs_trace)[-100:]
        save_checkpoint(
            model=model,
            weights=best_weights,
            constraints=best_constraints,
            best_ssim=best_ssim,
            best_loss=best_loss,
            epoch_history=combined_history,
            replay_samples=replay_samples,
            checkpoint_path=checkpoint_path,
        )

        converged = bool(
            best_ssim >= target_ssim
            and final_bridge.get("sourcePageCount") == final_bridge.get("renderedPageCount")
            and int(final_bridge.get("collisionsCount", 1)) == 0
            and int(final_bridge.get("clippedRowsCount", 1)) == 0
        )

        return {
            "mode": "train",
            "converged": converged,
            "targetSsim": target_ssim,
            "bestSsim": round(best_ssim, 5),
            "bestLoss": round(best_loss, 4),
            "epochsRun": len(epochs_trace),
            "epochs": epochs_trace,
            "checkpointPath": checkpoint_path,
            "ocrEngine": perception.get("ocrEngine"),
            "pipelineResult": full_result,
        }
