"""Multi-modal ML perception and closed-loop target-guided RDLC 2008 layout policy engine."""

from __future__ import annotations

import importlib.util
import os
from typing import Any, Dict, List

REQUIRED_PACKAGES: List[str] = [
    "torch",
    "fitz",
    "cv2",
    "skimage",
    "rapidocr_onnxruntime",
    "numpy",
]

OPTIONAL_PACKAGES: List[str] = [
    "paddleocr",
    "fastapi",
    "uvicorn",
]

DEFAULT_CHECKPOINT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "checkpoints")
DEFAULT_CHECKPOINT_PATH = os.path.join(DEFAULT_CHECKPOINT_DIR, "layout_policy.pt")
DEFAULT_HISTORY_PATH = os.path.join(DEFAULT_CHECKPOINT_DIR, "policy_history.json")
DEFAULT_REPLAY_PATH = os.path.join(DEFAULT_CHECKPOINT_DIR, "replay_buffer.json")


def check_environment() -> Dict[str, Any]:
    installed: Dict[str, bool] = {}
    for pkg in REQUIRED_PACKAGES + OPTIONAL_PACKAGES:
        installed[pkg] = importlib.util.find_spec(pkg) is not None
    missing_required = [pkg for pkg in REQUIRED_PACKAGES if not installed.get(pkg, False)]
    ocr_available = installed.get("rapidocr_onnxruntime", False) or installed.get("paddleocr", False)
    if installed.get("rapidocr_onnxruntime", False) is False and ocr_available:
        missing_required = [pkg for pkg in missing_required if pkg != "rapidocr_onnxruntime"]
    os.makedirs(DEFAULT_CHECKPOINT_DIR, exist_ok=True)
    return {
        "available": len(missing_required) == 0,
        "installedPackages": installed,
        "missingPackages": missing_required,
        "checkpointPath": DEFAULT_CHECKPOINT_PATH,
        "checkpointExists": os.path.isfile(DEFAULT_CHECKPOINT_PATH),
        "historyPath": DEFAULT_HISTORY_PATH,
        "replayBufferPath": DEFAULT_REPLAY_PATH,
    }
