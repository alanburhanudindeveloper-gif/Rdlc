"""CLI dispatcher for ML Engine (status, perceive, train, infer)."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from typing import Any, Dict

from . import DEFAULT_CHECKPOINT_PATH, DEFAULT_HISTORY_PATH, check_environment


def _emit_ndjson(event_type: str, data: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps({"event": event_type, "data": data}) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description="ReportGen Multi-Modal ML Layout Engine CLI")
    parser.add_argument("--mode", required=True, choices=["status", "perceive", "train", "infer"])
    parser.add_argument("--pdf", help="Input PDF path")
    parser.add_argument("--schema-version", default="2008", choices=["2008", "2016"])
    parser.add_argument("--max-epochs", type=int, default=12)
    parser.add_argument("--target-ssim", type=float, default=0.95)
    parser.add_argument("--checkpoint", default=DEFAULT_CHECKPOINT_PATH)
    parser.add_argument("--stream", action="store_true", help="Emit NDJSON per-epoch progress lines")
    parser.add_argument("--out-json", help="Optional path to write final JSON payload")
    args = parser.parse_args()

    if args.mode == "status":
        env = check_environment()
        history = []
        if os.path.isfile(DEFAULT_HISTORY_PATH):
            try:
                with open(DEFAULT_HISTORY_PATH, "r", encoding="utf-8") as f:
                    history = json.load(f)
            except Exception:
                history = []
        env["historyCount"] = len(history)
        env["recentHistory"] = history[-15:]
        sys.stdout.write(json.dumps(env))
        return 0

    env = check_environment()
    if not env["available"]:
        err_payload = {
            "error": "Missing required Python ML packages.",
            "missingPackages": env["missingPackages"],
            "installCommand": "pip install -r ml_engine/requirements.txt",
        }
        sys.stderr.write(json.dumps(err_payload))
        return 2

    if not args.pdf or not os.path.isfile(args.pdf):
        sys.stderr.write(json.dumps({"error": f"Input PDF not found: {args.pdf}"}))
        return 1

    if args.mode == "perceive":
        from .perception import perceive_pdf

        with tempfile.TemporaryDirectory(prefix="reportgen_ml_perceive_") as work_dir:
            res = perceive_pdf(args.pdf, work_dir=work_dir, dpi=300)
            res.pop("targetPngPaths", None)
            if args.out_json:
                with open(args.out_json, "w", encoding="utf-8") as f:
                    json.dump(res, f)
            sys.stdout.write(json.dumps(res))
        return 0

    def _on_epoch(ep: Dict[str, Any]) -> None:
        if args.stream:
            _emit_ndjson("epoch", ep)

    if args.mode == "train":
        from .trainer import train_on_pdf

        result = train_on_pdf(
            pdf_path=args.pdf,
            max_epochs=args.max_epochs,
            target_ssim=args.target_ssim,
            schema_version=args.schema_version,
            checkpoint_path=args.checkpoint,
            on_epoch=_on_epoch if args.stream else None,
        )
    else:
        from .infer import infer_pdf

        result = infer_pdf(
            pdf_path=args.pdf,
            target_ssim=args.target_ssim,
            schema_version=args.schema_version,
            checkpoint_path=args.checkpoint,
            max_continual_epochs=max(4, min(10, args.max_epochs)),
            on_epoch=_on_epoch if args.stream else None,
        )

    if args.out_json:
        with open(args.out_json, "w", encoding="utf-8") as f:
            json.dump(result, f)

    if args.stream:
        _emit_ndjson("complete", result)
    else:
        sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
