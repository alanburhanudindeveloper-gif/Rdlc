# Deterministic PDF-to-RDLC 2008 Compiler Rules (v3.3 — Page 1 & Multi-Stream Patch)

This file is the canonical rulebook for the polyglot PDF-to-RDLC 2008 compiler across:
- **Perception (`extractor-py/`, `ml_engine/`)**: PyMuPDF vector span extraction sorted visually by `(quantized_y, x0)` + `HLine`, `VLine`, `FillBanner`, `RowFillBand`, and 300 DPI header logos (`layout_ir.json`).
- **C# Compiler (`compiler-dotnet/RdlcBuilder.cs`)**: .NET 8 RDLC 2008 builder, geometric solver router, XSD structural validator, and page-height calibrator.
- **VB.NET Production Compiler & Logical Value-Filler (`dotnet/ReportGen.VbCompiler/`)**: Strongly typed `Option Strict On` / `Option Explicit On` 5-section compiler, deterministic value-fill engine (`DataTable` + `ReportParameter`), `LocalReport` renderer, and assistive Vector DB snapshot store.
- **TypeScript Fallback & Studio Engine (`src/engine/rdlc/`, `src/engine/vector/`)**: Sandbox Tablix compiler (`flat2008TablixCompiler.ts`), RDLC 2008 serializer (`rdlcGenerator.ts`), validator (`rdlcValidator.ts`), preview/diff renderer (`rdlcPreviewRenderer.ts`), and assistive Vector Artifact Store.

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
5. **Deterministic Core vs. Assistive Vector Store (`[R-ARCH-01]`):**
   PDF geometry extraction, `<Tablix>` grid reconstruction, RDLC 2008 validation, financial calculations, and `LocalReport` rendering are 100% deterministic. Any Vector Database persists test artifacts and scan-coordinate snapshots strictly for similar-layout lookup, regression inspection, and diagnostic diffing — NEVER to overwrite active coordinates or bypass deterministic rules.

---

## 2. Rule Reference Index (v3.3)

- **`[R-PB]` (Single Top-Most Page Break):**
  Emit `<PageBreak><BreakLocation>Start</BreakLocation></PageBreak>` ONLY on the single top-most (`min(Top)`) outer `<Tablix>` when `sourcePageIndex > 0`. NEVER emit `<PageBreak>` inside a nested `<Tablix>`, on a `TablixMember` inside a nested `<Tablix>`, or on a companion `RightTrack` `<Tablix>`.
- **`[R-PARENT-NESTED]` (Outer 2-Col Banner + Balanced Nested Dual Tablixes):**
  When a single full-width dark `FillBanner` (`luminance < 0.72`, `width >= 0.85 * printableWidth`) sits directly above dual side-by-side Key–Value groups or twin sub-grids (separated by `>= 6pt` vertical gutter with no crossing elements): emit **1 outer 2-column `<Tablix>`** (`R0` = Banner with `ColSpan=2`; `R1` = Left nested `<Tablix>` in Col 0, Right nested `<Tablix>` in Col 1). Zero `<RowSpan>`. Nested `<Tablix>` omits `<Top>`, `<Left>`, `<ZIndex>`, and `<PageBreak>`. Select the balanced center gutter where BOTH sides exhibit independent sub-structure (operator columns `:`/`=` or paired sub-grids) rather than splitting inside one track's `Label <-> : Value` gap.
- **`[R-DUAL-TRACK]` (Independent Dual-Track Streams & Track Y-Cursors):**
  Side-by-side parent headers, twin bordered sub-grids, or side-by-side KV/clause streams separated by a `>= 6pt` vertical gutter (without a full-width crossing horizontal divider) compile into independent Left and Right streams with independent Y-cursors (`Top` cursors). **DO NOT** force Left and Right rows onto a single shared horizontal `<TablixRow>` merely because their `y0` coordinates are near each other; build rows independently per stream so nested/indented sub-items (`• Minimum:`, `• Maksimum:`, stacked currency sub-grids) remain in vertical sequence without stretching across columns or colliding.
- **`[R-COLON-GRID]` (Operator Column Alignment & Multi-Line KV Value Continuity):**
  Cluster `:` and `=` X positions within `|Δx0| <= 2.5pt` (covering standalone `:`, inline `Label : Value`, and prefix `: Value` spans). Create narrow operator columns (`~8–10pt`), eliminate leading/trailing empty margin ghost columns (`0..firstItemX` with zero elements), and merge continuous multi-line KV `Label` and `Value` continuations (`|Δx0| <= 4.0pt`, `Δy <= 1.65 * fontSize`, no new operator/marker/HLine/RowFillBand) cleanly into their corresponding cells without mid-paragraph row slicing.
- **`[R-STAIRCASE]` (Zero-LeftIndent Staircase Hierarchy):**
  Cluster ascending marker and body `x0` positions within `|Δx0| <= 3.0pt` (`[X_0, X_1, ..., X_k]`) into `k` narrow indent columns + `1` body column (`totalCols = k + 1`). Never use `<LeftIndent>`. Span body and full-width rows using exact `ColSpan` (`totalCols - startCol`) + `RemoveAt`.
- **`[R-SUBGRID-STACK]` (Stacked Sub-Grids Inside KV/Multi-Stream Tracks):**
  When one or more localized bordered/shaded sub-grids sit inside a Key–Value or dual-track stream alongside unbordered KV/prose rows (above, between, or beside sub-grids with `zoneMinX > 0.20 * width` or `outsideCount >= 2`), route to `KeyValueSubGridFlattener` rather than `PlanarGridSolver`. Keep stacked sub-tables in vertical order inside their track, use `VLine`/bordered cell edges rather than inset unbordered `RowFillBand` padding rects (avoiding phantom narrow columns), and widen non-grid KV/prose rows cleanly via `ColSpan` + `RemoveAt`.
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
4. **VB.NET Logical Value-Fill (`[R-VBFILL-01]`):**
   Keep RDLC `<Value>` expressions simple (`=Fields!<Field>.Value` or `=Parameters!<Param>.Value`). Perform all currency/percentage formatting, zero-to-dash (`"-"` when `ShowZeroAsDash = True`), section-visibility boolean resolution, and subtotal/total math deterministically in VB.NET (`Option Strict On`, `Decimal`) before binding `ReportDataSource` and `ReportParameter` to `LocalReport`.

---

## 4. Verification Commands

- **Python Extractor (Stage 1):**
  `python extractor-py/extract.py <input.pdf> output/layout_ir.json output/debug_overlay.pdf`
- **C# Compiler (Stage 2):**
  `dotnet build compiler-dotnet && dotnet run --project compiler-dotnet -- output/layout_ir.json output/report.rdlc`
- **TypeScript Studio & Engine (Stage 3):**
  `npm run lint && npm run build`
