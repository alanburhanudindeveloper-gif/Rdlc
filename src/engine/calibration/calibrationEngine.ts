import {
  CalibrationConstraints,
  CalibrationLossBreakdown,
  CalibrationRoundTrace,
  CalibrationRunSummary,
  CompilerWeights,
  ContainerStrategyOverride,
  DEFAULT_COMPILER_WEIGHTS,
  ExistingProjectPattern,
  ForbidColumnSplitConstraint,
  ForceSplitYConstraint,
  ForceUnifiedTableBandConstraint,
  IntermediateLayoutModel,
  OffendingContainerHint,
  PageDensityOverride,
  PageParityDiagnostic,
  PinnedCalibrationDoc,
  RdlcValidationResult,
  RegionStyle,
  ReportDefinition,
  SolverStrategy,
  SplitTwinSubTableConstraint,
  StructuredLogger,
  TablixRegion,
  VisualDiffReport,
  VisualTextRun,
} from '../core/types.ts';
import { RdlcGenerator } from '../rdlc/rdlcGenerator.ts';
import {
  RdlcPageSpillover,
  RdlcPreviewResult,
  RdlcVisualPreviewRenderer,
} from '../rdlc/rdlcPreviewRenderer.ts';
import { RdlcValidator } from '../rdlc/rdlcValidator.ts';
import { TablixBuilder } from '../rdlc/tablixBuilder.ts';

const PT_PER_INCH = 72;
const LIST_MARKER_START_RE =
  /^(?:(?:\d+(?:\.\d+)*|[a-zA-Z]{1,3}|[ivxIVX]{2,5})[.)]|\([a-zA-Z0-9]+\)|[•\-\u2022\u25AA\u25CF])\s+/;

function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function cloneWeights(w: Partial<CompilerWeights> | undefined): CompilerWeights {
  return { ...DEFAULT_COMPILER_WEIGHTS, ...(w ?? {}) };
}

function cloneConstraints(c?: CalibrationConstraints): CalibrationConstraints {
  return {
    forbidColumnSplits: (c?.forbidColumnSplits ?? []).map((x) => ({ ...x })),
    forceTablixSplitsY: (c?.forceTablixSplitsY ?? []).map((x) => ({ ...x })),
    forceRowSplitsY: (c?.forceRowSplitsY ?? []).map((x) => ({ ...x })),
    strategyOverrides: (c?.strategyOverrides ?? []).map((x) => ({ ...x })),
    pageOverrides: (c?.pageOverrides ?? []).map((x) => ({ ...x })),
    splitTwinSubTables: (c?.splitTwinSubTables ?? []).map((x) => ({ ...x })),
    forceUnifiedTableBands: (c?.forceUnifiedTableBands ?? []).map((x) => ({ ...x })),
  };
}

function getOrCreatePageOverride(
  constraints: CalibrationConstraints,
  pageNumber: number
): PageDensityOverride {
  if (!constraints.pageOverrides) constraints.pageOverrides = [];
  let entry = constraints.pageOverrides.find((o) => o.pageNumber === pageNumber);
  if (!entry) {
    entry = { pageNumber };
    constraints.pageOverrides.push(entry);
  }
  return entry;
}

function estimateCellWrappedLineCount(
  value: string,
  runs: VisualTextRun[] | undefined,
  coveredWidthIn: number,
  style: RegionStyle,
  weights: CompilerWeights
): number {
  const padH =
    (style.paddingPt?.left ?? weights.cellPadHorizontalPt / 2) +
    (style.paddingPt?.right ?? weights.cellPadHorizontalPt / 2);
  const innerWPt = Math.max(12, coveredWidthIn * PT_PER_INCH - padH);
  const fs = (runs?.[0]?.fontSizePt ?? style.fontSizePt) || 8.5;
  const charWPt = Math.max(3.0, fs * Math.max(0.42, weights.charWidthFactor));
  const maxChars = Math.max(4, Math.floor(innerWPt / charWPt));
  const paragraphs = value.split(/\r?\n/);
  let totalLines = 0;
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      totalLines += 1;
      continue;
    }
    const words = trimmed.split(/\s+/);
    let currentLen = 0;
    let lines = 1;
    for (const word of words) {
      const nextLen = currentLen === 0 ? word.length : currentLen + 1 + word.length;
      if (nextLen <= maxChars) {
        currentLen = nextLen;
      } else if (word.length > maxChars) {
        if (currentLen > 0) lines += 1;
        const extra = Math.ceil(word.length / maxChars) - 1;
        lines += extra;
        currentLen = word.length % maxChars || maxChars;
      } else {
        lines += 1;
        currentLen = word.length;
      }
    }
    totalLines += lines;
  }
  return Math.max(1, totalLines);
}

interface DiagnosedPageSpillover {
  narrowFindings: Array<{
    diagnostic: PageParityDiagnostic;
    forbidBox?: ForbidColumnSplitConstraint;
  }>;
  overSplitFindings: PageParityDiagnostic[];
  excessHeightDiagnostic: PageParityDiagnostic;
}

