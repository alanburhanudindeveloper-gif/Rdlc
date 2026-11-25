"""Multi-modal PDF perception pipeline:
- 300 DPI ground-truth rendering via PyMuPDF (fitz)
- Native vector text extraction sorted strictly by visual (quantized_y, x0)
- OCR cross-verification via rapidocr_onnxruntime (or paddleocr fallback)
- OpenCV morphological kernel vision geometry detection on text-masked 300 DPI images
- Top-left HeaderLogo 300 DPI PNG crop
- 16-feature geometric signature extraction per XY-Cut container
"""

from __future__ import annotations

import base64
import hashlib
import math
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

PT_PER_INCH = 72.0
LIST_MARKER_RE = re.compile(r"^(?:\d+[.)]|\(\d+\)|[a-zA-Z][.)]|[•\-–—*])$")
FEATURE_NAMES: List[str] = [
    "widthRatio",
    "heightRatio",
    "yTopRatio",
    "internalVLinesNorm",
    "internalHLinesNorm",
    "shadedRowBandsNorm",
    "hasEmbeddedSubGrid",
    "centerGutterScore",
    "indentationLevelsNorm",
    "operatorColumnNorm",
    "textWrapDensity",
    "avgFontSizeNorm",
    "boldRatio",
    "columnDensityDrop",
    "listMarkerRatio",
    "fillBannerPresent",
]


def _rgb_int_to_hex(color_int: int) -> str:
    r = (color_int >> 16) & 0xFF
    g = (color_int >> 8) & 0xFF
    b = color_int & 0xFF
    return f"#{r:02X}{g:02X}{b:02X}"


def _rgb_tuple_to_hex(rgb: Tuple[int, int, int]) -> str:
    r = max(0, min(255, int(rgb[0])))
    g = max(0, min(255, int(rgb[1])))
    b = max(0, min(255, int(rgb[2])))
    return f"#{r:02X}{g:02X}{b:02X}"


def _relative_luminance(rgb: Tuple[int, int, int]) -> float:
    def _lin(c: int) -> float:
        s = c / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    return 0.2126 * _lin(rgb[0]) + 0.7152 * _lin(rgb[1]) + 0.0722 * _lin(rgb[2])


