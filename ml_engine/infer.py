"""Inference & Continual Learning Engine on New PDFs."""

from __future__ import annotations

import copy
import json
import os
import tempfile
from typing import Any, Callable, Dict, List, Optional

import torch

from . import DEFAULT_CHECKPOINT_PATH, DEFAULT_REPLAY_PATH
from .perception import perceive_pdf
from .trainer import (
    FEATURE_DIM,
    STRATEGIES,
    _load_json_safe,
    _rasterize_rendered_pdf_and_words,
    compile_and_render_via_bridge,
    decode_continuous_params,
    evaluate_epoch_loss,
    load_policy_checkpoint,
    train_on_pdf,
)


def infer_pdf(
    pdf_path: str,
    target_ssim: float = 0.95,
    schema_version: str = "2008",
    checkpoint_path: str = DEFAULT_CHECKPOINT_PATH,
    max_continual_epochs: int = 8,
    on_epoch: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="reportgen_ml_infer_") as work_dir:
        perception = perceive_pdf(pdf_path=pdf_path, work_dir=work_dir, dpi=300)
        containers = perception["containers"]
        target_pngs = perception["targetPngPaths"]
        target_words = perception["wordBoxesByPage"]
        layout_model = perception["layoutModel"]

        model, ckpt_meta = load_policy_checkpoint(checkpoint_path)
        model.eval()

        feat_tensor = (
            torch.tensor([c["features"] for c in containers], dtype=torch.float32)
            if containers
            else torch.zeros((1, FEATURE_DIM), dtype=torch.float32)
        )

        with torch.no_grad():
            logits, params_unit = model(feat_tensor)
            best_indices = torch.argmax(logits, dim=-1)
            mean_params = params_unit.mean(dim=0)

        weights, _ = decode_continuous_params(mean_params.tolist(), ckpt_meta.get("weights"))
        constraints = copy.deepcopy(ckpt_meta.get("constraints", {}))
        constraints["strategyOverrides"] = [
            {
                "containerKey": containers[i]["containerKey"],
                "pageNumber": int(containers[i]["pageNumber"]),
                "strategy": STRATEGIES[int(best_indices[i].item())],
                "xRangePt": [containers[i]["x0Pt"], containers[i]["x1Pt"]],
                "yRangePt": [containers[i]["y0Pt"], containers[i]["y1Pt"]],
                "reason": "ML checkpoint inference",
            }
            for i in range(len(containers))
        ]

        inf_dir = os.path.join(work_dir, "infer_pass")
        os.makedirs(inf_dir, exist_ok=True)
        bridge_res = compile_and_render_via_bridge(
            pdf_path=pdf_path,
            perception_layout=layout_model,
            weights=weights,
            constraints=constraints,
            work_dir=inf_dir,
            schema_version=schema_version,
            enforce_page_parity=True,
            include_full_result=True,
        )
        rendered_pngs, rendered_words = _rasterize_rendered_pdf_and_words(
            bridge_res["renderedPdfOutPath"], inf_dir, dpi=300
        )
        metrics = evaluate_epoch_loss(
            target_png_paths=target_pngs,
            rendered_png_paths=rendered_pngs,
            target_words_by_page=target_words,
            rendered_words_by_page=rendered_words,
            bridge_summary=bridge_res,
        )

        infer_record = {
            "epoch": 0,
            "ssimParityPercent": round(metrics["meanSsim"] * 100.0, 2),
            "boxIouPercent": round(metrics["meanIou"] * 100.0, 2),
            "sourcePageCount": metrics["sourcePageCount"],
            "renderedPageCount": metrics["renderedPageCount"],
            "overlapCount": metrics["overlapCount"],
            "clippedRowCount": metrics["clippedRowCount"],
            "loss": round(metrics["totalLoss"], 3),
            "action": "Single-pass checkpoint inference",
        }
        if on_epoch is not None:
            on_epoch(infer_record)

        passes_zero_shot = (
            metrics["meanSsim"] >= target_ssim
            and metrics["pageCountDiff"] == 0
            and metrics["overlapCount"] == 0
            and metrics["clippedRowCount"] == 0
            and bool(bridge_res.get("validationValid", False))
        )

        if passes_zero_shot:
            with open(bridge_res["fullResultOutPath"], "r", encoding="utf-8") as f:
                full_result = json.load(f)
            return {
                "mode": "infer-zero-shot",
                "converged": True,
                "continualAdapted": False,
                "checkpointLoaded": bool(ckpt_meta.get("loaded", False)),
                "targetSsim": target_ssim,
                "bestSsim": metrics["meanSsim"],
                "bestLoss": metrics["totalLoss"],
                "epochsRun": 1,
                "epochs": [infer_record],
                "checkpointPath": checkpoint_path,
                "ocrEngine": perception.get("ocrEngine"),
                "pipelineResult": full_result,
            }

        # Continual Fine-Tuning minimizing joint loss over PDF B + replay buffer from prior PDFs
        replay_samples = _load_json_safe(DEFAULT_REPLAY_PATH, [])
        adapted = train_on_pdf(
            pdf_path=pdf_path,
            max_epochs=max_continual_epochs,
            target_ssim=target_ssim,
            schema_version=schema_version,
            checkpoint_path=checkpoint_path,
            on_epoch=on_epoch,
            replay_samples=replay_samples,
        )
        adapted["mode"] = "infer-continual-adapted"
        adapted["continualAdapted"] = True
        adapted["checkpointLoaded"] = bool(ckpt_meta.get("loaded", False))
        adapted["epochs"] = [infer_record] + list(adapted.get("epochs", []))
        return adapted