function diagnosePageSpillover(
  spillover: RdlcPageSpillover,
  reportDef: ReportDefinition,
  weights: CompilerWeights
): DiagnosedPageSpillover {
  const bodyTablixes = reportDef.bodyTablixes ?? reportDef.tablixRegions;
  const pageTbls = bodyTablixes.filter((t) => t.pageNumber === spillover.sourcePage);
  const marginLeftIn = reportDef.marginsIn?.left ?? 0.75 / 2.54;

  const narrowFindings: DiagnosedPageSpillover['narrowFindings'] = [];
  const overSplitFindings: PageParityDiagnostic[] = [];
  const seenNarrow = new Set<string>();
  const seenOverSplit = new Set<string>();

  for (const tbl of pageTbls) {
    // Step 1: Narrow Column / Missing ColSpan bloat check
    for (let rIdx = 0; rIdx < tbl.rows.length; rIdx++) {
      const row = tbl.rows[rIdx];
      for (const cell of row.cells) {
        if (cell.skipBecauseMerged || cell.content.kind !== 'Textbox') continue;
        const textVal = (cell.content.value ?? '').trim();
        if (!textVal || cell.content.sourceLineCount === undefined) continue;

        const coveredWidthIn = tbl.columnWidthsIn
          .slice(cell.colIndex, Math.min(tbl.columnWidthsIn.length, cell.colIndex + cell.colSpan))
          .reduce((s, w) => s + w, 0);
        const renderedLines = estimateCellWrappedLineCount(
          textVal,
          cell.content.runs,
          coveredWidthIn,
          cell.content.style,
          weights
        );
        if (renderedLines <= cell.content.sourceLineCount + 1) continue;

        const trailingCells = row.cells.slice(cell.colIndex + cell.colSpan);
        const hasEmptyTrailing =
          trailingCells.length > 0 &&
          trailingCells.every(
            (tc) =>
              tc.skipBecauseMerged ||
              tc.content.kind === 'Empty' ||
              (tc.content.kind === 'Textbox' && !(tc.content.value ?? '').trim())
          );
        const narrowerThanSource =
          cell.content.sourceWidthIn !== undefined &&
          cell.content.sourceWidthIn * PT_PER_INCH > coveredWidthIn * PT_PER_INCH + 4;

        if (!hasEmptyTrailing && !narrowerThanSource) continue;

        let forbidBox: ForbidColumnSplitConstraint | undefined;
        if (
          cell.content.sourceX0In !== undefined &&
          cell.content.sourceWidthIn !== undefined &&
          cell.content.sourceYMinPt !== undefined &&
          cell.content.sourceYMaxPt !== undefined
        ) {
          const xMinPt = Math.max(0, (cell.content.sourceX0In - marginLeftIn) * PT_PER_INCH + 2);
          const xMaxPt = Math.max(
            xMinPt + 4,
            (cell.content.sourceX0In + cell.content.sourceWidthIn - marginLeftIn) * PT_PER_INCH - 2
          );
          forbidBox = {
            pageNumber: spillover.sourcePage,
            xMinPt: Math.round(xMinPt * 10) / 10,
            xMaxPt: Math.round(xMaxPt * 10) / 10,
            yMinPt: Math.round(cell.content.sourceYMinPt * 10) / 10,
            yMaxPt: Math.round(cell.content.sourceYMaxPt * 10) / 10,
          };
        }

        const key = `${tbl.name}|${rIdx}|${cell.colIndex}`;
        if (!seenNarrow.has(key)) {
          seenNarrow.add(key);
          narrowFindings.push({
            forbidBox,
            diagnostic: {
              pageNumber: spillover.sourcePage,
              tablixName: tbl.name,
              containerKey: tbl.containerKey,
              cause: 'NARROW_COLUMN_WRAP',
              renderedPageSpan: spillover.renderedPages,
              compiledHeightPt: spillover.compiledHeightPt,
              availableBodyHeightPt: spillover.availableBodyHeightPt,
              detail: `Row ${rIdx + 1} col ${cell.colIndex + 1} wrapped to ${renderedLines} lines vs source ${cell.content.sourceLineCount} lines (width ${(coveredWidthIn * PT_PER_INCH).toFixed(1)}pt${hasEmptyTrailing ? ', empty trailing cols' : ''})`,
              repaired: false,
            },
          });
        }
      }
    }

    // Step 2: Over-split Regular body prose rows sharing x0 without a border/divider
    for (let rIdx = 0; rIdx + 1 < tbl.rows.length; rIdx++) {
      const rowA = tbl.rows[rIdx];
      const rowB = tbl.rows[rIdx + 1];
      const activeA = rowA.cells.filter(
        (c) => !c.skipBecauseMerged && c.content.kind === 'Textbox' && (c.content.value ?? '').trim()
      );
      const activeB = rowB.cells.filter(
        (c) => !c.skipBecauseMerged && c.content.kind === 'Textbox' && (c.content.value ?? '').trim()
      );
      if (activeA.length !== 1 || activeB.length !== 1) continue;

      const cellA = activeA[0];
      const cellB = activeB[0];
      if (cellA.content.kind !== 'Textbox' || cellB.content.kind !== 'Textbox') continue;

      const stA = cellA.content.style;
      const stB = cellB.content.style;
      if (stA.bold || stB.bold) continue;
      if (stA.textAlign === 'Center' || stB.textAlign === 'Center') continue;
      if (stA.backgroundColor || stB.backgroundColor) continue;
      if (stA.borderEdges?.bottom || stB.borderEdges?.top) continue;
      if (Math.abs((stA.fontSizePt ?? 8.5) - (stB.fontSizePt ?? 8.5)) > 1.0) continue;

      const sameCol = cellA.colIndex === cellB.colIndex;
      const x0Close =
        cellA.content.sourceX0In !== undefined &&
        cellB.content.sourceX0In !== undefined &&
        Math.abs((cellA.content.sourceX0In - cellB.content.sourceX0In) * PT_PER_INCH) <= 4;
      if (!sameCol && !x0Close) continue;

      const txtA = cellA.content.value.trim();
      const txtB = cellB.content.value.trim();
      if (txtA.endsWith(':') || LIST_MARKER_START_RE.test(txtB)) continue;

      if (!seenOverSplit.has(tbl.name)) {
        seenOverSplit.add(tbl.name);
        overSplitFindings.push({
          pageNumber: spillover.sourcePage,
          tablixName: tbl.name,
          containerKey: tbl.containerKey,
          cause: 'OVER_SPLIT_ROWS',
          renderedPageSpan: spillover.renderedPages,
          compiledHeightPt: spillover.compiledHeightPt,
          availableBodyHeightPt: spillover.availableBodyHeightPt,
          detail: `Consecutive Regular body rows (${rIdx + 1} & ${rIdx + 2}) share left edge without divider`,
          repaired: false,
        });
      }
    }
  }

  const offendingName =
    spillover.offendingTablixes[0] ?? pageTbls[0]?.name ?? `Page_${spillover.sourcePage}`;
  const excessHeightDiagnostic: PageParityDiagnostic = {
    pageNumber: spillover.sourcePage,
    tablixName: offendingName,
    containerKey: pageTbls.find((t) => t.name === offendingName)?.containerKey,
    cause: 'EXCESS_ROW_HEIGHT',
    renderedPageSpan: spillover.renderedPages,
    compiledHeightPt: spillover.compiledHeightPt,
    availableBodyHeightPt: spillover.availableBodyHeightPt,
    detail: `Compiled body height ${spillover.compiledHeightPt.toFixed(1)}pt exceeds printable body ${spillover.availableBodyHeightPt.toFixed(1)}pt (spills onto ${spillover.renderedPages} pages)`,
    repaired: false,
  };

  return { narrowFindings, overSplitFindings, excessHeightDiagnostic };
}