def _box_iou(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> float:
    ix0 = max(a[0], b[0])
    iy0 = max(a[1], b[1])
    ix1 = min(a[2], b[2])
    iy1 = min(a[3], b[3])
    iw = max(0.0, ix1 - ix0)
    ih = max(0.0, iy1 - iy0)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(1e-6, (a[2] - a[0]) * (a[3] - a[1]))
    area_b = max(1e-6, (b[2] - b[0]) * (b[3] - b[1]))
    return inter / max(1e-6, area_a + area_b - inter)


def _merge_baseline_spans(raw_spans: List[Dict[str, Any]], baseline_tol_pt: float = 1.5) -> List[Dict[str, Any]]:
    if not raw_spans:
        return []

    sorted_raw = sorted(
        raw_spans,
        key=lambda s: (round(float(s["y0"]) / baseline_tol_pt) * baseline_tol_pt, float(s["x0"])),
    )

    lines: List[List[Dict[str, Any]]] = []
    for sp in sorted_raw:
        if not lines:
            lines.append([sp])
            continue
        prev_line = lines[-1]
        anchor_y = sum(float(item["y0"]) for item in prev_line) / len(prev_line)
        if abs(float(sp["y0"]) - anchor_y) <= baseline_tol_pt:
            prev_line.append(sp)
        else:
            lines.append([sp])

    merged_spans: List[Dict[str, Any]] = []
    for line in lines:
        line_sorted = sorted(line, key=lambda s: float(s["x0"]))
        current: Optional[Dict[str, Any]] = None
        for sp in line_sorted:
            txt = str(sp["text"])
            if not txt.strip():
                continue
            if current is None:
                current = dict(sp)
                current["runs"] = [
                    {
                        "text": txt,
                        "fontFamily": sp["fontName"],
                        "fontSizePt": sp["fontSize"],
                        "bold": sp["isBold"],
                        "italic": sp["isItalic"],
                        "color": sp["colorHex"],
                    }
                ]
                continue

            gap = float(sp["x0"]) - float(current["x1"])
            ref_fs = max(6.0, float(current["fontSize"]))
            prev_text = str(current["text"]).strip()
            split_for_marker = bool(LIST_MARKER_RE.match(prev_text)) and gap > ref_fs * 0.35
            split_for_wide_gap = gap > ref_fs * 1.8

            if split_for_wide_gap or split_for_marker:
                merged_spans.append(current)
                current = dict(sp)
                current["runs"] = [
                    {
                        "text": txt,
                        "fontFamily": sp["fontName"],
                        "fontSizePt": sp["fontSize"],
                        "bold": sp["isBold"],
                        "italic": sp["isItalic"],
                        "color": sp["colorHex"],
                    }
                ]
            else:
                need_space = gap > ref_fs * 0.18
                if not need_space and prev_text.endswith(")") and txt[:1].isalnum():
                    need_space = True
                sep = " " if (need_space and not str(current["text"]).endswith(" ") and not txt.startswith(" ")) else ""
                current["text"] = f"{current['text']}{sep}{txt}"
                current["x1"] = max(float(current["x1"]), float(sp["x1"]))
                current["y0"] = min(float(current["y0"]), float(sp["y0"]))
                current["y1"] = max(float(current["y1"]), float(sp["y1"]))
                current["isBold"] = bool(current["isBold"] or sp["isBold"])
                current["runs"].append(
                    {
                        "text": f"{sep}{txt}",
                        "fontFamily": sp["fontName"],
                        "fontSizePt": sp["fontSize"],
                        "bold": sp["isBold"],
                        "italic": sp["isItalic"],
                        "color": sp["colorHex"],
                    }
                )
        if current is not None:
            merged_spans.append(current)

    return merged_spans


def _init_ocr_engine() -> Tuple[str, Any]:
    try:
        from rapidocr_onnxruntime import RapidOCR

        return ("rapidocr", RapidOCR())
    except Exception:
        pass
    try:
        from paddleocr import PaddleOCR

        return ("paddleocr", PaddleOCR(use_angle_cls=False, show_log=False))
    except Exception:
        return ("none", None)


def _run_ocr_on_image(ocr_kind: str, ocr_engine: Any, img_bgr: Any, scale_to_pt: float) -> List[Dict[str, Any]]:
    if ocr_engine is None or ocr_kind == "none":
        return []
    boxes: List[Dict[str, Any]] = []
    if ocr_kind == "rapidocr":
        res, _ = ocr_engine(img_bgr)
        if not res:
            return []
        for entry in res:
            quad, text, conf = entry[0], str(entry[1]), float(entry[2])
            xs = [float(p[0]) for p in quad]
            ys = [float(p[1]) for p in quad]
            x0, y0, x1, y1 = min(xs) * scale_to_pt, min(ys) * scale_to_pt, max(xs) * scale_to_pt, max(ys) * scale_to_pt
            boxes.append(
                {
                    "x0": round(x0, 2),
                    "y0": round(y0, 2),
                    "x1": round(x1, 2),
                    "y1": round(y1, 2),
                    "text": text,
                    "confidence": conf,
                }
            )
    elif ocr_kind == "paddleocr":
        res = ocr_engine.ocr(img_bgr, cls=False)
        for page_res in res or []:
            for entry in page_res or []:
                quad = entry[0]
                text, conf = str(entry[1][0]), float(entry[1][1])
                xs = [float(p[0]) for p in quad]
                ys = [float(p[1]) for p in quad]
                boxes.append(
                    {
                        "x0": round(min(xs) * scale_to_pt, 2),
                        "y0": round(min(ys) * scale_to_pt, 2),
                        "x1": round(max(xs) * scale_to_pt, 2),
                        "y1": round(max(ys) * scale_to_pt, 2),
                        "text": text,
                        "confidence": conf,
                    }
                )
    return boxes


def _dedup_primitives(primitives: List[Dict[str, Any]], tol_pt: float = 2.5) -> List[Dict[str, Any]]:
    kept: List[Dict[str, Any]] = []
    for prim in primitives:
        matched = False
        for idx, existing in enumerate(kept):
            if existing["kind"] != prim["kind"]:
                continue
            if (
                abs(existing["xPt"] - prim["xPt"]) <= tol_pt
                and abs(existing["yPt"] - prim["yPt"]) <= tol_pt
                and abs(existing["widthPt"] - prim["widthPt"]) <= tol_pt * 2.0
                and abs(existing["heightPt"] - prim["heightPt"]) <= tol_pt * 2.0
            ):
                if existing["source"] != prim["source"]:
                    existing["source"] = "merged"
                matched = True
                break
        if not matched:
            kept.append(prim)
    return kept


def _extract_cv_primitives(
    img_bgr: Any,
    text_spans: List[Dict[str, Any]],
    page_w_pt: float,
    page_h_pt: float,
    dpi: int,
    page_number: int,
) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    import cv2
    import numpy as np

    px_per_pt = dpi / PT_PER_INCH
    pt_per_px = PT_PER_INCH / dpi
    img_h, img_w = img_bgr.shape[:2]

    # Mask out all vector text glyph bounding boxes (+3px padding)
    masked = img_bgr.copy()
    for sp in text_spans:
        x0 = max(0, int(math.floor(float(sp["x0"]) * px_per_pt)) - 3)
        y0 = max(0, int(math.floor(float(sp["y0"]) * px_per_pt)) - 3)
        x1 = min(img_w - 1, int(math.ceil(float(sp["x1"]) * px_per_pt)) + 3)
        y1 = min(img_h - 1, int(math.ceil(float(sp["y1"]) * px_per_pt)) + 3)
        if x1 > x0 and y1 > y0:
            cv2.rectangle(masked, (x0, y0), (x1, y1), (255, 255, 255), -1)

    gray = cv2.cvtColor(masked, cv2.COLOR_BGR2GRAY)
    # Dark lines/borders mask (foreground = 255)
    _, line_bin = cv2.threshold(gray, 220, 255, cv2.THRESH_BINARY_INV)

    # Morphological horizontal lines
    h_len = max(25, int(dpi * 0.25))
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (h_len, 1))
    h_mask = cv2.morphologyEx(line_bin, cv2.MORPH_OPEN, h_kernel)
    h_mask = cv2.dilate(h_mask, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 2)), iterations=1)

    # Morphological vertical lines
    v_len = max(18, int(dpi * 0.18))
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, v_len))
    v_mask = cv2.morphologyEx(line_bin, cv2.MORPH_OPEN, v_kernel)
    v_mask = cv2.dilate(v_mask, cv2.getStructuringElement(cv2.MORPH_RECT, (2, 3)), iterations=1)

    primitives: List[Dict[str, Any]] = []
    prim_idx = 0

    num_h, _, stats_h, _ = cv2.connectedComponentsWithStats(h_mask)
    for idx in range(1, num_h):
        x, y, w, h, _ = stats_h[idx]
        w_pt = w * pt_per_px
        h_pt = h * pt_per_px
        if w_pt < 18.0 or h_pt > 6.5:
            continue
        prim_idx += 1
        x_pt = x * pt_per_px
        y_pt = y * pt_per_px
        primitives.append(
            {
                "id": f"cv_p{page_number}_h_{prim_idx}",
                "kind": "HLine",
                "xPt": round(x_pt, 2),
                "yPt": round(y_pt, 2),
                "widthPt": round(w_pt, 2),
                "heightPt": round(max(0.75, h_pt), 2),
                "x": round(x_pt / PT_PER_INCH, 4),
                "y": round(y_pt / PT_PER_INCH, 4),
                "width": round(w_pt / PT_PER_INCH, 4),
                "height": round(max(0.75, h_pt) / PT_PER_INCH, 4),
                "colorHex": "#64748B",
                "source": "rle",
            }
        )

    num_v, _, stats_v, _ = cv2.connectedComponentsWithStats(v_mask)
    for idx in range(1, num_v):
        x, y, w, h, _ = stats_v[idx]
        w_pt = w * pt_per_px
        h_pt = h * pt_per_px
        if h_pt < 10.0 or w_pt > 6.5:
            continue
        prim_idx += 1
        x_pt = x * pt_per_px
        y_pt = y * pt_per_px
        primitives.append(
            {
                "id": f"cv_p{page_number}_v_{prim_idx}",
                "kind": "VLine",
                "xPt": round(x_pt, 2),
                "yPt": round(y_pt, 2),
                "widthPt": round(max(0.75, w_pt), 2),
                "heightPt": round(h_pt, 2),
                "x": round(x_pt / PT_PER_INCH, 4),
                "y": round(y_pt / PT_PER_INCH, 4),
                "width": round(max(0.75, w_pt) / PT_PER_INCH, 4),
                "height": round(h_pt / PT_PER_INCH, 4),
                "colorHex": "#64748B",
                "source": "rle",
            }
        )

    # Detect filled banners & shaded row bands (non-white horizontal rectangles on text-masked image)
    non_white = np.any(masked < 246, axis=2).astype(np.uint8) * 255
    # Remove thin stroke lines so solid filled rectangles remain clean
    non_white = cv2.morphologyEx(
        non_white,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (max(12, int(dpi * 0.12)), max(6, int(dpi * 0.08)))),
    )
    num_f, _, stats_f, _ = cv2.connectedComponentsWithStats(non_white)
    for idx in range(1, num_f):
        x, y, w, h, area = stats_f[idx]
        w_pt = w * pt_per_px
        h_pt = h * pt_per_px
        if w_pt < page_w_pt * 0.22 or h_pt < 8.0 or h_pt > 72.0:
            continue
        fill_density = area / float(max(1, w * h))
        if fill_density < 0.55:
            continue
        patch = masked[y : y + h, x : x + w]
        mean_bgr = np.mean(patch.reshape(-1, 3), axis=0)
        rgb = (int(mean_bgr[2]), int(mean_bgr[1]), int(mean_bgr[0]))
        lum = _relative_luminance(rgb)
        if lum >= 0.98:
            continue
        kind = "FillBanner" if (lum < 0.75 and 10.0 <= h_pt <= 54.0) else "RowFillBand"
        prim_idx += 1
        x_pt = x * pt_per_px
        y_pt = y * pt_per_px
        primitives.append(
            {
                "id": f"cv_p{page_number}_f_{prim_idx}",
                "kind": kind,
                "xPt": round(x_pt, 2),
                "yPt": round(y_pt, 2),
                "widthPt": round(w_pt, 2),
                "heightPt": round(h_pt, 2),
                "x": round(x_pt / PT_PER_INCH, 4),
                "y": round(y_pt / PT_PER_INCH, 4),
                "width": round(w_pt / PT_PER_INCH, 4),
                "height": round(h_pt / PT_PER_INCH, 4),
                "colorHex": _rgb_tuple_to_hex(rgb),
                "source": "rle",
            }
        )

    # Top-left HeaderLogo detection on Page 1 (unmasked top margin < 0.14*H, left half < 0.50*W)
    header_logo: Optional[Dict[str, Any]] = None
    if page_number == 1:
        top_limit_px = int(img_h * 0.14)
        left_limit_px = int(img_w * 0.50)
        roi_masked = masked[:top_limit_px, :left_limit_px]
        roi_nonwhite = np.any(roi_masked < 245, axis=2).astype(np.uint8) * 255
        roi_nonwhite = cv2.dilate(
            roi_nonwhite, cv2.getStructuringElement(cv2.MORPH_RECT, (14, 8)), iterations=2
        )
        num_l, _, stats_l, _ = cv2.connectedComponentsWithStats(roi_nonwhite)
        best_logo = None
        best_area = 0
        for idx in range(1, num_l):
            lx, ly, lw, lh, larea = stats_l[idx]
            lw_pt = lw * pt_per_px
            lh_pt = lh * pt_per_px
            if lw_pt < 16.0 or lh_pt < 10.0 or lw_pt > page_w_pt * 0.45:
                continue
            if larea > best_area:
                best_area = larea
                best_logo = (lx, ly, lx + lw, ly + lh)

        if best_logo is not None:
            gx0, gy0, gx1, gy1 = best_logo
            # Expand horizontally to include adjacent top-left wordmark glyphs inside header zone
            gx0_pt = gx0 * pt_per_px
            gy0_pt = gy0 * pt_per_px
            gx1_pt = gx1 * pt_per_px
            gy1_pt = gy1 * pt_per_px
            for sp in text_spans:
                if float(sp["y1"]) <= page_h_pt * 0.12 and float(sp["x0"]) <= page_w_pt * 0.45:
                    if abs(float(sp["y0"]) - gy0_pt) <= 18.0 and float(sp["x0"]) - gx1_pt <= 28.0:
                        gx0_pt = min(gx0_pt, float(sp["x0"]))
                        gy0_pt = min(gy0_pt, float(sp["y0"]))
                        gx1_pt = max(gx1_pt, float(sp["x1"]))
                        gy1_pt = max(gy1_pt, float(sp["y1"]))

            cx0 = max(0, int(math.floor(gx0_pt * px_per_pt)) - 4)
            cy0 = max(0, int(math.floor(gy0_pt * px_per_pt)) - 4)
            cx1 = min(img_w, int(math.ceil(gx1_pt * px_per_pt)) + 4)
            cy1 = min(img_h, int(math.ceil(gy1_pt * px_per_pt)) + 4)
            if cx1 > cx0 + 8 and cy1 > cy0 + 8:
                crop = img_bgr[cy0:cy1, cx0:cx1]
                ok, png_buf = cv2.imencode(".png", crop)
                if ok:
                    header_logo = {
                        "xPt": round(cx0 * pt_per_px, 2),
                        "yPt": round(cy0 * pt_per_px, 2),
                        "widthPt": round((cx1 - cx0) * pt_per_px, 2),
                        "heightPt": round((cy1 - cy0) * pt_per_px, 2),
                        "base64Data": base64.b64encode(png_buf.tobytes()).decode("ascii"),
                    }

    return primitives, header_logo


