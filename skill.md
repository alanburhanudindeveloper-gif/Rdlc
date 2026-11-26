# Deterministic PDF-to-RDLC 2008 Compiler Rules (v3.2)

This file is the canonical rulebook for the polyglot PDF-to-RDLC 2008 compiler across:
- **Perception (`extractor-py/`, `ml_engine/`)**: PyMuPDF vector span extraction sorted visually by `(quantized_y, x0)` + `HLine`, `VLine`, `FillBanner`, `RowFillBand`, and 300 DPI header logos (`layout_ir.json`).
- **C# Compiler (`compiler-dotnet/RdlcBuilder.cs`)**: .NET 8 RDLC 2008 builder, geometric solver router, XSD structural validator, and page-height calibrator.
- **TypeScript Fallback & Studio Engine (`src/engine/rdlc/`)**: Sandbox Tablix compiler (`flat2008TablixCompiler.ts`), RDLC 2008 serializer (`rdlcGenerator.ts`), validator (`rdlcValidator.ts`), and preview/diff renderer (`rdlcPreviewRenderer.ts`).

---

## 1. Non-Negotiable System Invariants

1. **Zero Hardcoding Mandate:**
   NEVER hardcode any document text literals, product names, insurer/company names, section titles, language-specific keywords, hex color constants, fixed page numbers, or fixed crop coordinates. Every structural boundary, solver choice, and border style MUST derive strictly from pure geometric primitives (`x0, y0, x1, y1`, `HLine`, `VLine`, `FillBanner`, `RowFillBand`), color luminance, font metrics (`fontSize`, `isBold`, `isItalic`), and generic syntax tokens (`:` / `=`, `1.`, `a.`, `i.`).
2. **Zero OCR on Digital PDFs & Visual `(Y, X)` Sorting:**
   When native vector characters exist, do NOT run OCR as the primary text source. Sort all spans strictly by quantized visual baseline `floor(y0 / 1.5) * 1.5` (ascending) then `x0` (ascending) before line reconstruction.
3. **Strict RDLC 2008 XSD Compliance:**
   - Root namespace: `http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition`.
   - Required top-level structure: `<DataSources>` (`DummyDataSource`), `<DataSets>` (`dsReport`), `<Body>`, `<Width>`, `<Page>`, and optional `<EmbeddedImages>`.
   - Forbidden RDLC 2008 elements: `<RowSpan>`, `<Visibility>`, `<ReportSections>`, `<ReportSection>`, `<ReportParameters>`, `<ReportParametersLayout>`, `<AutoRefresh>`, `<LeftIndent>`.
   - `<CanGrow>true</CanGrow>` and `<CanShrink>false</CanShrink>` required on all `<Textbox>` cells.
   - `TablixColumns.Count == TablixColumnHierarchy.TablixMembers.Count` and `TablixRows.Count == TablixRowHierarchy.TablixMembers.Count`.
   - In every row, `sum(ColSpan) == N_columns`, and XML `<TablixCells>` emits `ColSpan - 1` empty `<TablixCell />` placeholders immediately after each spanned cell.
4. **1:1 Page Parity (`renderedPageCount == sourcePageCount`):**
   Every source page must fit within `H_printable = H_page - M_top - M_bottom - H_header - H_footer` without spillover.

---

## 2. Rule Reference Index (v3.2)

- **`[R-PB]` (Single Top-Most Page Break):**
  Emit `<PageBreak><BreakLocation>Start</BreakLocation></PageBreak>` ONLY on the single top-most (`min(Top)`) outer `<Tablix>` when `sourcePageIndex > 0`. NEVER emit `<PageBreak>` inside a nested `<Tablix>`, on a `TablixMember` inside a nested `<Tablix>`, or on a companion `RightTrack` `<Tablix>`.
- **`[R-PARENT-NESTED]` (Outer 2-Col Banner + Nested Dual Tablixes):**
  When a single full-width dark `FillBanner` (`luminance < 0.72`, `width >= 0.85 * printableWidth`) sits directly above dual side-by-side Key–Value groups or twin sub-grids (separated by `>= 6pt` vertical gutter with no crossing elements): emit **1 outer 2-column `<Tablix>`** (`R0` = Banner with `ColSpan=2`; `R1` = Left nested `<Tablix>` in Col 0, Right nested `<Tablix>` in Col 1). Zero `<RowSpan>`. Nested `<Tablix>` omits `<Top>`, `<Left>`, `<ZIndex>`, and `<PageBreak>`. Keep flowing multi-line paragraphs intact in a single cell.
- **`[R-DUAL-TRACK]` (Independent Dual-Track Streams):**
  Side-by-side parent headers or twin bordered sub-grids separated by `>= 6pt` vertical gutter (without a shared `[R-PARENT-NESTED]` parent banner) compile into separate Left and Right `<Tablix>` streams with independent `Top` cursors. Never merge items across the vertical gutter into the same `<TablixRow>`.
