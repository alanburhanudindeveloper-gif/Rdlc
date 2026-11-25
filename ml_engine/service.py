"""Optional FastAPI microservice wrapper for ml_engine."""

from __future__ import annotations

import os
import tempfile
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from . import DEFAULT_CHECKPOINT_PATH, check_environment

app = FastAPI(title="ReportGen ML Layout Engine", version="1.0.0")


@app.get("/health")
def health() -> dict:
    return {"ok": True, **check_environment()}


@app.post("/perceive")
async def api_perceive(pdf: UploadFile = File(...)) -> dict:
    env = check_environment()
    if not env["available"]:
        raise HTTPException(status_code=422, detail=env)
    from .perception import perceive_pdf

    data = await pdf.read()
    with tempfile.TemporaryDirectory(prefix="reportgen_api_perceive_") as work_dir:
        pdf_path = os.path.join(work_dir, pdf.filename or "input.pdf")
        with open(pdf_path, "wb") as f:
            f.write(data)
        res = perceive_pdf(pdf_path, work_dir=work_dir, dpi=300)
        res.pop("targetPngPaths", None)
        return res


@app.post("/train")
async def api_train(
    pdf: UploadFile = File(...),
    schema_version: str = Form("2008"),
    max_epochs: int = Form(12),
    target_ssim: float = Form(0.95),
) -> dict:
    env = check_environment()
    if not env["available"]:
        raise HTTPException(status_code=422, detail=env)
    from .trainer import train_on_pdf

    data = await pdf.read()
    with tempfile.TemporaryDirectory(prefix="reportgen_api_train_") as work_dir:
        pdf_path = os.path.join(work_dir, pdf.filename or "input.pdf")
        with open(pdf_path, "wb") as f:
            f.write(data)
        return train_on_pdf(
            pdf_path=pdf_path,
            max_epochs=max_epochs,
            target_ssim=target_ssim,
            schema_version=schema_version,
            checkpoint_path=DEFAULT_CHECKPOINT_PATH,
        )


@app.post("/infer")
async def api_infer(
    pdf: UploadFile = File(...),
    schema_version: str = Form("2008"),
    target_ssim: float = Form(0.95),
) -> dict:
    env = check_environment()
    if not env["available"]:
        raise HTTPException(status_code=422, detail=env)
    from .infer import infer_pdf

    data = await pdf.read()
    with tempfile.TemporaryDirectory(prefix="reportgen_api_infer_") as work_dir:
        pdf_path = os.path.join(work_dir, pdf.filename or "input.pdf")
        with open(pdf_path, "wb") as f:
            f.write(data)
        return infer_pdf(
            pdf_path=pdf_path,
            target_ssim=target_ssim,
            schema_version=schema_version,
            checkpoint_path=DEFAULT_CHECKPOINT_PATH,
        )