def _safe_color_to_rgb(color: Any) -> Optional[Tuple[int, int, int]]:
    if color is None:
        return None
    if isinstance(color, (list, tuple)):
        if len(color) == 1:
            v = max(0, min(255, int(round(float(color[0]) * 255))))
            return (v, v, v)
        if len(color) >= 3:
            if len(color) == 4:
                c, m, y, k = [float(x) for x in color[:4]]
                r = 255.0 * (1.0 - c) * (1.0 - k)
                g = 255.0 * (1.0 - m) * (1.0 - k)
                b = 255.0 * (1.0 - y) * (1.0 - k)
                return (int(round(r)), int(round(g)), int(round(b)))
            return (
                max(0, min(255, int(round(float(color[0]) * 255)))),
                max(0, min(255, int(round(float(color[1]) * 255)))),
                max(0, min(255, int(round(float(color[2]) * 255)))),
            )
    return None


def _extract_vector_drawings(page: Any, page_number: int) -> List[Dict[str, Any]]:
    primitives: List[Dict[str, Any]] = []
    idx = 0

    def _emit_line(kind: str, x0: float, y0: float, w: float, h: float, hex_color: str) -> None:
        nonlocal idx
        idx += 1
        primitives.append(
            {
                "id": f"vec_p{page_number}_{'h' if kind == 'HLine' else 'v'}_{idx}",
                "kind": kind,
                "xPt": round(x0, 2),
                "yPt": round(y0, 2),
                "widthPt": round(w, 2),
                "heightPt": round(h, 2),
                "x": round(x0 / PT_PER_INCH, 4),
                "y": round(y0 / PT_PER_INCH, 4),
                "width": round(w / PT_PER_INCH, 4),
                "height": round(h / PT_PER_INCH, 4),
                "colorHex": hex_color,
                "source": "vector",
            }
        )

    for drawing in page.get_drawings():
        rect = drawing.get("rect")
        if rect is None:
            continue
        x0, y0, x1, y1 = float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)
        w = x1 - x0
        h = y1 - y0
        fill_rgb = _safe_color_to_rgb(drawing.get("fill"))
        stroke_rgb = _safe_color_to_rgb(drawing.get("color"))

        if fill_rgb is not None and w >= 24.0 and 8.0 <= h <= 68.0:
            lum = _relative_luminance(fill_rgb)
            if lum < 0.98:
                idx += 1
                kind = "FillBanner" if (lum < 0.75 and h >= 10.0) else "RowFillBand"
                primitives.append(
                    {
                        "id": f"vec_p{page_number}_f_{idx}",
                        "kind": kind,
                        "xPt": round(x0, 2),
                        "yPt": round(y0, 2),
                        "widthPt": round(w, 2),
                        "heightPt": round(h, 2),
                        "x": round(x0 / PT_PER_INCH, 4),
                        "y": round(y0 / PT_PER_INCH, 4),
                        "width": round(w / PT_PER_INCH, 4),
                        "height": round(h / PT_PER_INCH, 4),
                        "colorHex": _rgb_tuple_to_hex(fill_rgb),
                        "source": "vector",
                    }
                )

        if stroke_rgb is not None:
            stroke_hex = _rgb_tuple_to_hex(stroke_rgb)
            stroke_w = max(0.75, min(3.0, float(drawing.get("width") or 0.75)))
            items = drawing.get("items") or []
            emitted_from_items = False

            for item in items:
                op = item[0] if item else None
                if op == "l" and len(item) >= 3:
                    p1, p2 = item[1], item[2]
                    lx0, ly0 = min(float(p1.x), float(p2.x)), min(float(p1.y), float(p2.y))
                    lw, lh = abs(float(p2.x) - float(p1.x)), abs(float(p2.y) - float(p1.y))
                    if lw >= 18.0 and lh <= 2.5:
                        _emit_line("HLine", lx0, ly0, lw, stroke_w, stroke_hex)
                        emitted_from_items = True
                    elif lh >= 10.0 and lw <= 2.5:
                        _emit_line("VLine", lx0, ly0, stroke_w, lh, stroke_hex)
                        emitted_from_items = True
                elif op == "re" and len(item) >= 2:
                    r_box = item[1]
                    rx0, ry0, rx1, ry1 = float(r_box.x0), float(r_box.y0), float(r_box.x1), float(r_box.y1)
                    rw, rh = rx1 - rx0, ry1 - ry0
                    if rw >= 18.0 and rh >= 10.0:
                        _emit_line("HLine", rx0, ry0, rw, stroke_w, stroke_hex)
                        _emit_line("HLine", rx0, ry1, rw, stroke_w, stroke_hex)
                        _emit_line("VLine", rx0, ry0, stroke_w, rh, stroke_hex)
                        _emit_line("VLine", rx1, ry0, stroke_w, rh, stroke_hex)
                        emitted_from_items = True

            if not emitted_from_items:
                if w >= 18.0 and h <= 3.5:
                    _emit_line("HLine", x0, y0, w, max(0.75, h), stroke_hex)
                elif h >= 10.0 and w <= 3.5:
                    _emit_line("VLine", x0, y0, max(0.75, w), h, stroke_hex)
                elif w >= 18.0 and h >= 10.0 and drawing.get("fill") is None:
                    _emit_line("HLine", x0, y0, w, stroke_w, stroke_hex)
                    _emit_line("HLine", x0, y1, w, stroke_w, stroke_hex)
                    _emit_line("VLine", x0, y0, stroke_w, h, stroke_hex)
                    _emit_line("VLine", x1, y0, stroke_w, h, stroke_hex)

    return primitives