function applyPageSpilloverRepairStep(
  spillover: RdlcPageSpillover,
  diagnosis: DiagnosedPageSpillover,
  weights: CompilerWeights,
  constraints: CalibrationConstraints,
  diagnosticHistory: Map<string, PageParityDiagnostic>
): boolean {
  const pageOverride = getOrCreatePageOverride(constraints, spillover.sourcePage);
  const recordDiag = (diag: PageParityDiagnostic) => {
    const key = `${diag.pageNumber}|${diag.tablixName}|${diag.cause}`;
    diagnosticHistory.set(key, { ...diag });
  };

  // Priority 1: Column Width / Missing ColSpan Bloat
  if (diagnosis.narrowFindings.length > 0) {
    let addedStep1 = false;
    for (const f of diagnosis.narrowFindings) {
      recordDiag(f.diagnostic);
      if (f.forbidBox) {
        const exists = constraints.forbidColumnSplits.some(
          (ex) =>
            ex.pageNumber === f.forbidBox!.pageNumber &&
            Math.abs(ex.xMinPt - f.forbidBox!.xMinPt) <= 2 &&
            Math.abs(ex.yMinPt - f.forbidBox!.yMinPt) <= 2
        );
        if (!exists) {
          constraints.forbidColumnSplits.push({ ...f.forbidBox });
          addedStep1 = true;
        }
      }
    }
    if (!pageOverride.extendTrailingColSpan) {
      pageOverride.extendTrailingColSpan = true;
      addedStep1 = true;
    }
    if (addedStep1) return true;
  }

  // Priority 2: Row Over-Splitting
  if (diagnosis.overSplitFindings.length > 0) {
    for (const d of diagnosis.overSplitFindings) {
      recordDiag(d);
    }
    if (!pageOverride.mergeOverSplitRows) {
      pageOverride.mergeOverSplitRows = true;
      return true;
    }
  }

  // Priority 3: Fast Bounded Row Height & Cell Padding Compaction (1:1 Page Parity)
  recordDiag(diagnosis.excessHeightDiagnostic);
  const curPadV = pageOverride.cellPadVerticalPt ?? weights.cellPadVerticalPt;
  const curLH = pageOverride.lineHeightMultiplier ?? weights.lineHeightMultiplier;
  const curGap = pageOverride.sectionGapPt ?? weights.sectionGapPt;
  const curMinRowH = pageOverride.minRowHeightPt ?? 13.5;
  const ratio = clamp(
    spillover.availableBodyHeightPt / Math.max(1, spillover.compiledHeightPt),
    0.55,
    0.97
  );
  const aggressiveCompact = ratio < 0.92;

  let mutated = false;
  if (curPadV > 0.5) {
    const targetPadV = aggressiveCompact
      ? 0.5
      : Math.max(0.5, Math.round(Math.min(curPadV - 1.0, curPadV * ratio) * 100) / 100);
    if (targetPadV < curPadV) {
      pageOverride.cellPadVerticalPt = targetPadV;
      mutated = true;
    }
  }
  if (curGap > 1.0) {
    const targetGap = aggressiveCompact
      ? 1.0
      : Math.max(1.0, Math.round(Math.min(curGap - 1.5, curGap * ratio) * 100) / 100);
    if (targetGap < curGap) {
      pageOverride.sectionGapPt = targetGap;
      mutated = true;
    }
  }
  if (curLH > 1.06) {
    let targetLH = curLH;
    if (curLH > 1.12) {
      targetLH = aggressiveCompact
        ? 1.12
        : Math.max(1.12, Math.round(Math.min(curLH - 0.08, curLH * Math.max(0.84, ratio)) * 100) / 100);
    } else {
      targetLH = 1.06;
    }
    if (targetLH < curLH) {
      pageOverride.lineHeightMultiplier = targetLH;
      mutated = true;
    }
  }
  if (curMinRowH > 7.5) {
    const targetMinRowH = aggressiveCompact
      ? 7.5
      : Math.max(7.5, Math.round(Math.min(curMinRowH - 2.0, curMinRowH * ratio) * 10) / 10);
    if (targetMinRowH < curMinRowH) {
      pageOverride.minRowHeightPt = targetMinRowH;
      mutated = true;
    }
  }

  return mutated;
}

export interface EnforcePageParityInput {
  layoutModel: IntermediateLayoutModel;
  schemaVersion: '2008' | '2016';
  existingPattern?: ExistingProjectPattern;
  weights?: Partial<CompilerWeights>;
  calibrationConstraints?: CalibrationConstraints;
  dummyJson?: Record<string, unknown>;
  embeddedCode?: string;
  logger: StructuredLogger;
  maxRepairPasses?: number;
}

export interface EnforcePageParityResult {
  reportDef: ReportDefinition;
  rdlcXml: string;
  previewHtml: RdlcPreviewResult;
  weights: CompilerWeights;
  constraints: CalibrationConstraints;
  pageParityDiagnostics: PageParityDiagnostic[];
  repaired: boolean;
}

export function enforceOneToOnePageParity(
  input: EnforcePageParityInput
): EnforcePageParityResult {
  const maxPasses = Math.max(1, Math.min(10, input.maxRepairPasses ?? 8));
  const weights = cloneWeights(input.weights);
  const constraints = cloneConstraints(input.calibrationConstraints);
  const tablixBuilder = new TablixBuilder(input.logger);
  const rdlcGenerator = new RdlcGenerator(input.logger);
  const previewRenderer = new RdlcVisualPreviewRenderer(input.logger);
  const diagnosticHistory = new Map<string, PageParityDiagnostic>();

  let reportDef!: ReportDefinition;
  let rdlcXml = '';
  let previewHtml!: RdlcPreviewResult;

  for (let pass = 0; pass <= maxPasses; pass++) {
    reportDef = tablixBuilder.buildReportDefinition(input.layoutModel, input.existingPattern, {
      schemaVersion: input.schemaVersion,
      weights,
      calibrationConstraints: constraints,
    });
    rdlcXml = rdlcGenerator.generate(reportDef, input.embeddedCode ?? '', {
      schemaVersion: input.schemaVersion,
    });
    previewHtml = previewRenderer.renderHtml(rdlcXml, {
      title: input.layoutModel.document.name,
      sampleFields: input.dummyJson,
    });

    const activeSpilloverPages = new Set(previewHtml.pageSpillovers.map((s) => s.sourcePage));
    for (const diag of diagnosticHistory.values()) {
      diag.repaired = !activeSpilloverPages.has(diag.pageNumber);
    }

    const parityOk =
      previewHtml.pageSpillovers.length === 0 &&
      previewHtml.pageCount === input.layoutModel.document.pageCount;
    if (parityOk || pass === maxPasses || previewHtml.pageSpillovers.length === 0) {
      break;
    }

    let anyMutated = false;
    for (const spillover of previewHtml.pageSpillovers) {
      const diagnosis = diagnosePageSpillover(spillover, reportDef, weights);
      const changed = applyPageSpilloverRepairStep(
        spillover,
        diagnosis,
        weights,
        constraints,
        diagnosticHistory
      );
      if (changed) anyMutated = true;
    }
    if (!anyMutated) break;
  }

  const repaired =
    previewHtml.pageSpillovers.length === 0 &&
    previewHtml.pageCount === input.layoutModel.document.pageCount;

  if (diagnosticHistory.size > 0) {
    input.logger.info('PageParityRepair', 'Completed 1:1 page parity repair loop', {
      sourcePages: input.layoutModel.document.pageCount,
      renderedPages: previewHtml.pageCount,
      remainingSpillovers: previewHtml.pageSpillovers.length,
      diagnostics: diagnosticHistory.size,
      repaired,
    });
  }

  return {
    reportDef,
    rdlcXml,
    previewHtml,
    weights,
    constraints,
    pageParityDiagnostics: Array.from(diagnosticHistory.values()),
    repaired,
  };
}