- **`[R-COLON-GRID]` (Operator Column Alignment):**
  Cluster `:` and `=` X positions within `|Δx0| <= 2.5pt`. Create narrow operator columns (`~8–10pt`) and span single-operator or unsplit header/prose rows across empty trailing columns via `ColSpan` + `RemoveAt` on absorbed cell objects.
- **`[R-STAIRCASE]` (Zero-LeftIndent Staircase Hierarchy):**
  Cluster ascending marker and body `x0` positions within `|Δx0| <= 3.0pt` (`[X_0, X_1, ..., X_k]`) into `k` narrow indent columns + `1` body column (`totalCols = k + 1`). Never use `<LeftIndent>`. Span body and full-width rows using exact `ColSpan` (`totalCols - startCol`) + `RemoveAt`.
- **`[R-ROW-PHYS]` (Mandatory Physical Row Cuts):**
  Cut a `<TablixRow>` boundary at every `FillBanner`, `HLine`, and `RowFillBand` (deduplicated within `<= 2.0pt`).
- **`[R-ROW-BOLD-MERGE]` (Bold Split & Regular Prose Merge):**
  Bold heading lines get their own `<TablixRow>` above Regular body prose. Consecutive Regular lines sharing the same column and `x0` (`|Δx0| <= 4.0pt`, `Δy <= 1.65 * fontSize`) with no intervening `HLine`, `FillBanner`, `RowFillBand`, or list marker MUST merge into a single cell (`OVER_SPLIT_ROWS` prevention) using a `while` loop until convergence.
- **`[R-OUTER-LOCK]` (Wide Ruled Table Outer-Row Lock):**
  For wide ruled tables (`VLine >= 6`) with multi-line descriptions in left columns and stacked numeric values in right columns, lock all columns in one `<Tablix>` and cut outer `<TablixRow>` boundaries ONLY on full-width `HLine` dividers between entries so right-hand numeric cells stay aligned without `<RowSpan>`.
- **`[R-DENSITY-SPLIT]` (Post-Grid Footnote Split):**
  Split into a new `<Tablix>` whenever layout transitions from a dense grid (`>= 4` columns) to a wide footnote/notes block (`<= 2` columns, width `>= 75%`) below a full-width `HLine`.
- **`[R-B-NONE]` (Default Invisible Borders):**
  All cells default to `<Border><Style>None</Style></Border>` on all 4 sides (`Top`, `Bottom`, `Left`, `Right`).
- **`[R-B-GRID]` (Vector-Matched Grid Borders):**
  Emit `<Style>Solid</Style>` ONLY on cell edges matching a vector `VLine` or `HLine` (or cell rect stroke) within `|Δ| <= 2.5pt` and `>= 70%` edge coverage.
- **`[R-B-BOX]` (Perimeter-Only Container Frame):**
  When a non-grid container is enclosed by an outer frame box, emit `<Style>Solid</Style>` ONLY on the outer perimeter edges of the container (`top` of first body row, `bottom` of last body row, `left` of col 0, `right` of rightmost col); keep all inner borders `None`.
- **`[R-B-HLINE]` (Horizontal-Only Divider Borders):**
  Emit `<Style>Solid</Style>` ONLY on the horizontal edge (`TopBorder` or `BottomBorder`) matching an `HLine` within `|Δ| <= 2.5pt` and `>= 70%` cell-width coverage; keep all vertical borders `None`.

---

## 3. Array Mutation & Closed-Loop Repair Protocol

1. **Logical Column Tracking (`ColSpan` + `RemoveAt`):**
   Always track logical column position with `logicalCol += cell.ColSpan` rather than raw `row.Cells[i]` array index. Whenever widening `cell.ColSpan` to absorb `k` empty trailing cells, add their `ColSpan` sum to `cell.ColSpan` and `RemoveAt` the absorbed cell entries so `sum(cell.ColSpan) == N_columns` holds continuously. At RDLC XML serialization time, expand each `ColSpan > 1` by emitting `ColSpan - 1` `<TablixCell />` elements.
2. **Convergence Before Compaction:**
   Run `[R-ROW-BOLD-MERGE]` and `[R-COLON-GRID]`/`[R-STAIRCASE]` `ColSpan` expansion before measuring `Row.Height`, propagating `Tablix.Height = sum(Row.Height)` and shifting subsequent `Tablix.Top` cursors.
3. **Strict Page Compaction:**
   If `H_compiled > H_printable`, reduce vertical cell padding (floor `0.25pt`) and scale row heights proportionally (`> 1.05 * fontSize`) until `renderedPageCount == sourcePageCount`. Never report `Repaired` while `H_compiled > H_printable`.

---

## 4. Verification Commands

- **Python Extractor (Stage 1):**
  `python extractor-py/extract.py <input.pdf> output/layout_ir.json output/debug_overlay.pdf`
- **C# Compiler (Stage 2):**
  `dotnet build compiler-dotnet && dotnet run --project compiler-dotnet -- output/layout_ir.json output/report.rdlc`
- **TypeScript Studio & Engine (Stage 3):**
  `npm run lint && npm run build`