def _extract_xy_cut_containers(
    page_number: int,
    page_w_pt: float,
    page_h_pt: float,
    spans: List[Dict[str, Any]],
    primitives: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    body_y0 = page_h_pt * 0.08
    body_y1 = page_h_pt * 0.91
    printable_w = max(100.0, page_w_pt * 0.88)
    printable_h = max(100.0, body_y1 - body_y0)

    # Split Y bounds strictly at full-width FillBanners and full-width HLines
    cut_ys: List[float] = [body_y0, body_y1]
    for p in primitives:
        py0 = float(p["yPt"])
        if py0 < body_y0 or py0 > body_y1:
            continue
        if p["kind"] == "FillBanner" and float(p["widthPt"]) >= printable_w * 0.65:
            cut_ys.append(max(body_y0, py0 - 1.0))
        elif p["kind"] == "HLine" and float(p["widthPt"]) >= printable_w * 0.85:
            cut_ys.append(py0)

    cut_ys = sorted(set(round(y, 1) for y in cut_ys))
    merged_cuts: List[float] = []
    for y in cut_ys:
        if not merged_cuts or y - merged_cuts[-1] >= 18.0:
            merged_cuts.append(y)
        else:
            merged_cuts[-1] = y

    if len(merged_cuts) < 2:
        merged_cuts = [body_y0, body_y1]

    containers: List[Dict[str, Any]] = []
    for idx in range(len(merged_cuts) - 1):
        cy0 = merged_cuts[idx]
        cy1 = merged_cuts[idx + 1]
        c_spans = [
            s for s in spans
            if cy0 - 2.0 <= 0.5 * (float(s["y0"]) + float(s["y1"])) <= cy1 + 2.0
        ]
        c_prims = [
            p for p in primitives
            if cy0 - 2.0 <= float(p["yPt"]) + 0.5 * float(p["heightPt"]) <= cy1 + 2.0
        ]
        if not c_spans and not c_prims:
            continue

        xs = [float(s["x0"]) for s in c_spans] + [float(p["xPt"]) for p in c_prims]
        x1s = [float(s["x1"]) for s in c_spans] + [float(p["xPt"]) + float(p["widthPt"]) for p in c_prims]
        cx0 = min(xs) if xs else page_w_pt * 0.05
        cx1 = max(x1s) if x1s else page_w_pt * 0.95
        cw = max(10.0, cx1 - cx0)
        ch = max(10.0, cy1 - cy0)

        vlines = [p for p in c_prims if p["kind"] == "VLine"]
        hlines = [p for p in c_prims if p["kind"] == "HLine"]
        shaded = [p for p in c_prims if p["kind"] == "RowFillBand"]
        banners = [p for p in c_prims if p["kind"] == "FillBanner"]

        # Embedded subgrid detection: >=3 short VLines spanning only a subset of container height
        short_vlines = [v for v in vlines if float(v["heightPt"]) < ch * 0.72]
        has_subgrid = len(short_vlines) >= 3

        # Center gutter score
        mid_x = cx0 + cw * 0.5
        crossing_spans = [
            s for s in c_spans
            if float(s["x0"]) < mid_x - 3.0 and float(s["x1"]) > mid_x + 3.0
        ]
        center_gutter_score = 1.0 - min(1.0, len(crossing_spans) / float(max(1, len(c_spans))))

        # Indentation clusters
        x0_clusters: List[float] = []
        for s in sorted(c_spans, key=lambda item: float(item["x0"])):
            sx0 = float(s["x0"])
            if not any(abs(sx0 - c) <= 5.0 for c in x0_clusters):
                x0_clusters.append(sx0)

        op_count = sum(
            1 for s in c_spans if str(s["text"]).strip() in (":", "=") or str(s["text"]).strip().startswith(":")
        )
        marker_count = sum(
            1 for s in c_spans if LIST_MARKER_RE.match(str(s["text"]).strip().split(" ")[0] if str(s["text"]).strip() else "")
        )
        avg_fs = (
            sum(float(s["fontSize"]) for s in c_spans) / len(c_spans) if c_spans else 9.0
        )
        bold_count = sum(1 for s in c_spans if s["isBold"])
        long_wrap = sum(
            1 for s in c_spans if float(s["x1"]) - float(s["x0"]) > cw * 0.55 and len(str(s["text"])) > 45
        )
        density_drop = len(vlines) >= 4 and len(c_spans) > 0 and any(
            float(s["x1"]) - float(s["x0"]) >= cw * 0.75 for s in c_spans
        )

        features = [
            min(1.0, cw / printable_w),
            min(1.0, ch / printable_h),
            min(1.0, max(0.0, (cy0 - body_y0) / printable_h)),
            min(1.0, len(vlines) / 8.0),
            min(1.0, len(hlines) / 20.0),
            min(1.0, len(shaded) / 15.0),
            1.0 if has_subgrid else 0.0,
            round(center_gutter_score, 4),
            min(1.0, len(x0_clusters) / 5.0),
            min(1.0, op_count / 4.0),
            min(1.0, long_wrap / float(max(1, len(c_spans)))),
            min(1.0, max(0.2, avg_fs / 18.0)),
            min(1.0, bold_count / float(max(1, len(c_spans)))),
            1.0 if density_drop else 0.0,
            min(1.0, marker_count / float(max(1, len(c_spans)))),
            1.0 if len(banners) > 0 else 0.0,
        ]

        geometric_signature = {
            "internalVLineCount": len(vlines),
            "shadedRowBandCount": len(shaded),
            "hasEmbeddedSubGrid": bool(has_subgrid),
            "indentationLevels": len(x0_clusters),
            "operatorColumnCount": op_count,
            "columnDensityDrop": bool(density_drop),
        }

        containers.append(
            {
                "containerKey": f"p{page_number}_c{len(containers) + 1}",
                "pageNumber": page_number,
                "x0Pt": round(cx0, 2),
                "y0Pt": round(cy0, 2),
                "x1Pt": round(cx1, 2),
                "y1Pt": round(cy1, 2),
                "features": [round(float(v), 5) for v in features],
                "featureNames": FEATURE_NAMES,
                "geometricSignature": geometric_signature,
                "spanCount": len(c_spans),
                "vLineCount": len(vlines),
                "hLineCount": len(hlines),
            }
        )

    return containers


def _cross_validate_with_ocr(
    ocr_kind: str,
    ocr_engine: Any,
    img_bgr: Any,
    pt_per_px: float,
    raw_spans: List[Dict[str, Any]],
    word_boxes: List[Dict[str, Any]],
    page_w_pt: float,
    page_h_pt: float,
) -> Dict[str, Any]:
    """Cross-validate native PyMuPDF vector spans against RapidOCR/PaddleOCR detections.
    - On raster-only pages (0 vector spans), promotes all OCR boxes into spans + word boxes.
    - On digital pages, computes OCR spatial agreement and recovers uncovered high-confidence raster text.
    """
    if ocr_engine is None or ocr_kind == "none":
        return {
            "ocrRan": False,
            "ocrEngine": ocr_kind,
            "ocrBoxCount": 0,
            "vectorAgreementRatio": 1.0 if raw_spans else 0.0,
            "recoveredRasterSpans": 0,
            "extractionMode": "digital-vector" if raw_spans else "raster-fallback",
        }

    ocr_boxes = _run_ocr_on_image(ocr_kind, ocr_engine, img_bgr, pt_per_px)
    vector_present = len(raw_spans) > 0
    matched_ocr = 0
    recovered = 0

    for ob in ocr_boxes:
        ob_box = (float(ob["x0"]), float(ob["y0"]), float(ob["x1"]), float(ob["y1"]))
        ob_cx = 0.5 * (ob_box[0] + ob_box[2])
        ob_cy = 0.5 * (ob_box[1] + ob_box[3])
        is_covered = False
        for sp in raw_spans:
            sp_box = (float(sp["x0"]), float(sp["y0"]), float(sp["x1"]), float(sp["y1"]))
            if _box_iou(ob_box, sp_box) >= 0.08 or (
                sp_box[0] - 2.0 <= ob_cx <= sp_box[2] + 2.0
                and sp_box[1] - 2.0 <= ob_cy <= sp_box[3] + 2.0
            ):
                is_covered = True
                break
        if is_covered:
            matched_ocr += 1
            continue

        # Recover text if page is raster-only OR OCR detected high-confidence text outside top-left logo box
        in_top_left_logo = ob_box[1] <= page_h_pt * 0.14 and ob_box[2] <= page_w_pt * 0.45
        if not vector_present or (float(ob.get("confidence", 0.0)) >= 0.80 and not in_top_left_logo):
            raw_spans.append(
                {
                    "x0": ob["x0"],
                    "y0": ob["y0"],
                    "x1": ob["x1"],
                    "y1": ob["y1"],
                    "text": ob["text"],
                    "fontSize": max(7.0, (ob["y1"] - ob["y0"]) * 0.78),
                    "fontName": "Arial",
                    "isBold": False,
                    "isItalic": False,
                    "colorHex": "#0F172A",
                }
            )
            word_boxes.append(
                {
                    "x0": ob["x0"],
                    "y0": ob["y0"],
                    "x1": ob["x1"],
                    "y1": ob["y1"],
                    "text": ob["text"],
                }
            )
            recovered += 1

    agreement = round(matched_ocr / float(max(1, len(ocr_boxes))), 4) if vector_present and ocr_boxes else (0.0 if not vector_present else 1.0)
    return {
        "ocrRan": True,
        "ocrEngine": ocr_kind,
        "ocrBoxCount": len(ocr_boxes),
        "vectorAgreementRatio": agreement,
        "recoveredRasterSpans": recovered,
        "extractionMode": "digital-vector" if vector_present else "raster-fallback",
    }


def perceive_pdf(pdf_path: str, work_dir: str, dpi: int = 300) -> Dict[str, Any]:
    import cv2
    import fitz
    import numpy as np

    os.makedirs(work_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    doc_name = os.path.splitext(os.path.basename(pdf_path))[0]
    ocr_kind, ocr_engine = _init_ocr_engine()

    pages_payload: List[Dict[str, Any]] = []
    all_containers: List[Dict[str, Any]] = []
    target_png_paths: List[str] = []
    word_boxes_by_page: List[List[Dict[str, Any]]] = []
    ocr_validation_pages: List[Dict[str, Any]] = []

    zoom = dpi / PT_PER_INCH
    mat = fitz.Matrix(zoom, zoom)
    pt_per_px = PT_PER_INCH / dpi

    page_width_in = 8.27
    page_height_in = 11.69
    any_digital_vector = False

    for p_idx in range(len(doc)):
        page = doc[p_idx]
        page_number = p_idx + 1
        rect = page.rect
        page_w_pt = float(rect.width)
        page_h_pt = float(rect.height)
        if p_idx == 0:
            page_width_in = round(page_w_pt / PT_PER_INCH, 4)
            page_height_in = round(page_h_pt / PT_PER_INCH, 4)

        # Render 300 DPI ground-truth PNG
        pix = page.get_pixmap(matrix=mat, alpha=False)
        png_bytes = pix.tobytes("png")
        target_png_path = os.path.join(work_dir, f"target_page_{page_number}.png")
        with open(target_png_path, "wb") as f:
            f.write(png_bytes)
        target_png_paths.append(target_png_path)

        # Decode into OpenCV BGR array
        arr = np.frombuffer(png_bytes, dtype=np.uint8)
        img_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)

        # Extract native vector text spans
        raw_spans: List[Dict[str, Any]] = []
        text_dict = page.get_text("dict")
        for block in text_dict.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for sp in line.get("spans", []):
                    txt = str(sp.get("text", ""))
                    if not txt.strip():
                        continue
                    bbox = sp.get("bbox", [0, 0, 0, 0])
                    font_name = str(sp.get("font", "Arial"))
                    flags = int(sp.get("flags", 0))
                    is_bold = bool(flags & 16) or ("bold" in font_name.lower()) or ("black" in font_name.lower())
                    is_italic = bool(flags & 2) or ("italic" in font_name.lower()) or ("oblique" in font_name.lower())
                    raw_spans.append(
                        {
                            "x0": float(bbox[0]),
                            "y0": float(bbox[1]),
                            "x1": float(bbox[2]),
                            "y1": float(bbox[3]),
                            "text": txt,
                            "fontSize": max(6.0, float(sp.get("size", 9.0))),
                            "fontName": re.sub(r"^[A-Z]{6}\+", "", font_name).split("-")[0] or "Arial",
                            "isBold": is_bold,
                            "isItalic": is_italic,
                            "colorHex": _rgb_int_to_hex(int(sp.get("color", 0))),
                        }
                    )

        if raw_spans:
            any_digital_vector = True

        # Extract native word boxes for IoU evaluation
        words_raw = page.get_text("words") or []
        word_boxes: List[Dict[str, Any]] = [
            {
                "x0": round(float(w[0]), 2),
                "y0": round(float(w[1]), 2),
                "x1": round(float(w[2]), 2),
                "y1": round(float(w[3]), 2),
                "text": str(w[4]),
            }
            for w in words_raw
            if str(w[4]).strip()
        ]

        # RapidOCR cross-validation (verifies vector coverage + recovers any rasterized text)
        ocr_stats = _cross_validate_with_ocr(
            ocr_kind=ocr_kind,
            ocr_engine=ocr_engine,
            img_bgr=img_bgr,
            pt_per_px=pt_per_px,
            raw_spans=raw_spans,
            word_boxes=word_boxes,
            page_w_pt=page_w_pt,
            page_h_pt=page_h_pt,
        )
        ocr_validation_pages.append({"pageNumber": page_number, **ocr_stats})

        merged_spans = _merge_baseline_spans(raw_spans, baseline_tol_pt=1.5)
        word_boxes_by_page.append(word_boxes)

        # Combine OpenCV morphological geometry + PyMuPDF vector drawings
        cv_prims, header_logo = _extract_cv_primitives(
            img_bgr=img_bgr,
            text_spans=merged_spans,
            page_w_pt=page_w_pt,
            page_h_pt=page_h_pt,
            dpi=dpi,
            page_number=page_number,
        )
        vec_prims = _extract_vector_drawings(page, page_number)
        vector_primitives = _dedup_primitives(vec_prims + cv_prims, tol_pt=2.5)

        # Strip tiny glyph debris inside HeaderLogo bounding box
        if header_logo is not None:
            lx0 = header_logo["xPt"] - 2.0
            ly0 = header_logo["yPt"] - 2.0
            lx1 = header_logo["xPt"] + header_logo["widthPt"] + 2.0
            ly1 = header_logo["yPt"] + header_logo["heightPt"] + 2.0
            merged_spans = [
                sp
                for sp in merged_spans
                if not (
                    float(sp["x0"]) >= lx0
                    and float(sp["y0"]) >= ly0
                    and float(sp["x1"]) <= lx1
                    and float(sp["y1"]) <= ly1
                    and len(str(sp["text"]).strip()) <= 3
                )
            ]

        containers = _extract_xy_cut_containers(
            page_number=page_number,
            page_w_pt=page_w_pt,
            page_h_pt=page_h_pt,
            spans=merged_spans,
            primitives=vector_primitives,
        )
        all_containers.extend(containers)

        # Convert spans + primitives + HeaderLogo into TypeScript IntermediateLayoutModel LayoutRegion[]
        regions: List[Dict[str, Any]] = []
        reg_idx = 0

        if header_logo is not None:
            reg_idx += 1
            regions.append(
                {
                    "id": f"ml_p{page_number}_logo_{reg_idx}",
                    "pageNumber": page_number,
                    "type": "image",
                    "x": round(header_logo["xPt"] / PT_PER_INCH, 4),
                    "y": round(header_logo["yPt"] / PT_PER_INCH, 4),
                    "width": round(header_logo["widthPt"] / PT_PER_INCH, 4),
                    "height": round(header_logo["heightPt"] / PT_PER_INCH, 4),
                    "semanticRole": "logoOrGraphic",
                    "confidence": 0.98,
                    "bandKind": "Header",
                    "isAmbiguous": False,
                    "imageAssetBase64": header_logo["base64Data"],
                    "imageAssetName": "HeaderLogo",
                    "sourceObjectRefs": [f"ml:p{page_number}:logo"],
                    "style": {
                        "fontFamily": "Arial",
                        "fontSizePt": 9.0,
                        "bold": False,
                        "italic": False,
                        "color": "#0F172A",
                        "textAlign": "Left",
                        "verticalAlign": "Top",
                        "paddingPt": {"top": 0, "right": 0, "bottom": 0, "left": 0},
                    },
                }
            )

        for p in vector_primitives:
            reg_idx += 1
            is_line = p["kind"] in ("HLine", "VLine")
            regions.append(
                {
                    "id": f"ml_p{page_number}_prim_{reg_idx}",
                    "pageNumber": page_number,
                    "type": "vector_line" if is_line else "vector_rect",
                    "x": p["x"],
                    "y": p["y"],
                    "width": p["width"],
                    "height": p["height"],
                    "semanticRole": "unknown",
                    "confidence": 0.95,
                    "bandKind": "Header"
                    if float(p["yPt"]) < page_h_pt * 0.12
                    else ("Footer" if float(p["yPt"]) > page_h_pt * 0.90 else "Detail"),
                    "isAmbiguous": False,
                    "sourceObjectRefs": [p["id"]],
                    "style": {
                        "fontFamily": "Arial",
                        "fontSizePt": 8.0,
                        "bold": False,
                        "italic": False,
                        "color": p.get("colorHex", "#64748B"),
                        "backgroundColor": None if is_line else p.get("colorHex", "#E2E8F0"),
                        "borderColor": p.get("colorHex", "#64748B") if is_line else None,
                        "borderWidthPt": 0.75 if is_line else 0,
                        "textAlign": "Left",
                        "verticalAlign": "Top",
                        "paddingPt": {"top": 0, "right": 0, "bottom": 0, "left": 0},
                    },
                }
            )

        for sp in merged_spans:
            reg_idx += 1
            x0_pt, y0_pt, x1_pt, y1_pt = float(sp["x0"]), float(sp["y0"]), float(sp["x1"]), float(sp["y1"])
            band_kind = (
                "Header"
                if y0_pt < page_h_pt * 0.12
                else ("Footer" if y0_pt > page_h_pt * 0.90 else "Detail")
            )
            sem_role = (
                "headerText"
                if band_kind == "Header"
                else ("footerText" if band_kind == "Footer" else ("sectionHeading" if sp["isBold"] else "paragraph"))
            )
            regions.append(
                {
                    "id": f"ml_p{page_number}_txt_{reg_idx}",
                    "pageNumber": page_number,
                    "type": "text",
                    "x": round(x0_pt / PT_PER_INCH, 4),
                    "y": round(y0_pt / PT_PER_INCH, 4),
                    "width": round(max(4.0, x1_pt - x0_pt) / PT_PER_INCH, 4),
                    "height": round(max(6.0, y1_pt - y0_pt) / PT_PER_INCH, 4),
                    "text": sp["text"],
                    "runs": sp["runs"],
                    "semanticRole": sem_role,
                    "confidence": 0.99,
                    "bandKind": band_kind,
                    "isAmbiguous": False,
                    "sourceObjectRefs": [f"ml:p{page_number}:t{reg_idx}"],
                    "style": {
                        "fontFamily": sp["fontName"],
                        "fontSizePt": round(float(sp["fontSize"]), 2),
                        "bold": bool(sp["isBold"]),
                        "italic": bool(sp["isItalic"]),
                        "color": sp["colorHex"],
                        "textAlign": "Left",
                        "verticalAlign": "Top",
                        "paddingPt": {"top": 1, "right": 1, "bottom": 1, "left": 1},
                    },
                }
            )

        # Downscaled preview base64 (~120 DPI) for Studio display while keeping 300 DPI PNG on disk for SSIM
        preview_scale = 120.0 / float(dpi)
        preview_img = cv2.resize(
            img_bgr,
            (max(100, int(img_bgr.shape[1] * preview_scale)), max(100, int(img_bgr.shape[0] * preview_scale))),
            interpolation=cv2.INTER_AREA,
        )
        ok_prev, prev_buf = cv2.imencode(".png", preview_img)
        preview_b64 = base64.b64encode(prev_buf.tobytes()).decode("ascii") if ok_prev else ""

        pages_payload.append(
            {
                "pageNumber": page_number,
                "width": round(page_w_pt / PT_PER_INCH, 4),
                "height": round(page_h_pt / PT_PER_INCH, 4),
                "rawObjectCount": len(merged_spans) + len(vector_primitives),
                "regions": regions,
                "bands": [],
                "vectorPrimitives": vector_primitives,
                "geometricContainers": containers,
                "rasterPreviewBase64": preview_b64,
            }
        )

    with open(pdf_path, "rb") as pdf_fp:
        doc_hash = hashlib.sha256(pdf_fp.read()).hexdigest()[:16]

    layout_model = {
        "document": {
            "name": doc_name,
            "pageCount": len(doc),
            "pageWidth": page_width_in,
            "pageHeight": page_height_in,
            "unit": "inch",
            "extractedAt": datetime.now(timezone.utc).isoformat(),
            "extractionMode": "digital-vector" if any_digital_vector else "raster-fallback",
        },
        "pages": pages_payload,
    }

    return {
        "docHash": doc_hash,
        "documentName": doc_name,
        "pageCount": len(doc),
        "layoutModel": layout_model,
        "containers": all_containers,
        "targetPngPaths": target_png_paths,
        "wordBoxesByPage": word_boxes_by_page,
        "ocrEngine": ocr_kind,
        "ocrCrossValidation": ocr_validation_pages,
    }


if __name__ == "__main__":
    import argparse
    import json
    import tempfile

    parser = argparse.ArgumentParser(description="Multi-modal PDF perception (PyMuPDF + OpenCV + RapidOCR)")
    parser.add_argument("pdf", help="Path to input PDF")
    parser.add_argument("--work-dir", help="Optional output working directory for 300 DPI PNGs")
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--out-json", help="Optional path to write JSON output")
    args = parser.parse_args()

    if args.work_dir:
        out = perceive_pdf(args.pdf, work_dir=args.work_dir, dpi=args.dpi)
    else:
        with tempfile.TemporaryDirectory(prefix="reportgen_perceive_") as tmp_dir:
            out = perceive_pdf(args.pdf, work_dir=tmp_dir, dpi=args.dpi)

    if args.out_json:
        with open(args.out_json, "w", encoding="utf-8") as fp:
            json.dump(out, fp)
    print(json.dumps(out))