function getCandidateStrategiesForIssue(
  issue: OffendingContainerHint['issue'],
  current?: SolverStrategy
): SolverStrategy[] {
  const ordered: Record<OffendingContainerHint['issue'], SolverStrategy[]> = {
    TEXT_SLICED: [
      'INDENTATION_CLAUSE_SOLVER',
      'HLINE_OPERATOR_EQUATION_SOLVER',
      'KEY_VALUE_SUBGRID_FLATTENER',
      'DUAL_TRACK_STREAM_SOLVER',
      'DENSITY_TRANSITION_SPLITTER',
      'PLANAR_GRID_SOLVER',
    ],
    COLUMN_BLEED: [
      'KEY_VALUE_SUBGRID_FLATTENER',
      'DENSITY_TRANSITION_SPLITTER',
      'INDENTATION_CLAUSE_SOLVER',
      'PLANAR_GRID_SOLVER',
    ],
    ROW_OVERLAP: [
      'INDENTATION_CLAUSE_SOLVER',
      'KEY_VALUE_SUBGRID_FLATTENER',
      'DENSITY_TRANSITION_SPLITTER',
      'PLANAR_GRID_SOLVER',
    ],
  };
  return ordered[issue].filter((s) => s !== current);
}

export function evaluateLayoutLoss(
  layoutModel: IntermediateLayoutModel,
  reportDef: ReportDefinition,
  previewHtml: RdlcPreviewResult,
  rdlcValidation: RdlcValidationResult,
  visualDiff?: VisualDiffReport,
  weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS
): CalibrationLossBreakdown {
  const overlapCount = previewHtml.collisions.length;
  const clippedRowCount = previewHtml.clippedRows.length;
  const bodyTablixes = reportDef.bodyTablixes ?? reportDef.tablixRegions;
  const marginLeftIn = reportDef.marginsIn?.left ?? 0.75 / 2.54;

  const slicedBoxes: ForbidColumnSplitConstraint[] = [];
  const bleedSplitsY: ForceSplitYConstraint[] = [];
  const collisionSplitsY: ForceSplitYConstraint[] = [];
  const twinSubTableSplits: SplitTwinSubTableConstraint[] = [];
  const unifiedTableBands: ForceUnifiedTableBandConstraint[] = [];
  const offendingContainers: OffendingContainerHint[] = [];
  const seenHints = new Set<string>();

  const pushHint = (hint: OffendingContainerHint) => {
    const key = `${hint.containerKey}|${hint.issue}`;
    if (seenHints.has(key)) return;
    seenHints.add(key);
    offendingContainers.push(hint);
  };

  let slicedTextCount = 0;
  let columnBleedCount = 0;
  let rowOverlapCount = clippedRowCount;

  // 1. Clipped rows -> ROW_OVERLAP diagnostic hints
  for (const clip of previewHtml.clippedRows) {
    const tbl = bodyTablixes.find((t) => t.name === clip.tablixName && t.pageNumber === clip.page);
    if (tbl?.containerKey) {
      pushHint({
        containerKey: tbl.containerKey,
        tablixName: tbl.name,
        pageNumber: tbl.pageNumber,
        issue: 'ROW_OVERLAP',
        currentStrategy: tbl.solverStrategy,
      });
    }
  }

  // 2. Same-page Tablix vertical bounding box overlaps (in overlapping X spans)
  const tablixesByPage = new Map<number, TablixRegion[]>();
  for (const tbl of bodyTablixes) {
    const arr = tablixesByPage.get(tbl.pageNumber) ?? [];
    arr.push(tbl);
    tablixesByPage.set(tbl.pageNumber, arr);
  }

  for (const [pageNumber, pageTbls] of tablixesByPage.entries()) {
    const sorted = [...pageTbls].sort((a, b) => a.topIn - b.topIn);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        const xOverlap =
          Math.min(a.leftIn + a.widthIn, b.leftIn + b.widthIn) - Math.max(a.leftIn, b.leftIn);
        const yOverlap = a.topIn + a.heightIn - b.topIn;
        if (xOverlap > 0.05 && yOverlap > 0.02) {
          rowOverlapCount++;
          if (a.containerKey) {
            pushHint({
              containerKey: a.containerKey,
              tablixName: a.name,
              pageNumber,
              issue: 'ROW_OVERLAP',
              currentStrategy: a.solverStrategy,
            });
          }
          if (b.containerKey) {
            pushHint({
              containerKey: b.containerKey,
              tablixName: b.name,
              pageNumber,
              issue: 'ROW_OVERLAP',
              currentStrategy: b.solverStrategy,
            });
          }
        }
      }
    }
  }

  // 3. Sliced source text lines + column bleed + geometric vertical & wrapping residuals
  let deltaYSumPt = 0;
  let deltaYCount = 0;
  let renderedLineSum = 0;
  let sourceLineSum = 0;
  let pageLineSamples = 0;

  for (const page of layoutModel.pages) {
    const pageNum = page.pageNumber;
    const pageTbls = tablixesByPage.get(pageNum) ?? [];
    const bodyTextRegions = page.regions.filter(
      (r) =>
        r.bandKind !== 'Header' &&
        r.bandKind !== 'Footer' &&
        r.type === 'text' &&
        Boolean(r.text && r.text.trim())
    );

    const cellTextRecords: Array<{
      tbl: TablixRegion;
      rowIdx: number;
      activeCells: string[];
      joinedRowText: string;
    }> = [];
    const allSingleCellTexts: string[] = [];

    let pageEstLines = 0;
    for (const tbl of pageTbls) {
      for (let rIdx = 0; rIdx < tbl.rows.length; rIdx++) {
        const row = tbl.rows[rIdx];
        const activeCells: string[] = [];
        for (const cell of row.cells) {
          if (cell.skipBecauseMerged || cell.content.kind !== 'Textbox') continue;
          const txt = normalizeText(cell.content.value ?? '');
          if (!txt) continue;
          activeCells.push(txt);
          allSingleCellTexts.push(txt);

          const coveredCols = tbl.columnWidthsIn.slice(
            cell.colIndex,
            Math.min(tbl.columnWidthsIn.length, cell.colIndex + cell.colSpan)
          );
          const colWPt = Math.max(20, coveredCols.reduce((s, w) => s + w, 0) * PT_PER_INCH - weights.cellPadHorizontalPt);
          const fs = cell.content.style.fontSizePt || 8.5;
          const charWPt = fs * Math.max(0.42, weights.charWidthFactor);
          const charsPerLine = Math.max(6, Math.floor(colWPt / charWPt));
          const hardSegs = (cell.content.value ?? '').split('\n');
          for (const seg of hardSegs) {
            const trimmed = seg.trim();
            pageEstLines += trimmed ? Math.max(1, Math.ceil(trimmed.length / charsPerLine)) : 1;
          }
        }
        if (activeCells.length > 0) {
          cellTextRecords.push({
            tbl,
            rowIdx: rIdx,
            activeCells,
            joinedRowText: normalizeText(activeCells.join(' ')),
          });
        }
      }

      // Check column density bleed inside a single Tablix:
      // sparse long prose row followed by >= 3 dense multi-column rows (>= 4 atomic cols)
      if (tbl.columnWidthsIn.length >= 4 && tbl.rows.length >= 4) {
        let sparseLongRows = 0;
        let denseMultiColRows = 0;
        let firstDenseIdx = -1;
        for (let rIdx = 0; rIdx < tbl.rows.length; rIdx++) {
          const pop = tbl.rows[rIdx].cells.filter(
            (c) => !c.skipBecauseMerged && c.content.kind === 'Textbox' && c.content.value.trim().length > 0
          );
          if (pop.length <= 2 && pop.some((c) => c.content.kind === 'Textbox' && c.content.value.trim().length >= 30)) {
            sparseLongRows++;
          } else if (pop.length >= 3) {
            denseMultiColRows++;
            if (firstDenseIdx < 0) firstDenseIdx = rIdx;
          }
        }
        if (sparseLongRows >= 1 && denseMultiColRows >= 2 && tbl.solverStrategy !== 'KEY_VALUE_SUBGRID_FLATTENER') {
          columnBleedCount++;
          if (tbl.containerKey) {
            pushHint({
              containerKey: tbl.containerKey,
              tablixName: tbl.name,
              pageNumber: pageNum,
              issue: 'COLUMN_BLEED',
              currentStrategy: tbl.solverStrategy,
            });
          }
          if (bodyTextRegions.length > 0 && firstDenseIdx >= 0) {
            const sortedYs = bodyTextRegions.map((b) => b.y * PT_PER_INCH).sort((a, b) => a - b);
            const approxRatio = firstDenseIdx / Math.max(1, tbl.rows.length);
            const estY = sortedYs[Math.min(sortedYs.length - 1, Math.floor(approxRatio * sortedYs.length))];
            if (Number.isFinite(estY)) {
              bleedSplitsY.push({ pageNumber: pageNum, yPt: Math.round(estY * 10) / 10 });
            }
          }
        }
      }
    }

    if (bodyTextRegions.length > 0 && pageTbls.length > 0) {
      renderedLineSum += pageEstLines;
      sourceLineSum += bodyTextRegions.length;
      pageLineSamples++;

      const srcMinYPt = Math.min(...bodyTextRegions.map((r) => r.y * PT_PER_INCH));
      const srcMaxYPt = Math.max(...bodyTextRegions.map((r) => (r.y + r.height) * PT_PER_INCH));
      const srcSpanPt = Math.max(10, srcMaxYPt - srcMinYPt);
      const renderedSpanPt = pageTbls.reduce((s, t) => s + t.heightIn * PT_PER_INCH, 0);
      deltaYSumPt += renderedSpanPt - srcSpanPt;
      deltaYCount++;
    }

    // Sliced phrase check: source line with >= 10 chars & >= 3 words split across >= 2 cells on same row
    for (const reg of bodyTextRegions) {
      const norm = normalizeText(reg.text ?? '');
      if (norm.length < 10) continue;
      const words = norm.split(' ').filter((w) => w.length >= 2);
      if (words.length < 3) continue;

      const intact = allSingleCellTexts.some((ct) => ct.includes(norm));
      if (intact) continue;

      const splitRec = cellTextRecords.find((rec) => {
        if (rec.activeCells.length < 2) return false;
        if (rec.joinedRowText.includes(norm)) return true;
        const matchedWords = words.filter((w) => rec.joinedRowText.includes(w));
        return matchedWords.length >= Math.ceil(words.length * 0.75) && rec.activeCells.filter((ac) => words.some((w) => ac.includes(w))).length >= 2;
      });

      if (splitRec) {
        slicedTextCount++;
        const xMinPt = Math.max(0, (reg.x - marginLeftIn) * PT_PER_INCH + 2);
        const xMaxPt = Math.max(xMinPt + 4, (reg.x + reg.width - marginLeftIn) * PT_PER_INCH - 2);
        slicedBoxes.push({
          pageNumber: pageNum,
          xMinPt: Math.round(xMinPt * 10) / 10,
          xMaxPt: Math.round(xMaxPt * 10) / 10,
          yMinPt: Math.round(reg.y * PT_PER_INCH * 10) / 10,
          yMaxPt: Math.round((reg.y + reg.height) * PT_PER_INCH * 10) / 10,
        });
        if (splitRec.tbl.containerKey) {
          pushHint({
            containerKey: splitRec.tbl.containerKey,
            tablixName: splitRec.tbl.name,
            pageNumber: pageNum,
            issue: 'TEXT_SLICED',
            currentStrategy: splitRec.tbl.solverStrategy,
          });
        }
      }
    }
  }

  // Structural Backpropagation Operator A & C detectors per page
  for (const page of layoutModel.pages) {
    const pageNum = page.pageNumber;
    const pageTbls = tablixesByPage.get(pageNum) ?? [];
    const pageVLines = (page.vectorPrimitives ?? []).filter((pr) => pr.kind === 'VLine');

    // Operator A detector: full-width Tablix containing >= 2 bordered/numeric columns separated by a clean internal empty column gap
    for (const tbl of pageTbls) {
      if (tbl.leftIn > 0.1 || tbl.columnWidthsIn.length < 5 || tbl.rows.length < 3) continue;
      let cumX = 0;
      const colStartsIn = tbl.columnWidthsIn.map((w) => {
        const s = cumX;
        cumX += w;
        return s;
      });
      for (let midCol = 2; midCol < tbl.columnWidthsIn.length - 2; midCol++) {
        const colCenterPt = (colStartsIn[midCol] + tbl.columnWidthsIn[midCol] / 2) * PT_PER_INCH;
        const pageWidthPt = tbl.widthIn * PT_PER_INCH;
        if (colCenterPt < pageWidthPt * 0.25 || colCenterPt > pageWidthPt * 0.75) continue;

        const matchingRows = tbl.rows.filter((r) => {
          const midCell = r.cells[midCol];
          const midEmpty =
            !midCell ||
            midCell.skipBecauseMerged ||
            midCell.content.kind === 'Empty' ||
            (midCell.content.kind === 'Textbox' && !midCell.content.value.trim());
          if (!midEmpty) return false;
          const leftBordered = r.cells
            .slice(0, midCol)
            .some(
              (c) =>
                !c.skipBecauseMerged &&
                c.content.kind === 'Textbox' &&
                c.content.value.trim().length > 0 &&
                Boolean(c.content.style.borderColor || c.content.style.borderEdges)
            );
          const rightBordered = r.cells
            .slice(midCol + 1)
            .some(
              (c) =>
                !c.skipBecauseMerged &&
                c.content.kind === 'Textbox' &&
                c.content.value.trim().length > 0 &&
                Boolean(c.content.style.borderColor || c.content.style.borderEdges)
            );
          return leftBordered && rightBordered;
        });

        if (matchingRows.length >= 2) {
          const yVals = matchingRows
            .flatMap((r) =>
              r.cells.flatMap((c) =>
                c.content.kind === 'Textbox' && c.content.sourceYMinPt !== undefined && c.content.sourceYMaxPt !== undefined
                  ? [c.content.sourceYMinPt, c.content.sourceYMaxPt]
                  : []
              )
            );
          if (yVals.length >= 2) {
            twinSubTableSplits.push({
              pageNumber: pageNum,
              yMinPt: Math.round(Math.min(...yVals) * 10) / 10,
              yMaxPt: Math.round(Math.max(...yVals) * 10) / 10,
              gutterXPt: Math.round(colCenterPt * 10) / 10,
            });
            break;
          }
        }
      }
    }

    // Operator C detector: side-by-side track Tablix overlapping a dense multi-VLine table band (>= 5 VLines)
    if (pageVLines.length >= 5) {
      for (const tbl of pageTbls) {
        if (tbl.leftIn <= 0.1) continue;
        const yVals = tbl.rows.flatMap((r) =>
          r.cells.flatMap((c) =>
            c.content.kind === 'Textbox' && c.content.sourceYMinPt !== undefined && c.content.sourceYMaxPt !== undefined
              ? [c.content.sourceYMinPt, c.content.sourceYMaxPt]
              : []
          )
        );
        if (yVals.length < 2) continue;
        const yMinPt = Math.min(...yVals);
        const yMaxPt = Math.max(...yVals);
        const overlappingVLines = pageVLines.filter(
          (vl) => vl.yPt + vl.heightPt >= yMinPt - 10 && vl.yPt <= yMaxPt + 10
        );
        const distinctVXs = new Set(overlappingVLines.map((vl) => Math.round(vl.xPt / 4) * 4));
        if (distinctVXs.size >= 5) {
          unifiedTableBands.push({
            pageNumber: pageNum,
            yMinPt: Math.round((yMinPt - 18) * 10) / 10,
            yMaxPt: Math.round((yMaxPt + 8) * 10) / 10,
          });
        }
      }
    }
  }

  const pageParityDiagnostics: PageParityDiagnostic[] = [];
  for (const sp of previewHtml.pageSpillovers) {
    const diag = diagnosePageSpillover(sp, reportDef, weights);
    for (const nf of diag.narrowFindings) {
      pageParityDiagnostics.push(nf.diagnostic);
      if (nf.forbidBox) slicedBoxes.push(nf.forbidBox);
    }
    for (const os of diag.overSplitFindings) {
      pageParityDiagnostics.push(os);
    }
    if (diag.narrowFindings.length === 0 && diag.overSplitFindings.length === 0) {
      pageParityDiagnostics.push(diag.excessHeightDiagnostic);
    }
  }

  const pageSpilloverCount =
    previewHtml.pageSpillovers.length +
    Math.max(0, previewHtml.pageCount - layoutModel.document.pageCount);

  const meanDeltaY = deltaYCount > 0 ? Math.round((deltaYSumPt / deltaYCount) * 100) / 100 : 0;
  const meanLineCountDelta =
    pageLineSamples > 0
      ? Math.round(((renderedLineSum - sourceLineSum) / Math.max(1, sourceLineSum)) * 1000) / 1000
      : 0;
  const pixelDiffRatio = visualDiff?.available
    ? Math.max(0, Math.round((1 - (visualDiff.overallParityPercent ?? visualDiff.overallSimilarity * 100) / 100) * 10000) / 10000)
    : 0;
  const validationErrorsCount = rdlcValidation.errors.length;

  const totalLoss = Math.round(
    (overlapCount * 10000 +
      pageSpilloverCount * 8000 +
      clippedRowCount * 5000 +
      slicedTextCount * 3000 +
      columnBleedCount * 1500 +
      Math.abs(meanDeltaY) * 25 +
      Math.abs(meanLineCountDelta) * 40 +
      pixelDiffRatio * 500 +
      validationErrorsCount * 2000) *
      100
  ) / 100;

  return {
    totalLoss,
    overlapCount,
    clippedRowCount,
    slicedTextCount,
    columnBleedCount,
    rowOverlapCount,
    pageSpilloverCount,
    meanDeltaY,
    meanLineCountDelta,
    pixelDiffRatio,
    validationErrorsCount,
    pageParityDiagnostics,
    diagnosticHints: {
      slicedBoxes,
      bleedSplitsY,
      collisionSplitsY,
      offendingContainers,
      twinSubTableSplits: twinSubTableSplits.length > 0 ? twinSubTableSplits : undefined,
      unifiedTableBands: unifiedTableBands.length > 0 ? unifiedTableBands : undefined,
    },
  };
}

export interface CalibratePipelineInput {
  layoutModel: IntermediateLayoutModel;
  schemaVersion: '2008' | '2016';
  initialWeights?: Partial<CompilerWeights>;
  initialConstraints?: CalibrationConstraints;
  pinnedDocs?: PinnedCalibrationDoc[];
  existingPattern?: ExistingProjectPattern;
  dummyJson?: Record<string, unknown>;
  visualDiff?: VisualDiffReport;
  maxIterations?: number;
  targetLoss?: number;
  logger: StructuredLogger;
}

export function calibratePipeline(input: CalibratePipelineInput): CalibrationRunSummary {
  const maxIterations = Math.max(1, Math.min(12, input.maxIterations ?? 12));
  const targetLoss = input.targetLoss ?? 15;
  const is2008 = input.schemaVersion === '2008';

  const tablixBuilder = new TablixBuilder(input.logger);
  const rdlcGenerator = new RdlcGenerator(input.logger);
  const previewRenderer = new RdlcVisualPreviewRenderer(input.logger);
  const rdlcValidator = new RdlcValidator(input.logger);
  const pinnedDocs = input.pinnedDocs ?? [];

  const evaluateSingleDoc = (
    docLayout: IntermediateLayoutModel,
    weights: CompilerWeights,
    constraints: CalibrationConstraints,
    vDiff?: VisualDiffReport
  ): {
    loss: CalibrationLossBreakdown;
    reportDef: ReportDefinition;
    previewHtml: RdlcPreviewResult;
  } => {
    const reportDef = tablixBuilder.buildReportDefinition(docLayout, input.existingPattern, {
      schemaVersion: input.schemaVersion,
      weights,
      calibrationConstraints: constraints,
    });
    const rdlcXml = rdlcGenerator.generate(reportDef, '', { schemaVersion: input.schemaVersion });
    const previewHtml = previewRenderer.renderHtml(rdlcXml, {
      title: docLayout.document.name,
      sampleFields: input.dummyJson,
    });
    const validation = rdlcValidator.validate(rdlcXml, {
      requireRdlc2008: is2008,
      context: {
        sourcePageCount: docLayout.document.pageCount,
        renderedPageCount: previewHtml.pageCount,
        collisionsCount: previewHtml.collisions.length,
        clippedRowsCount: previewHtml.clippedRows.length,
        pageSpilloverCount: previewHtml.pageSpillovers.length,
        pageSpilloverSummary: previewHtml.pageSpillovers.map(
          (s) =>
            `P${s.sourcePage}->${s.renderedPages}pp (${s.compiledHeightPt.toFixed(0)}/${s.availableBodyHeightPt.toFixed(0)}pt)`
        ),
        deterministicShaMatch: true,
      },
    });
    return {
      loss: evaluateLayoutLoss(docLayout, reportDef, previewHtml, validation, vDiff, weights),
      reportDef,
      previewHtml,
    };
  };

  const evaluateJoint = (weights: CompilerWeights, constraints: CalibrationConstraints) => {
    const current = evaluateSingleDoc(input.layoutModel, weights, constraints, input.visualDiff);
    let pinnedLossSum = 0;
    for (const pinned of pinnedDocs) {
      const pl = evaluateSingleDoc(pinned.layoutModel, weights, constraints);
      pinnedLossSum += pl.loss.totalLoss;
    }
    return {
      currentLoss: current.loss,
      currentReportDef: current.reportDef,
      currentPreviewHtml: current.previewHtml,
      jointLoss: Math.round((current.loss.totalLoss + pinnedLossSum) * 100) / 100,
    };
  };

  let bestWeights = cloneWeights(input.initialWeights);
  let bestConstraints = cloneConstraints(input.initialConstraints);
  let bestEval = evaluateJoint(bestWeights, bestConstraints);

  const initialLoss = bestEval.currentLoss.totalLoss;
  const initialJointLoss = bestEval.jointLoss;
  const rounds: CalibrationRoundTrace[] = [];
  const triedStrategies = new Map<string, Set<SolverStrategy>>();

  const isConverged = (loss: CalibrationLossBreakdown): boolean =>
    loss.totalLoss <= targetLoss &&
    loss.overlapCount === 0 &&
    loss.clippedRowCount === 0 &&
    loss.slicedTextCount === 0 &&
    loss.pageSpilloverCount === 0 &&
    loss.validationErrorsCount === 0;

  for (let round = 1; round <= maxIterations; round++) {
    if (isConverged(bestEval.currentLoss)) break;

    const roundStartJoint = bestEval.jointLoss;
    const actions: string[] = [];
    const switchedStrategies: ContainerStrategyOverride[] = [];
    let anyAcceptedThisRound = false;

    // Step A: Counterexample constraint injection + priority-ordered 1:1 page parity repair
    const candConstraintsA = cloneConstraints(bestConstraints);
    let injectedCount = 0;

    for (const box of bestEval.currentLoss.diagnosticHints.slicedBoxes) {
      const exists = candConstraintsA.forbidColumnSplits.some(
        (ex) =>
          ex.pageNumber === box.pageNumber &&
          Math.abs(ex.xMinPt - box.xMinPt) <= 3 &&
          Math.abs(ex.yMinPt - box.yMinPt) <= 3
      );
      if (!exists) {
        candConstraintsA.forbidColumnSplits.push({ ...box });
        injectedCount++;
      }
    }
    for (const sp of bestEval.currentLoss.diagnosticHints.bleedSplitsY) {
      const exists = candConstraintsA.forceTablixSplitsY.some(
        (ex) => ex.pageNumber === sp.pageNumber && Math.abs(ex.yPt - sp.yPt) <= 6
      );
      if (!exists) {
        candConstraintsA.forceTablixSplitsY.push({ ...sp });
        injectedCount++;
      }
    }
    for (const rp of bestEval.currentLoss.diagnosticHints.collisionSplitsY) {
      const exists = candConstraintsA.forceRowSplitsY.some(
        (ex) => ex.pageNumber === rp.pageNumber && Math.abs(ex.yPt - rp.yPt) <= 6
      );
      if (!exists) {
        candConstraintsA.forceRowSplitsY.push({ ...rp });
        injectedCount++;
      }
    }
    for (const tw of bestEval.currentLoss.diagnosticHints.twinSubTableSplits ?? []) {
      const list = candConstraintsA.splitTwinSubTables ?? [];
      const exists = list.some(
        (ex) => ex.pageNumber === tw.pageNumber && Math.abs(ex.yMinPt - tw.yMinPt) <= 8
      );
      if (!exists) {
        list.push({ ...tw });
        candConstraintsA.splitTwinSubTables = list;
        injectedCount++;
      }
    }
    for (const ub of bestEval.currentLoss.diagnosticHints.unifiedTableBands ?? []) {
      const list = candConstraintsA.forceUnifiedTableBands ?? [];
      const exists = list.some(
        (ex) => ex.pageNumber === ub.pageNumber && Math.abs(ex.yMinPt - ub.yMinPt) <= 12
      );
      if (!exists) {
        list.push({ ...ub });
        candConstraintsA.forceUnifiedTableBands = list;
        injectedCount++;
      }
    }

    let parityMutations = 0;
    const parityDiagSink = new Map<string, PageParityDiagnostic>();
    for (const sp of bestEval.currentPreviewHtml.pageSpillovers) {
      const diag = diagnosePageSpillover(sp, bestEval.currentReportDef, bestWeights);
      if (applyPageSpilloverRepairStep(sp, diag, bestWeights, candConstraintsA, parityDiagSink)) {
        parityMutations++;
      }
    }

    if (injectedCount > 0 || parityMutations > 0) {
      const evalA = evaluateJoint(bestWeights, candConstraintsA);
      if (
        evalA.jointLoss <= bestEval.jointLoss ||
        evalA.currentLoss.pageSpilloverCount < bestEval.currentLoss.pageSpilloverCount
      ) {
        bestConstraints = candConstraintsA;
        bestEval = evalA;
        anyAcceptedThisRound = true;
        if (injectedCount > 0) actions.push(`+${injectedCount} counterexample constraint(s)`);
        if (parityMutations > 0) actions.push(`1:1 parity repair (${parityMutations} page(s))`);
      }
    }

    // Step B: Case-Driven Strategy Switching on top offending containers
    const offending = bestEval.currentLoss.diagnosticHints.offendingContainers.slice(0, 2);
    for (const hint of offending) {
      const tried = triedStrategies.get(hint.containerKey) ?? new Set<SolverStrategy>();
      if (hint.currentStrategy) tried.add(hint.currentStrategy);
      triedStrategies.set(hint.containerKey, tried);

      const candidates = getCandidateStrategiesForIssue(hint.issue, hint.currentStrategy).filter(
        (s) => !tried.has(s)
      );
      for (const candidateStrategy of candidates) {
        tried.add(candidateStrategy);
        const candC = cloneConstraints(bestConstraints);
        const overrides = candC.strategyOverrides ?? [];
        const existingIdx = overrides.findIndex((o) => o.containerKey === hint.containerKey);
        const nextOverride: ContainerStrategyOverride = {
          containerKey: hint.containerKey,
          pageNumber: hint.pageNumber,
          strategy: candidateStrategy,
          reason: hint.issue,
        };
        if (existingIdx >= 0) {
          overrides[existingIdx] = nextOverride;
        } else {
          overrides.push(nextOverride);
        }
        candC.strategyOverrides = overrides;

        const evalB = evaluateJoint(bestWeights, candC);
        if (evalB.jointLoss < bestEval.jointLoss - 0.5) {
          bestConstraints = candC;
          bestEval = evalB;
          anyAcceptedThisRound = true;
          switchedStrategies.push(nextOverride);
          actions.push(`${hint.tablixName} -> ${candidateStrategy}`);
          break;
        }
      }
    }

    // Step C: Proportional residual sizing updates (meanDeltaY, meanLineCountDelta, clipping)
    const lossNow = bestEval.currentLoss;
    const candWeightsC = cloneWeights(bestWeights);
    let touchedSizing = false;
    if (lossNow.clippedRowCount > 0 || lossNow.meanLineCountDelta < -0.15) {
      candWeightsC.lineHeightMultiplier = clamp(
        Math.round((candWeightsC.lineHeightMultiplier + 0.04) * 100) / 100,
        1.15,
        1.75
      );
      candWeightsC.cellPadVerticalPt = clamp(
        Math.round((candWeightsC.cellPadVerticalPt + 0.5) * 10) / 10,
        2,
        8
      );
      candWeightsC.charWidthFactor = clamp(
        Math.round((candWeightsC.charWidthFactor + 0.02) * 1000) / 1000,
        0.42,
        0.62
      );
      touchedSizing = true;
    } else if (lossNow.meanDeltaY > 4) {
      candWeightsC.lineHeightMultiplier = clamp(
        Math.round((candWeightsC.lineHeightMultiplier - 0.03) * 100) / 100,
        1.15,
        1.75
      );
      candWeightsC.sectionGapPt = clamp(
        Math.round((candWeightsC.sectionGapPt - 0.5) * 10) / 10,
        2,
        12
      );
      touchedSizing = true;
    } else if (lossNow.meanDeltaY < -4) {
      candWeightsC.lineHeightMultiplier = clamp(
        Math.round((candWeightsC.lineHeightMultiplier + 0.03) * 100) / 100,
        1.15,
        1.75
      );
      candWeightsC.sectionGapPt = clamp(
        Math.round((candWeightsC.sectionGapPt + 0.5) * 10) / 10,
        2,
        12
      );
      touchedSizing = true;
    }

    if (touchedSizing) {
      const evalC = evaluateJoint(candWeightsC, bestConstraints);
      if (evalC.jointLoss < bestEval.jointLoss - 0.5) {
        bestWeights = candWeightsC;
        bestEval = evalC;
        anyAcceptedThisRound = true;
        actions.push(`sizing residual (lineH=${bestWeights.lineHeightMultiplier}, charW=${bestWeights.charWidthFactor})`);
      }
    }

    // Step D: Coordinate descent over clustering & split tolerances
    const coordSpecs: Array<{
      key: keyof CompilerWeights;
      step: number;
      min: number;
      max: number;
    }> = [
      { key: 'xClusterTolPt', step: 0.5, min: 2, max: 8 },
      { key: 'yRowClusterTolPt', step: 0.5, min: 1.5, max: 6 },
      { key: 'justifyGapRatio', step: 0.15, min: 1.2, max: 2.6 },
      { key: 'leftAnchorTolPt', step: 0.5, min: 2.5, max: 8 },
    ];

    for (const spec of coordSpecs) {
      for (const dir of [-1, 1]) {
        const nextVal = clamp(
          Math.round((bestWeights[spec.key] + dir * spec.step) * 100) / 100,
          spec.min,
          spec.max
        );
        if (nextVal === bestWeights[spec.key]) continue;
        const candW = cloneWeights(bestWeights);
        candW[spec.key] = nextVal;
        const evalD = evaluateJoint(candW, bestConstraints);
        if (evalD.jointLoss < bestEval.jointLoss - 0.5) {
          bestWeights = candW;
          bestEval = evalD;
          anyAcceptedThisRound = true;
          actions.push(`${spec.key}=${nextVal}`);
          break;
        }
      }
    }

    const deltaLoss = Math.round((bestEval.jointLoss - roundStartJoint) * 100) / 100;
    rounds.push({
      round,
      totalLoss: bestEval.currentLoss.totalLoss,
      jointLoss: bestEval.jointLoss,
      deltaLoss,
      overlapCount: bestEval.currentLoss.overlapCount,
      clippedRowCount: bestEval.currentLoss.clippedRowCount,
      slicedTextCount: bestEval.currentLoss.slicedTextCount,
      meanDeltaY: bestEval.currentLoss.meanDeltaY,
      meanLineCountDelta: bestEval.currentLoss.meanLineCountDelta,
      pixelDiffRatio: bestEval.currentLoss.pixelDiffRatio,
      switchedStrategies: switchedStrategies.length > 0 ? switchedStrategies : undefined,
      actionSummary: actions.length > 0 ? actions.join('; ') : 'no further reduction',
    });

    if (!anyAcceptedThisRound) break;
  }

  const converged = isConverged(bestEval.currentLoss);
  input.logger.info('CalibrationEngine', 'Layer 6 CEGIS calibration complete', {
    converged,
    rounds: rounds.length,
    initialLoss,
    finalLoss: bestEval.currentLoss.totalLoss,
    initialJointLoss,
    finalJointLoss: bestEval.jointLoss,
  });

  return {
    converged,
    iterationsRun: rounds.length,
    initialLoss,
    finalLoss: bestEval.currentLoss.totalLoss,
    initialJointLoss,
    finalJointLoss: bestEval.jointLoss,
    weights: bestWeights,
    constraints: bestConstraints,
    lossBreakdown: bestEval.currentLoss,
    rounds,
  };
}
