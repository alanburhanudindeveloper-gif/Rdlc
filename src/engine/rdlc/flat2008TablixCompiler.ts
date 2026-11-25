import crypto from 'crypto';
import {
  CalibrationConstraints,
  CellBorderEdge,
  CompilerWeights,
  ContainerGeometricSignature,
  DEFAULT_COMPILER_WEIGHTS,
  ExtractedVectorPrimitive,
  LayoutPage,
  LayoutRegion,
  LayoutSectionSummary,
  PageDensityOverride,
  RdlcBandContainerSpec,
  RdlcDocumentHierarchy,
  RegionStyle,
  SolverStrategy,
  StructuredLogger,
  TablixCell,
  TablixRegion,
  TablixRow,
  VisualImageItem,
  VisualRectItem,
  VisualTextboxItem,
  VisualTextRun,
} from '../core/types.ts';

const PT_PER_INCH = 72;
const CM_PER_INCH = 2.54;

function roundIn(val: number): number {
  return Math.round(val * 10000) / 10000;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function cmToIn(cm: number): number {
  return cm / CM_PER_INCH;
}

function ptToIn(pt: number): number {
  return pt / PT_PER_INCH;
}

function inToPt(inches: number): number {
  return inches * PT_PER_INCH;
}

export function sanitize2008Identifier(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  if (!cleaned) return fallback;
  return /^[0-9]/.test(cleaned) ? `T_${cleaned}` : cleaned;
}

function parseHexRgb(hex?: string): [number, number, number] | null {
  if (!hex) return null;
  const norm = hex.trim().toUpperCase();
  const m = norm.match(/^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const toLinear = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
}

function contrastRatio(hexA?: string, hexB?: string): number {
  const rgbA = parseHexRgb(hexA);
  const rgbB = parseHexRgb(hexB);
  if (!rgbA || !rgbB) return 1;
  const l1 = relativeLuminance(rgbA);
  const l2 = relativeLuminance(rgbB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function isNonWhiteFill(hex?: string): boolean {
  const rgb = parseHexRgb(hex);
  if (!rgb) return false;
  const lum = relativeLuminance(rgb);
  const chroma = Math.max(...rgb) - Math.min(...rgb);
  return lum < 0.88 || chroma >= 24;
}

function isBannerCandidateRect(r: LayoutRegion, printableWidthIn: number): boolean {
  if (r.type !== 'vector_rect') return false;
  if (r.height < ptToIn(10) || r.height > ptToIn(48)) return false;
  if (r.width < printableWidthIn * 0.25) return false;
  return isNonWhiteFill(r.style.backgroundColor);
}

function clusterValues(vals: number[], tol: number): number[] {
  if (vals.length === 0) return [];
  const sorted = [...vals].sort((a, b) => a - b);
  const groups: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const grp = groups[groups.length - 1];
    const avg = grp.reduce((s, v) => s + v, 0) / grp.length;
    if (Math.abs(sorted[i] - avg) <= tol) {
      grp.push(sorted[i]);
    } else {
      groups.push([sorted[i]]);
    }
  }
  return groups.map((g) => roundIn(g.reduce((s, v) => s + v, 0) / g.length));
}

function defaultTextStyle(fontSizePt = 8.5, weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS): RegionStyle {
  const padV = Math.max(0.25, Math.round((weights.cellPadVerticalPt / 2) * 100) / 100);
  const padH = Math.max(1.5, Math.round(weights.cellPadHorizontalPt * 0.75 * 100) / 100);
  return {
    fontFamily: 'Arial',
    fontSizePt,
    bold: false,
    italic: false,
    color: '#0F172A',
    textAlign: 'Left',
    verticalAlign: 'Top',
    lineHeightPt: Math.round(fontSizePt * weights.lineHeightMultiplier * 100) / 100,
    paddingPt: { top: padV, right: padH, bottom: padV, left: padH },
  };
}

function estimateWrappedRowHeightPt(
  cells: Array<{
    text: string;
    runs?: VisualTextRun[];
    style: RegionStyle;
    coveredWidthPt: number;
  }>,
  minRowHeightPt = 14,
  weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS
): number {
  let maxH = minRowHeightPt;
  for (const c of cells) {
    const padL = c.style.paddingPt?.left ?? weights.cellPadHorizontalPt / 2;
    const padR = c.style.paddingPt?.right ?? weights.cellPadHorizontalPt / 2;
    const padT = c.style.paddingPt?.top ?? weights.cellPadVerticalPt / 2;
    const padB = c.style.paddingPt?.bottom ?? weights.cellPadVerticalPt / 2;
    const innerWidthPt = Math.max(20, c.coveredWidthPt - Math.max(padL + padR, weights.cellPadHorizontalPt));
    const fontSizePt = Math.max(
      6.5,
      c.runs && c.runs.length > 0
        ? Math.max(...c.runs.map((r) => r.fontSizePt || c.style.fontSizePt))
        : c.style.fontSizePt || 8.5
    );
    const baseFactor = Math.max(0.42, weights.charWidthFactor);
    const avgCharWidthPt = fontSizePt * (c.style.bold ? baseFactor * 1.12 : baseFactor * 1.05);
    const spaceWidthPt = fontSizePt * 0.28;
    const rawText = (c.text ?? '').trim();
    if (!rawText) {
      maxH = Math.max(maxH, minRowHeightPt);
      continue;
    }
    const explicitLines = rawText.split(/\r?\n/);
    let totalLines = 0;
    for (const line of explicitLines) {
      const words = line.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        totalLines += 1;
        continue;
      }
      let linesForPara = 1;
      let curW = 0;
      for (const word of words) {
        const wWidth = word.length * avgCharWidthPt;
        if (curW > 0 && curW + spaceWidthPt + wWidth > innerWidthPt) {
          linesForPara++;
          curW = wWidth;
        } else {
          curW = curW > 0 ? curW + spaceWidthPt + wWidth : wWidth;
        }
      }
      totalLines += Math.max(1, linesForPara);
    }
    const vertPad = Math.max(padT + padB, weights.cellPadVerticalPt);
    const cellHeightPt = Math.max(
      minRowHeightPt,
      totalLines * (fontSizePt * weights.lineHeightMultiplier) + vertPad
    );
    maxH = Math.max(maxH, cellHeightPt);
  }
  return maxH;
}

interface PositionedItem {
  kind: 'rect' | 'line' | 'image' | 'text';
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  region: LayoutRegion;
}

interface BannerElement {
  rect: PositionedItem;
  titleText: string;
  textItems: PositionedItem[];
  x: number;
  y: number;
  width: number;
  height: number;
  isFullWidth: boolean;
}

interface LogicalSegmentBlock {
  semanticName: string;
  containerKey?: string;
  track: 'full' | 'left' | 'right';
  leftIn: number;
  widthIn: number;
  pageNumber: number;
  pageBreakBefore: boolean;
  isBannerOnly?: boolean;
  isFootnote?: boolean;
  pairedStart?: boolean;
  banner?: BannerElement;
  items: PositionedItem[];
  forcedTopIn?: number;
}

interface LogicalRowBucket {
  yTop: number;
  yBottom: number;
  items: PositionedItem[];
  rects: PositionedItem[];
  isBannerRow?: boolean;
  isClauseTitleRow?: boolean;
  isHeaderRow?: boolean;
  isSubTableRow?: boolean;
  spanOverrides?: WeakMap<PositionedItem, { startCol: number; endCol: number; centerAlign?: boolean }>;
}

export interface Flat2008CompileInput {
  documentName: string;
  pages: LayoutPage[];
  pageWidthIn: number;
  pageHeightIn: number;
  marginsIn: { top: number; right: number; bottom: number; left: number };
  dataSetName: string;
  registerEmbeddedImage: (base64Data: string, preferredName: string) => string;
  nextUniqueName: (prefix: string) => string;
  weights?: Partial<CompilerWeights>;
  calibrationConstraints?: CalibrationConstraints;
}

export interface Flat2008CompileOutput {
  pageHeaderSpec?: RdlcBandContainerSpec;
  pageFooterSpec?: RdlcBandContainerSpec;
  bodyTablixes: TablixRegion[];
  hierarchy: RdlcDocumentHierarchy;
}

const CLAUSE_TITLE_WITH_MARKER_RE = /^(\d+(?:\.\d+)*\.|\(\d+\)|\([a-z]{1,3}\)|(?:i{1,3}|iv|vi{0,3}|ix|x)\.|[a-z]\.|[•\u2022\-–])\s+(.+)$/i;
const STANDALONE_MARKER_RE = /^(\d+(?:\.\d+)*\.|\(\d+\)|\([a-z]{1,3}\)|(?:i{1,3}|iv|vi{0,3}|ix|x)\.|[a-z]\.|[•\u2022\-–])$/i;

function resolvePageCompilerWeights(
  weights: CompilerWeights,
  constraints: CalibrationConstraints,
  pageNumber: number
): { pageWeights: CompilerWeights; override?: PageDensityOverride } {
  const override = constraints.pageOverrides?.find((o) => o.pageNumber === pageNumber);
  if (!override) return { pageWeights: weights };
  const pageWeights: CompilerWeights = {
    ...weights,
    cellPadVerticalPt:
      override.cellPadVerticalPt !== undefined
        ? Math.max(0.5, override.cellPadVerticalPt)
        : weights.cellPadVerticalPt,
    lineHeightMultiplier:
      override.lineHeightMultiplier !== undefined
        ? Math.max(1.06, override.lineHeightMultiplier)
        : weights.lineHeightMultiplier,
    sectionGapPt:
      override.sectionGapPt !== undefined
        ? Math.max(1.0, override.sectionGapPt)
        : weights.sectionGapPt,
  };
  return { pageWeights, override };
}

export class Flat2008TablixCompiler {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public compile(input: Flat2008CompileInput): Flat2008CompileOutput {
    const {
      documentName,
      pages,
      pageWidthIn,
      pageHeightIn,
      marginsIn,
      dataSetName,
      registerEmbeddedImage,
      nextUniqueName,
    } = input;

    const weights: CompilerWeights = { ...DEFAULT_COMPILER_WEIGHTS, ...(input.weights ?? {}) };
    const constraints: CalibrationConstraints = input.calibrationConstraints ?? {
      forbidColumnSplits: [],
      forceTablixSplitsY: [],
      forceRowSplitsY: [],
    };

    const printableWidthIn = roundIn(
      Math.max(1.5, pageWidthIn - marginsIn.left - marginsIn.right)
    );

    // 1. Build PageHeader & PageFooter exclusively from Layer 1 detected Header/Footer bands
    const {
      pageHeaderSpec,
      pageFooterSpec,
      excludedIdsByPage,
      bodyTopOriginIn,
      bodyBottomLimitIn,
    } = this.buildHeaderAndFooter(
      documentName,
      pages,
      printableWidthIn,
      pageHeightIn,
      marginsIn,
      registerEmbeddedImage
    );

    // 2. Collect clean body items per page in printable body coordinates (0..printableWidthIn)
    const bodyItemsByPage = new Map<number, PositionedItem[]>();
    const primitivesByPage = new Map<number, ExtractedVectorPrimitive[]>();
    for (const page of pages) {
      const pNum = page.pageNumber;
      const excludedIds = excludedIdsByPage.get(pNum) ?? new Set<string>();
      const pageItems: PositionedItem[] = [];

      const relPrims = (page.vectorPrimitives ?? [])
        .filter((pr) => pr.y + pr.height / 2 >= bodyTopOriginIn - 0.02 && pr.y + pr.height / 2 <= bodyBottomLimitIn + 0.02)
        .map((pr) => {
          const rx = clamp(pr.x - marginsIn.left, 0, Math.max(0, printableWidthIn - 0.01));
          const rw = clamp(pr.width, 0.005, printableWidthIn - rx);
          const ry = Math.max(0, pr.y - bodyTopOriginIn);
          return {
            ...pr,
            x: rx,
            y: ry,
            width: rw,
            xPt: inToPt(rx),
            yPt: inToPt(ry),
            widthPt: inToPt(rw),
          };
        });
      primitivesByPage.set(pNum, relPrims);

      for (const r of page.regions) {
        if (excludedIds.has(r.id)) continue;
        if (r.imageAssetName === 'HeaderLogo') continue;
        if (r.bandKind === 'Header' || r.bandKind === 'Footer') continue;

        // Skip full-page white background fill rects
        if (
          r.type === 'vector_rect' &&
          r.width >= pageWidthIn - 0.15 &&
          r.height >= pageHeightIn - 0.15 &&
          (!r.style.backgroundColor || r.style.backgroundColor.toUpperCase() === '#FFFFFF') &&
          !r.style.borderColor
        ) {
          continue;
        }

        const rCy = r.y + r.height / 2;
        if (rCy < bodyTopOriginIn - 0.02 || rCy > bodyBottomLimitIn + 0.02) continue;

        const relX = clamp(r.x - marginsIn.left, 0, Math.max(0, printableWidthIn - 0.01));
        const relW = clamp(r.width, r.type === 'vector_line' ? 0.005 : 0.015, printableWidthIn - relX);
        const relY = Math.max(0, r.y - bodyTopOriginIn);

        pageItems.push({
          kind:
            r.type === 'vector_line'
              ? 'line'
              : r.type === 'vector_rect'
                ? 'rect'
                : r.type === 'image' || r.type === 'vector_complex'
                  ? 'image'
                  : 'text',
          pageNumber: pNum,
          x: relX,
          y: relY,
          width: relW,
          height: r.height,
          region: r,
        });
      }

      bodyItemsByPage.set(pNum, pageItems);
    }

    // 3. Layer 2: Segment into ordered blocks with persistent SIDE_BY_SIDE_MODE across page breaks
    const blocks = this.segmentDocumentBlocks(
      pages,
      bodyItemsByPage,
      primitivesByPage,
      printableWidthIn,
      bodyTopOriginIn,
      weights,
      constraints
    );

    // 4. Layer 3 & Layer 4: Quantize each block into a FLAT Master-Grid Tablix + Cumulative Top flow
    const usedTablixNames = new Set<string>();
    const allocateTablixName = (desired: string): string => {
      const base = sanitize2008Identifier(desired, 'Tablix_Section');
      if (!usedTablixNames.has(base)) {
        usedTablixNames.add(base);
        return base;
      }
      let idx = 2;
      while (usedTablixNames.has(`${base}_${idx}`)) idx++;
      const unique = `${base}_${idx}`;
      usedTablixNames.add(unique);
      return unique;
    };

    const bodyTablixes: TablixRegion[] = [];
    const sectionSummaries: LayoutSectionSummary[] = [];

    let fullCursorTopIn = 0;
    let leftTrackBottomIn = 0;
    let rightTrackBottomIn = 0;
    let prevWasSideBySide = false;
    let currentCompilePageNum = -1;
    let pendingPageBreakForPage: number | null = null;
    const maxBudgetWidthInCompile = roundIn(Math.min(printableWidthIn, cmToIn(19.5)));

    for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
      const blk = blocks[bIdx];
      const { pageWeights, override: pageOverride } = resolvePageCompilerWeights(
        weights,
        constraints,
        blk.pageNumber
      );
      const gapIn = roundIn(ptToIn(pageWeights.sectionGapPt));
      const sectionGapIn = roundIn(
        ptToIn(
          Math.max(
            2,
            pageWeights.sectionGapPt + (pageOverride?.sectionGapPt !== undefined ? 1 : 4)
          )
        )
      );

      // Synchronize all cumulative vertical track cursors cleanly across page transitions
      if (blk.pageNumber !== currentCompilePageNum) {
        if (currentCompilePageNum !== -1) {
          const syncedPageTopIn = roundIn(
            Math.max(fullCursorTopIn, leftTrackBottomIn, rightTrackBottomIn) + gapIn
          );
          fullCursorTopIn = syncedPageTopIn;
          leftTrackBottomIn = syncedPageTopIn;
          rightTrackBottomIn = syncedPageTopIn;
        }
        currentCompilePageNum = blk.pageNumber;
      }

      const tablixName = allocateTablixName(blk.semanticName);
      const firstRawY = blk.banner
        ? blk.banner.y
        : blk.items.length > 0
          ? Math.min(...blk.items.map((it) => it.y - (blk.pageNumber - 1) * 100))
          : 0;
      const containerKey =
        blk.containerKey ??
        `P${blk.pageNumber}:${blk.track}:${Math.round(inToPt(blk.leftIn))}:${Math.round(inToPt(Math.max(0, firstRawY)))}`;
      blk.containerKey = containerKey;

      // Compute sequential cumulative Top coordinate (zero overlapping Tablixes)
      let assignedTopIn: number;
      if (blk.track === 'full') {
        if (prevWasSideBySide) {
          fullCursorTopIn = roundIn(Math.max(fullCursorTopIn, leftTrackBottomIn, rightTrackBottomIn) + sectionGapIn);
          prevWasSideBySide = false;
        }
        assignedTopIn = roundIn(fullCursorTopIn);
      } else {
        if (!prevWasSideBySide) {
          // Entering SIDE_BY_SIDE_MODE (DUAL_TRACK_STREAM_SOLVER): start both tracks at identical Top Y
          const startY = roundIn(fullCursorTopIn);
          leftTrackBottomIn = startY;
          rightTrackBottomIn = startY;
          prevWasSideBySide = true;
        } else if (blk.pairedStart && blk.track === 'left') {
          const syncY = roundIn(Math.max(fullCursorTopIn, leftTrackBottomIn, rightTrackBottomIn));
          leftTrackBottomIn = syncY;
          rightTrackBottomIn = syncY;
        }
        if (blk.track === 'left') {
          assignedTopIn = roundIn(leftTrackBottomIn);
        } else {
          assignedTopIn = roundIn(rightTrackBottomIn);
        }
      }

      const effectiveBlock: LogicalSegmentBlock =
        pendingPageBreakForPage === blk.pageNumber && blk.track !== 'right'
          ? { ...blk, pageBreakBefore: true }
          : blk;

      const tablix = this.compileFlatMasterGridTablix(
        tablixName,
        effectiveBlock,
        assignedTopIn,
        dataSetName,
        registerEmbeddedImage,
        nextUniqueName,
        primitivesByPage.get(blk.pageNumber) ?? [],
        bodyTopOriginIn,
        weights,
        constraints
      );

      if (tablix.rows.length === 0) {
        if (effectiveBlock.pageBreakBefore) {
          pendingPageBreakForPage = blk.pageNumber;
        }
        continue;
      }
      if (pendingPageBreakForPage === blk.pageNumber && blk.track !== 'right') {
        pendingPageBreakForPage = null;
      }

      bodyTablixes.push(tablix);

      const postGap = blk.isBannerOnly ? ptToIn(1.5) : gapIn;
      if (blk.track === 'full') {
        fullCursorTopIn = roundIn(tablix.topIn + tablix.heightIn + postGap);
      } else if (blk.track === 'left') {
        leftTrackBottomIn = roundIn(tablix.topIn + tablix.heightIn + postGap);
      } else {
        rightTrackBottomIn = roundIn(tablix.topIn + tablix.heightIn + postGap);
      }

      sectionSummaries.push({
        name: tablix.name,
        slug: blk.semanticName,
        pageNumber: blk.pageNumber,
        pageBreakStart: Boolean(tablix.pageBreakBefore),
        topIn: tablix.topIn,
        leftIn: tablix.leftIn,
        widthIn: tablix.widthIn,
        heightIn: tablix.heightIn,
        layoutType: blk.track === 'full' ? 'Tablix' : 'Dual-Column',
        rowCount: tablix.rows.length,
        colCount: tablix.columnWidthsIn.length,
        hasNestedTablixes: false,
        columnCount: tablix.columnWidthsIn.length,
        hasHeaderBand: Boolean(blk.banner),
        hasLeftColumn: blk.track === 'left',
        hasRightColumn: blk.track === 'right',
        hasFooterBand: Boolean(blk.isFootnote),
        childItemCount: tablix.rows.length,
        containerKey: tablix.containerKey,
        solverStrategy: tablix.solverStrategy,
        geometricSignature: tablix.geometricSignature,
      });
    }

    // Strict 1:1 Source-Page Anchor Enforcement (guaranteed 17 in === 17 out):
    // Every page > 1 must have its PageBreak<Start> strictly on the FIRST non-right-track Tablix (full or left).
    for (let pIdx = 0; pIdx < pages.length; pIdx++) {
      const pNum = pages[pIdx].pageNumber;
      const pageTbls = bodyTablixes.filter((t) => t.pageNumber === pNum);
      for (const t of pageTbls) {
        t.pageBreakBefore = false;
      }
      if (pIdx === 0) continue;

      const firstAnchor = pageTbls.find((t) => t.leftIn < maxBudgetWidthInCompile * 0.42);
      if (firstAnchor) {
        firstAnchor.pageBreakBefore = true;
      } else {
        // Page had no left/full Tablix (e.g., right-track only or graphic-free page): synthesize a minimal left/full anchor
        const rightOnly = pageTbls[0];
        const anchorTop = rightOnly
          ? rightOnly.topIn
          : roundIn(Math.max(fullCursorTopIn, leftTrackBottomIn, rightTrackBottomIn) + ptToIn(2));
        const anchorW = rightOnly ? roundIn(Math.max(0.5, rightOnly.leftIn - ptToIn(6))) : maxBudgetWidthInCompile;
        const anchorName = allocateTablixName(rightOnly ? `Tablix_Left_Anchor_P${pNum}` : `Tablix_Page_${pNum}`);
        const anchorH = roundIn(ptToIn(8));
        const anchorTablix: TablixRegion = {
          id: anchorName,
          name: anchorName,
          pageNumber: pNum,
          sourcePageIndex: pIdx,
          bandKind: 'Detail',
          containerKey: `P${pNum}:${rightOnly ? 'left' : 'full'}:anchor`,
          solverStrategy: rightOnly ? 'DUAL_TRACK_STREAM_SOLVER' : 'INDENTATION_CLAUSE_SOLVER',
          pageBreakBefore: true,
          keepTogether: false,
          topIn: anchorTop,
          leftIn: 0,
          widthIn: anchorW,
          heightIn: anchorH,
          dataSetName,
          isRepeatingDetail: false,
          columnWidthsIn: [anchorW],
          rows: [
            {
              heightIn: anchorH,
              isDetailRow: false,
              cells: [
                {
                  colIndex: 0,
                  rowIndex: 0,
                  colSpan: 1,
                  rowSpan: 1,
                  skipBecauseMerged: false,
                  content: {
                    kind: 'Textbox',
                    name: nextUniqueName('AnchorCell'),
                    value: '',
                    isExpression: false,
                    style: { ...defaultTextStyle(7.5, weights), borderColor: undefined, paddingPt: { top: 0, right: 0, bottom: 0, left: 0 } },
                    canGrow: false,
                  },
                },
              ],
            },
          ],
          zIndex: 1,
        };
        if (rightOnly) {
          const insertIdx = bodyTablixes.indexOf(rightOnly);
          bodyTablixes.splice(Math.max(0, insertIdx), 0, anchorTablix);
        } else {
          bodyTablixes.push(anchorTablix);
          fullCursorTopIn = roundIn(anchorTop + anchorH + ptToIn(2));
        }
        sectionSummaries.push({
          name: anchorTablix.name,
          slug: anchorTablix.name,
          pageNumber: pNum,
          pageBreakStart: true,
          topIn: anchorTablix.topIn,
          leftIn: anchorTablix.leftIn,
          widthIn: anchorTablix.widthIn,
          heightIn: anchorTablix.heightIn,
          layoutType: rightOnly ? 'Dual-Column' : 'Tablix',
          rowCount: 1,
          colCount: 1,
          hasNestedTablixes: false,
          columnCount: 1,
          hasHeaderBand: false,
          hasLeftColumn: Boolean(rightOnly),
          hasRightColumn: false,
          hasFooterBand: false,
          childItemCount: 1,
          containerKey: anchorTablix.containerKey,
          solverStrategy: anchorTablix.solverStrategy,
        });
      }
    }

    const hierarchy: RdlcDocumentHierarchy = {
      mode: 'v3-full-tablix-single-rdlc',
      pageHeader: pageHeaderSpec
        ? {
            heightIn: pageHeaderSpec.heightIn,
            printOnFirstPage: pageHeaderSpec.printOnFirstPage ?? true,
            printOnLastPage: pageHeaderSpec.printOnLastPage ?? true,
            assetCount: pageHeaderSpec.images.length,
            textLabels: pageHeaderSpec.textboxes.map((t) => t.text).filter(Boolean),
          }
        : undefined,
      pageFooter: pageFooterSpec
        ? {
            heightIn: pageFooterSpec.heightIn,
            printOnFirstPage: pageFooterSpec.printOnFirstPage ?? true,
            printOnLastPage: pageFooterSpec.printOnLastPage ?? true,
            assetCount: pageFooterSpec.images.length,
            textLabels: pageFooterSpec.textboxes.map((t) => t.text).filter(Boolean),
          }
        : undefined,
      sections: sectionSummaries,
    };

    this.logger.info('Flat2008Compiler', 'Strict RDLC 2008 flat Master-Grid compilation complete', {
      tablixes: bodyTablixes.length,
      nestedTablixes: 0,
      hasPageHeader: Boolean(pageHeaderSpec),
      hasPageFooter: Boolean(pageFooterSpec),
    });

    return {
      pageHeaderSpec,
      pageFooterSpec,
      bodyTablixes,
      hierarchy,
    };
  }

  private buildHeaderAndFooter(
    documentName: string,
    pages: LayoutPage[],
    printableWidthIn: number,
    pageHeightIn: number,
    marginsIn: { top: number; right: number; bottom: number; left: number },
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string
  ): {
    pageHeaderSpec?: RdlcBandContainerSpec;
    pageFooterSpec?: RdlcBandContainerSpec;
    excludedIdsByPage: Map<number, Set<string>>;
    bodyTopOriginIn: number;
    bodyBottomLimitIn: number;
  } {
    void documentName;
    const excludedIdsByPage = new Map<number, Set<string>>();
    for (const p of pages) excludedIdsByPage.set(p.pageNumber, new Set<string>());

    const p1 = pages[0];
    const headerRegionsP1 = (p1?.regions ?? []).filter((r) => r.bandKind === 'Header');
    const allHeaderRegions = pages.flatMap((p) => p.regions.filter((r) => r.bandKind === 'Header'));
    const allFooterRegions = pages.flatMap((p) => p.regions.filter((r) => r.bandKind === 'Footer'));

    for (const p of pages) {
      const ex = excludedIdsByPage.get(p.pageNumber)!;
      for (const r of p.regions) {
        if (r.bandKind === 'Header' || r.bandKind === 'Footer') {
          ex.add(r.id);
        }
      }
    }

    // Build PageHeader exclusively from Layer 1 detected Header regions
    let pageHeaderSpec: RdlcBandContainerSpec | undefined;
    let bodyTopOriginIn = marginsIn.top;

    if (allHeaderRegions.length > 0) {
      const hasNativeP1Header = headerRegionsP1.length > 0;
      const headerSourceRegions = hasNativeP1Header
        ? [...headerRegionsP1]
        : allHeaderRegions.filter((r) => r.pageNumber === allHeaderRegions[0].pageNumber);

      if (!headerSourceRegions.some((r) => r.imageAssetName === 'HeaderLogo' && r.imageAssetBase64)) {
        const fallbackLogo = allHeaderRegions.find(
          (r) => r.imageAssetName === 'HeaderLogo' && r.imageAssetBase64
        );
        if (fallbackLogo) {
          headerSourceRegions.push(fallbackLogo);
        }
      }

      const headerImages: VisualImageItem[] = [];
      const headerTextboxes: VisualTextboxItem[] = [];
      const headerRects: VisualRectItem[] = [];

      const headerLogoRegion = headerSourceRegions.find(
        (r) => r.imageAssetName === 'HeaderLogo' && r.imageAssetBase64
      );
      if (headerLogoRegion && headerLogoRegion.imageAssetBase64) {
        const embName = registerEmbeddedImage(headerLogoRegion.imageAssetBase64, 'HeaderLogo');
        const logoLeftIn = roundIn(clamp(headerLogoRegion.x - marginsIn.left, 0, Math.max(0, printableWidthIn - 0.5)));
        const logoTopIn = roundIn(Math.max(ptToIn(1.5), headerLogoRegion.y - marginsIn.top));
        headerImages.push({
          kind: 'Image',
          name: 'imgHeaderLogo',
          embeddedImageName: embName,
          leftIn: logoLeftIn,
          topIn: logoTopIn,
          widthIn: roundIn(clamp(headerLogoRegion.width, ptToIn(18), printableWidthIn * 0.45)),
          heightIn: roundIn(clamp(headerLogoRegion.height, ptToIn(12), cmToIn(2.0))),
          sizing: 'FitProportional',
          zIndex: 1,
        });
      }

      const headerOtherImages = headerSourceRegions.filter(
        (r) => (r.type === 'image' || r.type === 'vector_complex') && r.imageAssetName !== 'HeaderLogo' && r.imageAssetBase64
      );
      headerOtherImages.forEach((imgReg, idx) => {
        if (!imgReg.imageAssetBase64) return;
        const embName = registerEmbeddedImage(imgReg.imageAssetBase64, imgReg.imageAssetName ?? `HeaderGraphic_${idx + 1}`);
        const leftIn = roundIn(clamp(imgReg.x - marginsIn.left, 0, Math.max(0, printableWidthIn - 0.2)));
        const topIn = roundIn(Math.max(ptToIn(1.5), imgReg.y - marginsIn.top));
        headerImages.push({
          kind: 'Image',
          name: `imgHeaderGraphic_${idx + 1}`,
          embeddedImageName: embName,
          leftIn,
          topIn,
          widthIn: roundIn(clamp(imgReg.width, ptToIn(12), printableWidthIn - leftIn)),
          heightIn: roundIn(clamp(imgReg.height, ptToIn(10), cmToIn(2.0))),
          sizing: 'FitProportional',
          zIndex: 1,
        });
      });

      const headerLineOrRects = headerSourceRegions.filter(
        (r) => r.type === 'vector_line' || r.type === 'vector_rect'
      );
      headerLineOrRects.forEach((vr, idx) => {
        const bg = vr.style.backgroundColor ?? vr.style.borderColor;
        if (!bg) return;
        const leftIn = roundIn(clamp(vr.x - marginsIn.left, 0, printableWidthIn));
        const topIn = roundIn(Math.max(0, vr.y - marginsIn.top));
        const wIn = roundIn(clamp(vr.width, 0.01, printableWidthIn - leftIn));
        const hIn = roundIn(Math.max(0.015, vr.height));
        headerRects.push({
          kind: 'Rectangle',
          name: `hdrRect_${idx + 1}`,
          leftIn,
          topIn,
          widthIn: wIn,
          heightIn: hIn,
          backgroundColor: vr.style.backgroundColor,
          borderColor: vr.style.borderColor,
          borderWidthPt: vr.style.borderWidthPt,
          zIndex: 0,
        });
      });

      const headerTexts = headerSourceRegions
        .filter((r) => r.type === 'text' && (r.text ?? '').trim().length > 0)
        .sort((a, b) => a.y - b.y || a.x - b.x);

      headerTexts.forEach((tr, idx) => {
        const leftIn = roundIn(clamp(tr.x - marginsIn.left, 0, Math.max(0, printableWidthIn - 0.3)));
        const topIn = roundIn(Math.max(ptToIn(1.5), tr.y - marginsIn.top));
        const wIn = roundIn(clamp(tr.width + ptToIn(8), ptToIn(24), printableWidthIn - leftIn));
        const hIn = roundIn(Math.max(ptToIn(12), tr.height + ptToIn(2)));
        const isRightHalf = tr.x - marginsIn.left > printableWidthIn * 0.45 && tr.x + tr.width - marginsIn.left > printableWidthIn * 0.72;
        headerTextboxes.push({
          kind: 'Textbox',
          name: `txtHeader_${idx + 1}`,
          leftIn,
          topIn,
          widthIn: wIn,
          heightIn: hIn,
          text: tr.text!.trim(),
          runs: tr.runs,
          style: {
            ...tr.style,
            textAlign: isRightHalf ? 'Right' : tr.style.textAlign ?? 'Left',
            verticalAlign: 'Top',
            paddingPt: { top: 1, right: 2, bottom: 1, left: 2 },
          },
          canGrow: true,
          zIndex: 2,
        });
      });

      const maxItemBottom = Math.max(
        ptToIn(18),
        ...headerImages.map((i) => i.topIn + i.heightIn),
        ...headerTextboxes.map((t) => t.topIn + t.heightIn),
        ...headerRects.map((r) => r.topIn + r.heightIn)
      );
      const headerHeightIn = roundIn(clamp(maxItemBottom + ptToIn(4), cmToIn(0.8), cmToIn(3.2)));
      const maxRawHeaderBottom = Math.max(...headerSourceRegions.map((r) => r.y + r.height));
      bodyTopOriginIn = Math.max(marginsIn.top, maxRawHeaderBottom + ptToIn(2));

      pageHeaderSpec = {
        kind: 'PageHeader',
        heightIn: headerHeightIn,
        printOnFirstPage: hasNativeP1Header,
        printOnLastPage: true,
        rectangles: headerRects,
        images: headerImages,
        textboxes: headerTextboxes,
        tablixes: [],
      };
    }

    // Build PageFooter exclusively from Layer 1 detected Footer regions
    let pageFooterSpec: RdlcBandContainerSpec | undefined;
    let bodyBottomLimitIn = pageHeightIn - marginsIn.bottom;

    if (allFooterRegions.length > 0) {
      const footerP1 = (p1?.regions ?? []).filter((r) => r.bandKind === 'Footer');
      const footerSourceRegions =
        footerP1.length > 0
          ? footerP1
          : allFooterRegions.filter((r) => r.pageNumber === allFooterRegions[0].pageNumber);

      const minFooterRawTop = Math.min(...allFooterRegions.map((r) => r.y));
      bodyBottomLimitIn = Math.min(pageHeightIn - marginsIn.bottom, minFooterRawTop - ptToIn(2));

      const footerTextboxes: VisualTextboxItem[] = [];
      const footerRects: VisualRectItem[] = [];

      const escapeVbStr = (s: string): string => s.replace(/"/g, '""');
      const toPageCounterExpression = (raw: string): string | null => {
        const trimmed = raw.trim();
        const twoNum = trimmed.match(/^(.*?)(\d+)(\s*(?:\/|of|dari|from|sur|von)\s*)(\d+)(.*)$/i);
        if (twoNum) {
          const [, prefix, , sep, , suffix] = twoNum;
          const parts: string[] = [];
          if (prefix) parts.push(`"${escapeVbStr(prefix)}"`);
          parts.push('Globals!PageNumber');
          parts.push(`"${escapeVbStr(sep)}"`);
          parts.push('Globals!TotalPages');
          if (suffix) parts.push(`"${escapeVbStr(suffix)}"`);
          return `=${parts.join(' & ')}`;
        }
        const oneNum = trimmed.match(/^(.*?)(\d+)(.*)$/);
        if (oneNum && (/^(?:page|hal\.?|halaman|p\.?|pg\.?|seite)\s*\d+$/i.test(trimmed) || /^\d{1,3}$/.test(trimmed))) {
          const [, prefix, , suffix] = oneNum;
          const parts: string[] = [];
          if (prefix) parts.push(`"${escapeVbStr(prefix)}"`);
          parts.push('Globals!PageNumber');
          if (suffix) parts.push(`"${escapeVbStr(suffix)}"`);
          return `=${parts.join(' & ')}`;
        }
        return null;
      };

      const footerBaseY = Math.min(...footerSourceRegions.map((r) => r.y));

      footerSourceRegions
        .filter((r) => r.type === 'vector_line' || r.type === 'vector_rect')
        .forEach((vr, idx) => {
          const leftIn = roundIn(clamp(vr.x - marginsIn.left, 0, printableWidthIn));
          const topIn = roundIn(Math.max(0, vr.y - footerBaseY + ptToIn(2)));
          footerRects.push({
            kind: 'Rectangle',
            name: `ftrRect_${idx + 1}`,
            leftIn,
            topIn,
            widthIn: roundIn(clamp(vr.width, 0.01, printableWidthIn - leftIn)),
            heightIn: roundIn(Math.max(0.015, vr.height)),
            backgroundColor: vr.style.backgroundColor,
            borderColor: vr.style.borderColor,
            borderWidthPt: vr.style.borderWidthPt,
            zIndex: 0,
          });
        });

      const footerTexts = footerSourceRegions
        .filter((r) => r.type === 'text' && (r.text ?? '').trim().length > 0)
        .sort((a, b) => a.y - b.y || a.x - b.x);

      footerTexts.forEach((tr, idx) => {
        const rawText = tr.text!.trim();
        const counterExpr = toPageCounterExpression(rawText);
        const value = counterExpr ?? rawText;
        const leftIn = roundIn(clamp(tr.x - marginsIn.left, 0, Math.max(0, printableWidthIn - 0.3)));
        const topIn = roundIn(Math.max(ptToIn(2), tr.y - footerBaseY + ptToIn(2)));
        const wIn = roundIn(
          clamp(counterExpr ? Math.max(tr.width + ptToIn(24), cmToIn(3.5)) : tr.width + ptToIn(8), ptToIn(24), printableWidthIn - leftIn)
        );
        const hIn = roundIn(Math.max(ptToIn(12), tr.height + ptToIn(2)));
        const isRightAligned = tr.x - marginsIn.left > printableWidthIn * 0.55;
        footerTextboxes.push({
          kind: 'Textbox',
          name: counterExpr ? `txtPageNumber_${idx + 1}` : `txtFooter_${idx + 1}`,
          leftIn: isRightAligned && counterExpr ? roundIn(Math.max(0, printableWidthIn - wIn)) : leftIn,
          topIn,
          widthIn: wIn,
          heightIn: hIn,
          text: value,
          runs: counterExpr
            ? [
                {
                  text: value,
                  fontFamily: tr.style.fontFamily,
                  fontSizePt: tr.style.fontSizePt,
                  bold: tr.style.bold,
                  italic: tr.style.italic,
                  color: tr.style.color,
                },
              ]
            : tr.runs,
          style: {
            ...tr.style,
            textAlign: isRightAligned ? 'Right' : tr.style.textAlign ?? 'Left',
            verticalAlign: 'Top',
            paddingPt: { top: 0, right: 0, bottom: 0, left: 0 },
          },
          canGrow: true,
          zIndex: 1,
        });
      });

      const maxFtrBottom = Math.max(
        ptToIn(16),
        ...footerTextboxes.map((t) => t.topIn + t.heightIn),
        ...footerRects.map((r) => r.topIn + r.heightIn)
      );
      const footerHeightIn = roundIn(clamp(maxFtrBottom + ptToIn(4), cmToIn(0.6), cmToIn(2.0)));

      pageFooterSpec = {
        kind: 'PageFooter',
        heightIn: footerHeightIn,
        printOnFirstPage: true,
        printOnLastPage: true,
        rectangles: footerRects,
        images: [],
        textboxes: footerTextboxes,
        tablixes: [],
      };
    }

    return {
      pageHeaderSpec,
      pageFooterSpec,
      excludedIdsByPage,
      bodyTopOriginIn,
      bodyBottomLimitIn,
    };
  }

  private extractPageBanners(
    items: PositionedItem[],
    printableWidthIn: number,
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS,
    pagePrimitives: ExtractedVectorPrimitive[] = []
  ): { banners: BannerElement[]; consumedRegionIds: Set<string> } {
    const consumedRegionIds = new Set<string>();
    const rawBannerRects = items
      .filter((it) => isBannerCandidateRect(it.region, printableWidthIn))
      .sort((a, b) => a.y - b.y || a.x - b.x);

    // Also inspect Layer 1 RLE FillBanners not yet mirrored in items
    for (const pr of pagePrimitives) {
      if (pr.kind !== 'FillBanner') continue;
      if (pr.width < printableWidthIn * 0.25 || pr.height < ptToIn(10) || pr.height > ptToIn(48)) continue;
      const alreadyPresent = rawBannerRects.some(
        (b) =>
          Math.abs(b.x - pr.x) <= ptToIn(6) &&
          Math.abs(b.y - pr.y) <= ptToIn(6) &&
          Math.abs(b.width - pr.width) <= ptToIn(12)
      );
      if (!alreadyPresent) {
        rawBannerRects.push({
          kind: 'rect',
          pageNumber: items[0]?.pageNumber ?? 1,
          x: pr.x,
          y: pr.y,
          width: pr.width,
          height: pr.height,
          region: {
            id: pr.id,
            pageNumber: items[0]?.pageNumber ?? 1,
            type: 'vector_rect',
            x: pr.x,
            y: pr.y,
            width: pr.width,
            height: pr.height,
            style: { ...defaultTextStyle(9.5, weights), backgroundColor: pr.colorHex ?? '#334155' },
            semanticRole: 'unknown',
            confidence: 0.9,
            bandKind: 'Detail',
            isAmbiguous: false,
            sourceObjectRefs: [pr.id],
          },
        });
      }
    }
    rawBannerRects.sort((a, b) => a.y - b.y || a.x - b.x);

    // Deduplicate overlapping banner candidate rects (e.g. CTM fill rect + RLE FillBanner at identical spot)
    const bannerRects: PositionedItem[] = [];
    for (const cand of rawBannerRects) {
      const dupIdx = bannerRects.findIndex((ex) => {
        const yClose = Math.abs(ex.y - cand.y) <= ptToIn(6) && Math.abs(ex.height - cand.height) <= ptToIn(8);
        if (!yClose) return false;
        const xOverlap = Math.min(ex.x + ex.width, cand.x + cand.width) - Math.max(ex.x, cand.x);
        return xOverlap >= Math.min(ex.width, cand.width) * 0.65;
      });
      if (dupIdx >= 0) {
        const ex = bannerRects[dupIdx];
        // Prefer the wider/CTM-filled candidate and mark the redundant one consumed
        if (cand.width > ex.width + ptToIn(2)) {
          consumedRegionIds.add(ex.region.id);
          bannerRects[dupIdx] = cand;
        } else {
          consumedRegionIds.add(cand.region.id);
        }
      } else {
        bannerRects.push(cand);
      }
    }

    const banners: BannerElement[] = [];
    for (const br of bannerRects) {
      const bgHex = br.region.style.backgroundColor;
      const bgRgb = parseHexRgb(bgHex);
      if (!bgRgb) continue;
      const bgLum = relativeLuminance(bgRgb);

      // Guard against duplicate banners sharing the exact same Y-band and X-span
      const overlapsExistingBanner = banners.some((eb) => {
        if (Math.abs(eb.y - br.y) > ptToIn(4)) return false;
        const xOverlap = Math.min(eb.x + eb.width, br.x + br.width) - Math.max(eb.x, br.x);
        return xOverlap >= Math.min(eb.width, br.width) * 0.5;
      });
      if (overlapsExistingBanner) {
        consumedRegionIds.add(br.region.id);
        continue;
      }

      const enclosed = items
        .filter((it) => {
          if (it.kind !== 'text' || consumedRegionIds.has(it.region.id)) return false;
          const cy = it.y + it.height / 2;
          const cx = it.x + it.width / 2;
          return (
            cy >= br.y - ptToIn(3) &&
            cy <= br.y + br.height + ptToIn(3) &&
            cx >= br.x - ptToIn(4) &&
            cx <= br.x + br.width + ptToIn(4)
          );
        })
        .sort((a, b) => a.x - b.x);

      if (enclosed.length === 0) continue;

      const titleText = enclosed
        .map((t) => (t.region.text ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();

      if (!titleText) continue;

      // Require contrasting foreground text against the banner fill
      const maxTextContrast = Math.max(
        ...enclosed.map((t) => contrastRatio(t.region.style.color, bgHex))
      );
      const hasLightTextOnDarkFill =
        bgLum < 0.45 &&
        enclosed.some((t) => {
          const tRgb = parseHexRgb(t.region.style.color);
          return tRgb ? relativeLuminance(tRgb) > 0.55 && contrastRatio(t.region.style.color, bgHex) >= 2.6 : false;
        });

      // Avoid misclassifying multi-column data table header bars (3+ separate columns inside a light shaded bar)
      let distinctHorizontalCols = 1;
      for (let k = 1; k < enclosed.length; k++) {
        const gap = enclosed[k].x - (enclosed[k - 1].x + enclosed[k - 1].width);
        if (gap > ptToIn(10)) distinctHorizontalCols++;
      }
      const isSingleHeadingBar = distinctHorizontalCols <= 2 && bgLum < 0.78 && maxTextContrast >= 2.8;

      if (!hasLightTextOnDarkFill && !isSingleHeadingBar) continue;

      consumedRegionIds.add(br.region.id);
      enclosed.forEach((t) => consumedRegionIds.add(t.region.id));

      banners.push({
        rect: br,
        titleText,
        textItems: enclosed,
        x: br.x,
        y: br.y,
        width: br.width,
        height: br.height,
        isFullWidth: br.width >= printableWidthIn * weights.fullWidthBannerRatio,
      });
    }

    return { banners, consumedRegionIds };
  }

  private segmentDocumentBlocks(
    pages: LayoutPage[],
    bodyItemsByPage: Map<number, PositionedItem[]>,
    primitivesByPage: Map<number, ExtractedVectorPrimitive[]>,
    printableWidthIn: number,
    bodyTopOriginIn: number,
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS,
    constraints: CalibrationConstraints = { forbidColumnSplits: [], forceTablixSplitsY: [], forceRowSplitsY: [] }
  ): LogicalSegmentBlock[] {
    const blocks: LogicalSegmentBlock[] = [];

    const maxBudgetWidthIn = roundIn(Math.min(printableWidthIn, cmToIn(19.5)));
    const trackGapIn = roundIn(ptToIn(Math.max(4, weights.minCenterGutterPt)));
    const computeTrackBounds = (rawGutterX: number) => {
      const leftWidth = roundIn(
        clamp(rawGutterX - trackGapIn / 2, 1.0, Math.max(1.0, maxBudgetWidthIn - 1.0 - trackGapIn))
      );
      const rightLeft = roundIn(leftWidth + trackGapIn);
      const rightWidth = roundIn(Math.max(1.0, maxBudgetWidthIn - rightLeft));
      return { leftWidth, rightLeft, rightWidth };
    };

    let sideBySide = false;
    let gutterXIn = maxBudgetWidthIn / 2;
    let activeFull: LogicalSegmentBlock | null = null;
    let activeLeft: LogicalSegmentBlock | null = null;
    let activeRight: LogicalSegmentBlock | null = null;
    let sectionSeq = 1;

    const flushFull = () => {
      if (activeFull && (activeFull.items.length > 0 || activeFull.banner)) {
        blocks.push(activeFull);
      }
      activeFull = null;
    };

    const flushLeft = () => {
      if (activeLeft && (activeLeft.items.length > 0 || activeLeft.banner)) {
        blocks.push(activeLeft);
      }
      activeLeft = null;
    };

    const flushRight = () => {
      if (activeRight && (activeRight.items.length > 0 || activeRight.banner)) {
        blocks.push({ ...activeRight, pageBreakBefore: false });
      }
      activeRight = null;
    };

    const flushAllSideBySide = () => {
      flushLeft();
      flushRight();
      sideBySide = false;
    };

    const makeFullName = (title?: string, fallbackPage = 1): string => {
      if (title) {
        const slug = sanitize2008Identifier(title.split(/\s+/).slice(0, 5).join('_'), 'Section');
        return `Tablix_${String(sectionSeq++).padStart(2, '0')}_${slug}`;
      }
      return `Tablix_${String(sectionSeq++).padStart(2, '0')}_Page${fallbackPage}`;
    };

    const makeTrackName = (side: 'Left' | 'Right', title?: string): string => {
      if (title) {
        const slug = sanitize2008Identifier(title.split(/\s+/).slice(0, 5).join('_'), side);
        return `Tablix_${side}_${String(sectionSeq++).padStart(2, '0')}_${slug}`;
      }
      return `Tablix_${side}_${String(sectionSeq++).padStart(2, '0')}`;
    };

    // Helper: group a flat list of PositionedItems into Y-baseline rows for purely structural lookahead
    const groupItemsIntoYRows = (list: PositionedItem[]): Array<{ y: number; items: PositionedItem[]; textItems: PositionedItem[] }> => {
      const sorted = [...list].sort((a, b) => a.y - b.y || a.x - b.x);
      const rows: Array<{ y: number; items: PositionedItem[]; textItems: PositionedItem[] }> = [];
      const rowTol = ptToIn(3.5);
      for (const it of sorted) {
        const last = rows[rows.length - 1];
        if (last && Math.abs(it.y - last.y) <= rowTol) {
          last.items.push(it);
          if (it.kind === 'text') last.textItems.push(it);
        } else {
          rows.push({
            y: it.y,
            items: [it],
            textItems: it.kind === 'text' ? [it] : [],
          });
        }
      }
      return rows;
    };

    const isBoldGroupHeadingRow = (row: { textItems: PositionedItem[] }): boolean => {
      if (row.textItems.length !== 1) return false;
      const it = row.textItems[0];
      const txt = (it.region.text ?? '').trim();
      if (txt.length < 3 || txt.length > 60) return false;
      if (!it.region.style.bold) return false;
      if (/^(\d+(?:\.\d+)*\.|\([a-z0-9]+\)|[a-z]\.|[•\u2022\-–])\s+/i.test(txt)) return false;
      if (/[.,;?!]$/.test(txt)) return false;
      return true;
    };

    const countDenseRows = (items: PositionedItem[]): number => {
      const rows = groupItemsIntoYRows(items);
      return rows.filter((r) => r.textItems.length >= 4).length;
    };

    for (let pageLoopIdx = 0; pageLoopIdx < pages.length; pageLoopIdx++) {
      const page = pages[pageLoopIdx];
      const pNum = page.pageNumber;
      // On page transitions, flush prior page's open blocks while preserving persistent sideBySide & gutterXIn
      if (pageLoopIdx > 0) {
        if (sideBySide) {
          flushLeft();
          flushRight();
        } else {
          flushFull();
        }
      }

      const items = bodyItemsByPage.get(pNum) ?? [];
      const pagePrimitives = primitivesByPage.get(pNum) ?? [];
      const { banners, consumedRegionIds } = this.extractPageBanners(
        items,
        maxBudgetWidthIn,
        weights,
        pagePrimitives
      );
      let nonBannerItems = items
        .filter((it) => !consumedRegionIds.has(it.region.id))
        .sort((a, b) => a.y - b.y || a.x - b.x);

      // Operator C: Protect unified wide multi-column bordered tables from narrow fill sub-header banners
      const pageForcedUnified = (constraints.forceUnifiedTableBands ?? []).filter(
        (fb) => fb.pageNumber === pNum
      );
      const isBannerInsideWideMultiColTable = (b: BannerElement): boolean => {
        if (b.isFullWidth) return false;
        const absYPt = inToPt(b.y + b.height / 2 + bodyTopOriginIn);
        if (pageForcedUnified.some((fb) => absYPt >= fb.yMinPt - 12 && absYPt <= fb.yMaxPt + 12)) {
          return true;
        }
        const winTop = b.y - ptToIn(8);
        const winBot = b.y + b.height + ptToIn(140);
        const rawVXs: number[] = [];
        for (const it of nonBannerItems) {
          if (it.kind === 'line' && it.width <= ptToIn(3.5) && it.height >= ptToIn(14)) {
            if (it.y + it.height >= winTop && it.y <= winBot) rawVXs.push(it.x);
          } else if (
            it.kind === 'rect' &&
            it.width < maxBudgetWidthIn * 0.45 &&
            it.height >= ptToIn(12) &&
            it.y + it.height >= winTop &&
            it.y <= winBot
          ) {
            rawVXs.push(it.x, it.x + it.width);
          }
        }
        for (const pr of pagePrimitives) {
          if (pr.kind === 'VLine' && pr.y + pr.height >= winTop && pr.y <= winBot) {
            rawVXs.push(pr.x);
          }
        }
        const vLineXs = clusterValues(rawVXs, ptToIn(4));
        if (vLineXs.length >= 5) return true;
        const hasWideHLine =
          nonBannerItems.some(
            (it) =>
              (it.kind === 'line' || it.kind === 'rect') &&
              it.height <= ptToIn(3.5) &&
              it.width >= maxBudgetWidthIn * 0.70 &&
              it.y >= winTop &&
              it.y <= winBot
          ) ||
          pagePrimitives.some(
            (pr) =>
              pr.kind === 'HLine' &&
              pr.width >= maxBudgetWidthIn * 0.70 &&
              pr.y >= winTop &&
              pr.y <= winBot
          );
        return hasWideHLine && vLineXs.length >= 3;
      };

      // Pair side-by-side banners on the same horizontal band (|dy| <= 4pt)
      const pairedBannerIndices = new Set<number>();
      type BannerEvent =
        | { kind: 'twoTier'; y: number; topBanner: BannerElement; left: BannerElement; right: BannerElement }
        | { kind: 'pair'; y: number; left: BannerElement; right: BannerElement }
        | { kind: 'full'; y: number; banner: BannerElement }
        | { kind: 'singleTrack'; y: number; banner: BannerElement };

      const bannerEvents: BannerEvent[] = [];
      for (let i = 0; i < banners.length; i++) {
        if (pairedBannerIndices.has(i)) continue;
        const b = banners[i];
        if (b.isFullWidth) {
          // Two-tier split header: full-width banner <= 3pt above two touching half-width banners
          const subCandidates: Array<{ idx: number; b: BannerElement }> = [];
          for (let j = i + 1; j < banners.length; j++) {
            const nb = banners[j];
            if (nb.isFullWidth) continue;
            const gapBelow = nb.y - (b.y + b.height);
            if (gapBelow >= -ptToIn(1) && gapBelow <= ptToIn(3.0)) {
              subCandidates.push({ idx: j, b: nb });
            }
          }
          if (subCandidates.length >= 2) {
            const sortedSubs = subCandidates.slice(0, 2).sort((a, c) => a.b.x - c.b.x);
            if (
              Math.abs(sortedSubs[0].b.y - sortedSubs[1].b.y) <= ptToIn(4) &&
              sortedSubs[0].b.x + sortedSubs[0].b.width <= sortedSubs[1].b.x + ptToIn(4)
            ) {
              pairedBannerIndices.add(i);
              pairedBannerIndices.add(sortedSubs[0].idx);
              pairedBannerIndices.add(sortedSubs[1].idx);
              bannerEvents.push({
                kind: 'twoTier',
                y: b.y,
                topBanner: b,
                left: sortedSubs[0].b,
                right: sortedSubs[1].b,
              });
              continue;
            }
          }
          pairedBannerIndices.add(i);
          bannerEvents.push({ kind: 'full', y: b.y, banner: b });
        } else {
          // Side-by-side banners (|dy| <= 4pt, horizontally separated, each width < 0.65 * printableWidth)
          const partnerIdx = banners.findIndex(
            (other, j) =>
              j > i &&
              !pairedBannerIndices.has(j) &&
              !other.isFullWidth &&
              other.width < maxBudgetWidthIn * 0.65 &&
              b.width < maxBudgetWidthIn * 0.65 &&
              Math.abs(other.y - b.y) <= ptToIn(4) &&
              (other.x >= b.x + b.width - ptToIn(2) || b.x >= other.x + other.width - ptToIn(2))
          );
          if (partnerIdx >= 0) {
            const partner = banners[partnerIdx];
            pairedBannerIndices.add(i);
            pairedBannerIndices.add(partnerIdx);
            const [left, right] = b.x <= partner.x ? [b, partner] : [partner, b];
            bannerEvents.push({ kind: 'pair', y: Math.min(left.y, right.y), left, right });
          } else {
            pairedBannerIndices.add(i);
            if (isBannerInsideWideMultiColTable(b)) {
              // Keep narrow table sub-header inside the unified PLANAR_GRID_SOLVER table instead of triggering sideBySide
              consumedRegionIds.delete(b.rect.region.id);
              nonBannerItems.push(b.rect);
              for (const ti of b.textItems) {
                consumedRegionIds.delete(ti.region.id);
                nonBannerItems.push(ti);
              }
            } else {
              bannerEvents.push({ kind: 'singleTrack', y: b.y, banner: b });
            }
          }
        }
      }
      nonBannerItems.sort((a, b) => a.y - b.y || a.x - b.x);

      // Segment non-banner items between consecutive banner Y-ranges into Y-rows for structural splitting
      bannerEvents.sort((a, b) => a.y - b.y);

      // Operator B: On a new page, reset persistent sideBySide if page starts with full-width content before any dual-track banner
      if (pageLoopIdx > 0 && sideBySide) {
        const firstNonFullEv = bannerEvents.find(
          (ev) => ev.kind === 'pair' || ev.kind === 'twoTier' || ev.kind === 'singleTrack'
        );
        const firstFullEv = bannerEvents.find((ev) => ev.kind === 'full');
        const fullBannerFirst =
          Boolean(firstFullEv) && (!firstNonFullEv || firstFullEv!.y < firstNonFullEv.y);
        const leadingCutoffY = firstNonFullEv ? firstNonFullEv.y : Infinity;
        const hasLeadingFullCrossing = nonBannerItems.some(
          (it) =>
            it.y + it.height / 2 < leadingCutoffY &&
            (it.kind === 'text' || it.kind === 'rect') &&
            it.width >= maxBudgetWidthIn * 0.68 &&
            it.x < gutterXIn - ptToIn(10) &&
            it.x + it.width > gutterXIn + ptToIn(10)
        );
        if (fullBannerFirst || hasLeadingFullCrossing) {
          flushAllSideBySide();
        }
      }

      const detectWhitespaceGutter = (segmentItems: PositionedItem[]): number | undefined => {
        if (activeFull && activeFull.track === 'full' && activeFull.banner?.isFullWidth) {
          return undefined;
        }
        if (segmentItems.some((it) => it.width >= maxBudgetWidthIn * 0.68)) {
          return undefined;
        }
        const contentItems = segmentItems.filter((it) => it.kind === 'text' || it.kind === 'image');
        if (contentItems.length < 6) return undefined;
        const narrowItems = segmentItems.filter(
          (it) =>
            (it.kind === 'text' || it.kind === 'image' || (it.kind === 'rect' && it.height >= 0.15)) &&
            it.width < maxBudgetWidthIn * 0.62
        );
        if (narrowItems.length < 6) return undefined;

        const enclosedTrackRects = segmentItems.filter(
          (it) => it.kind === 'rect' && it.height >= 0.35 && it.width < maxBudgetWidthIn * 0.62
        );
        const segVLines = segmentItems.filter(
          (it) => it.kind === 'line' && it.width <= ptToIn(3.5) && it.height >= ptToIn(28)
        );
        if (enclosedTrackRects.length < 2 && segVLines.length < 3) return undefined;

        const xIntervals = narrowItems
          .map((it) => ({ x1: it.x, x2: it.x + it.width }))
          .sort((a, b) => a.x1 - b.x1);
        if (xIntervals.length === 0) return undefined;

        const mergedX: Array<{ x1: number; x2: number }> = [{ ...xIntervals[0] }];
        for (let i = 1; i < xIntervals.length; i++) {
          const cur = xIntervals[i];
          const prev = mergedX[mergedX.length - 1];
          if (cur.x1 <= prev.x2 + ptToIn(4)) {
            prev.x2 = Math.max(prev.x2, cur.x2);
          } else {
            mergedX.push({ ...cur });
          }
        }

        const minGutterW = ptToIn(Math.max(6, weights.minCenterGutterPt));
        let bestGutter: { center: number; width: number } | undefined;
        for (let i = 0; i < mergedX.length - 1; i++) {
          const gapLeft = mergedX[i].x2;
          const gapRight = mergedX[i + 1].x1;
          const gutterW = gapRight - gapLeft;
          const center = (gapLeft + gapRight) / 2;
          if (gutterW < minGutterW || center < maxBudgetWidthIn * 0.25 || center > maxBudgetWidthIn * 0.75) {
            continue;
          }
          const crossing = segmentItems.some(
            (it) =>
              it.x < center - ptToIn(2) &&
              it.x + it.width > center + ptToIn(2)
          );
          if (crossing) continue;

          if (enclosedTrackRects.length >= 2) {
            const leftBoxes = enclosedTrackRects.filter((rc) => rc.x + rc.width <= center + ptToIn(2));
            const rightBoxes = enclosedTrackRects.filter((rc) => rc.x >= center - ptToIn(2));
            if (leftBoxes.length === 0 || rightBoxes.length === 0) continue;
            const maxLeftX2 = Math.max(...leftBoxes.map((b) => b.x + b.width));
            const minRightX1 = Math.min(...rightBoxes.map((b) => b.x));
            if (minRightX1 - maxLeftX2 < ptToIn(weights.minCenterGutterPt)) continue;
          } else {
            const leftVLines = segVLines.filter((vl) => vl.x <= center - ptToIn(3));
            const rightVLines = segVLines.filter((vl) => vl.x >= center + ptToIn(3));
            if (leftVLines.length < 2 || rightVLines.length < 2) continue;
            const x1L = Math.max(...leftVLines.map((vl) => vl.x));
            const x0R = Math.min(...rightVLines.map((vl) => vl.x));
            if (x0R - x1L < ptToIn(weights.minCenterGutterPt)) continue;
          }

          const leftCount = contentItems.filter((it) => it.x < center).length;
          const rightCount = contentItems.filter((it) => it.x >= center).length;
          if (leftCount >= 3 && rightCount >= 3 && (!bestGutter || gutterW > bestGutter.width)) {
            bestGutter = { center: roundIn(center), width: gutterW };
          }
        }
        return bestGutter?.center;
      };

      // Operator A: Detect a localized twin side-by-side grid Y-band inside a single-track segment
      // (even when activeFull has a full-width FillBanner above it).
      const detectTwinSubTableBand = (
        segmentItems: PositionedItem[]
      ): { yMin: number; yMax: number; gutterX: number } | undefined => {
        if (segmentItems.length < 6) return undefined;
        const minGutterIn = ptToIn(Math.max(6, weights.minCenterGutterPt));

        // 1. Honor explicit Layer 6 splitTwinSubTables constraint if present
        const forcedTwin = (constraints.splitTwinSubTables ?? []).find((st) => st.pageNumber === pNum);
        if (forcedTwin) {
          const yMin = Math.max(0, ptToIn(forcedTwin.yMinPt) - bodyTopOriginIn);
          const yMax = Math.max(yMin + ptToIn(12), ptToIn(forcedTwin.yMaxPt) - bodyTopOriginIn);
          const center = clamp(ptToIn(forcedTwin.gutterXPt), maxBudgetWidthIn * 0.25, maxBudgetWidthIn * 0.75);
          const bandItems = segmentItems.filter((it) => {
            const cy = it.y + it.height / 2;
            return cy >= yMin - ptToIn(2) && cy <= yMax + ptToIn(2);
          });
          const crossing = bandItems.some(
            (it) => it.x < center - ptToIn(2) && it.x + it.width > center + ptToIn(2)
          );
          if (!crossing && bandItems.some((it) => it.x + it.width / 2 < center) && bandItems.some((it) => it.x + it.width / 2 >= center)) {
            return { yMin, yMax, gutterX: roundIn(center) };
          }
        }

        // 2. Purely geometric twin-grid cluster detection via VLines & bordered/shaded cell rects
        const gridElems = segmentItems.filter(
          (it) =>
            (it.kind === 'line' && it.width <= ptToIn(3.5) && it.height >= ptToIn(14)) ||
            (it.kind === 'rect' &&
              it.width >= ptToIn(12) &&
              it.width < maxBudgetWidthIn * 0.46 &&
              it.height >= ptToIn(10) &&
              Boolean(it.region.style.borderColor || it.region.style.backgroundColor))
        );
        if (gridElems.length < 4) return undefined;

        const minY = Math.min(...gridElems.map((g) => g.y));
        const maxY = Math.max(...gridElems.map((g) => g.y + g.height));
        const yRows = groupItemsIntoYRows(segmentItems);

        // Trim band bottom/top strictly to rows that do NOT cross the center gutter
        const twinElemsX = gridElems
          .map((it) => ({ x1: it.x, x2: it.x + it.width }))
          .sort((a, b) => a.x1 - b.x1);
        const mergedG: Array<{ x1: number; x2: number }> = [{ ...twinElemsX[0] }];
        for (let i = 1; i < twinElemsX.length; i++) {
          const cur = twinElemsX[i];
          const prev = mergedG[mergedG.length - 1];
          if (cur.x1 <= prev.x2 + ptToIn(4)) {
            prev.x2 = Math.max(prev.x2, cur.x2);
          } else {
            mergedG.push({ ...cur });
          }
        }

        for (let i = 0; i < mergedG.length - 1; i++) {
          const gapLeft = mergedG[i].x2;
          const gapRight = mergedG[i + 1].x1;
          if (gapRight - gapLeft < minGutterIn) continue;
          const center = (gapLeft + gapRight) / 2;
          if (center < maxBudgetWidthIn * 0.25 || center > maxBudgetWidthIn * 0.75) continue;

          // Include non-crossing title rows immediately above the twin grid (<= 22pt above minY)
          let bandTop = minY;
          for (let r = yRows.length - 1; r >= 0; r--) {
            const ry = yRows[r].y;
            if (ry >= minY) continue;
            if (minY - ry > ptToIn(24)) break;
            const rowCrosses = yRows[r].items.some(
              (it) => it.x < center - ptToIn(2) && it.x + it.width > center + ptToIn(2)
            );
            const hasBothSides =
              yRows[r].items.some((it) => it.x + it.width / 2 < center) &&
              yRows[r].items.some((it) => it.x + it.width / 2 >= center);
            if (!rowCrosses && hasBothSides) {
              bandTop = Math.min(bandTop, ry);
            } else {
              break;
            }
          }

          // Walk rows intersecting [bandTop, maxY] and verify zero crossing items
          const candItems = segmentItems.filter((it) => {
            const cy = it.y + it.height / 2;
            return cy >= bandTop - ptToIn(2) && cy <= maxY + ptToIn(2);
          });
          const anyCrossing = candItems.some(
            (it) => it.x < center - ptToIn(2) && it.x + it.width > center + ptToIn(2)
          );
          if (anyCrossing) continue;

          const leftElems = gridElems.filter((g) => g.x + g.width <= center + ptToIn(1));
          const rightElems = gridElems.filter((g) => g.x >= center - ptToIn(1));
          const leftTexts = candItems.filter((it) => it.kind === 'text' && it.x + it.width / 2 < center);
          const rightTexts = candItems.filter((it) => it.kind === 'text' && it.x + it.width / 2 >= center);

          if (leftElems.length >= 2 && rightElems.length >= 2 && leftTexts.length >= 2 && rightTexts.length >= 2) {
            return {
              yMin: bandTop - ptToIn(1),
              yMax: maxY + ptToIn(1),
              gutterX: roundIn(center),
            };
          }
        }
        return undefined;
      };

      const classifyBandTopology = (bandItems: PositionedItem[]): 'multiGrid' | 'narrative' => {
        const bandRows = groupItemsIntoYRows(bandItems);
        const multiColRows = bandRows.filter((r) => r.textItems.length >= 3).length;
        return multiColRows >= 2 ? 'multiGrid' : 'narrative';
      };

      const processBandRows = (
        bandItems: PositionedItem[],
        isDividerBoundedBand: boolean
      ) => {
        const rows = groupItemsIntoYRows(bandItems);

        for (let rIdx = 0; rIdx < rows.length; rIdx++) {
          const row = rows[rIdx];
          const remainingRows = rows.slice(rIdx);

          // Structural Exception (a): Post-Table Footnote Split
          if (!sideBySide && activeFull && !activeFull.isFootnote && countDenseRows(activeFull.items) >= 3) {
            const allRemainingAreWideNotes =
              remainingRows.length >= 1 &&
              remainingRows.every((rr) => {
                if (rr.textItems.length === 0) return true;
                if (rr.textItems.length > 2) return false;
                const minX = Math.min(...rr.textItems.map((t) => t.x));
                const maxX = Math.max(...rr.textItems.map((t) => t.x + t.width));
                const totalSpan = maxX - minX;
                const firstTxt = (rr.textItems[0].region.text ?? '').trim();
                const isNoteHeading =
                  rr.textItems.length === 1 &&
                  firstTxt.length <= 45 &&
                  (rr.textItems[0].region.style.bold || firstTxt.endsWith(':'));
                const isWideBody = totalSpan >= maxBudgetWidthIn * 0.75;
                return isNoteHeading || isWideBody;
              }) &&
              remainingRows.some((rr) => {
                if (rr.textItems.length === 0 || rr.textItems.length > 2) return false;
                const minX = Math.min(...rr.textItems.map((t) => t.x));
                const maxX = Math.max(...rr.textItems.map((t) => t.x + t.width));
                return maxX - minX >= maxBudgetWidthIn * 0.75;
              });

            if (allRemainingAreWideNotes) {
              flushFull();
              const firstTitle = (row.textItems[0]?.region.text ?? 'Notes').trim();
              activeFull = {
                semanticName: makeFullName(firstTitle, pNum),
                track: 'full',
                leftIn: 0,
                widthIn: maxBudgetWidthIn,
                pageNumber: pNum,
                pageBreakBefore: false,
                isFootnote: true,
                items: remainingRows.flatMap((rr) =>
                  rr.items.map((it) => ({ ...it, y: it.y + (pNum - 1) * 100 }))
                ),
              };
              break;
            }
          }

          // Route / Split inside SIDE_BY_SIDE_MODE vs Full-Width mode
          if (sideBySide) {
            const hasFullWidthCrossing = row.items.some(
              (it) =>
                (it.kind === 'text' || it.kind === 'rect') &&
                it.x < gutterXIn - ptToIn(10) &&
                it.x + it.width > gutterXIn + ptToIn(10) &&
                it.width >= maxBudgetWidthIn * 0.68
            );
            if (hasFullWidthCrossing) {
              flushAllSideBySide();
            }
          }

          if (sideBySide) {
            // Operator B: Strict horizontal center (cx) track isolation around gutterXIn
            const leftRowItems = row.items.filter((it) => it.x + it.width / 2 < gutterXIn);
            const rightRowItems = row.items.filter((it) => it.x + it.width / 2 >= gutterXIn);
            const bounds = computeTrackBounds(gutterXIn);

            const handleTrackRow = (
              trackSide: 'left' | 'right',
              trackItems: PositionedItem[]
            ) => {
              if (trackItems.length === 0) return;
              const trackText = trackItems.filter((i) => i.kind === 'text');
              const activeTrack = trackSide === 'left' ? activeLeft : activeRight;
              const isSubGroupHeader = isBoldGroupHeadingRow({ textItems: trackText });
              const trackHasContainerLock =
                Boolean(activeTrack?.banner) ||
                (activeTrack?.items.some(
                  (it) => it.kind === 'rect' && it.width >= (activeTrack?.widthIn ?? maxBudgetWidthIn) * 0.78 && it.height >= ptToIn(80)
                ) ?? false);

              if (!trackHasContainerLock && isSubGroupHeader && activeTrack && countDenseRows(activeTrack.items) < 3) {
                const priorRows = groupItemsIntoYRows(activeTrack.items);
                const futureTrackRows = rows
                  .slice(rIdx + 1)
                  .map((fr) =>
                    fr.items.filter((it) =>
                      trackSide === 'left' ? it.x + it.width / 2 < gutterXIn : it.x + it.width / 2 >= gutterXIn
                    )
                  )
                  .filter((arr) => arr.length > 0);
                if (priorRows.length >= 2 && futureTrackRows.length >= 2) {
                  const hdrText = (trackText[0].region.text ?? '').trim();
                  if (trackSide === 'left') {
                    flushLeft();
                    activeLeft = {
                      semanticName: makeTrackName('Left', hdrText),
                      track: 'left',
                      leftIn: 0,
                      widthIn: bounds.leftWidth,
                      pageNumber: pNum,
                      pageBreakBefore: false,
                      items: trackItems.map((it) => ({ ...it, y: it.y + (pNum - 1) * 100 })),
                    };
                  } else {
                    flushRight();
                    activeRight = {
                      semanticName: makeTrackName('Right', hdrText),
                      track: 'right',
                      leftIn: bounds.rightLeft,
                      widthIn: bounds.rightWidth,
                      pageNumber: pNum,
                      pageBreakBefore: false,
                      items: trackItems.map((it) => ({ ...it, y: it.y + (pNum - 1) * 100 })),
                    };
                  }
                  return;
                }
              }

              if (trackSide === 'left') {
                if (!activeLeft) {
                  activeLeft = {
                    semanticName: makeTrackName('Left', `Page${pNum}`),
                    track: 'left',
                    leftIn: 0,
                    widthIn: bounds.leftWidth,
                    pageNumber: pNum,
                    pageBreakBefore: false,
                    items: [],
                  };
                }
                activeLeft.items.push(...trackItems.map((it) => ({ ...it, y: it.y + (pNum - 1) * 100 })));
              } else {
                if (!activeRight) {
                  activeRight = {
                    semanticName: makeTrackName('Right', `Page${pNum}`),
                    track: 'right',
                    leftIn: bounds.rightLeft,
                    widthIn: bounds.rightWidth,
                    pageNumber: pNum,
                    pageBreakBefore: false,
                    items: [],
                  };
                }
                activeRight.items.push(...trackItems.map((it) => ({ ...it, y: it.y + (pNum - 1) * 100 })));
              }
            };

            handleTrackRow('left', leftRowItems);
            handleTrackRow('right', rightRowItems);
          } else {
            const fullHasContainerLock =
              Boolean(activeFull?.banner) ||
              isDividerBoundedBand ||
              (activeFull?.items.some(
                (it) => it.kind === 'rect' && it.width >= maxBudgetWidthIn * 0.78 && it.height >= ptToIn(80)
              ) ?? false);

            if (
              !fullHasContainerLock &&
              activeFull &&
              !activeFull.isFootnote &&
              countDenseRows(activeFull.items) < 3 &&
              isBoldGroupHeadingRow(row)
            ) {
              const priorRows = groupItemsIntoYRows(activeFull.items);
              const futureRows = rows.slice(rIdx + 1);
              let subBlockRowCount = 0;
              for (const fr of futureRows) {
                if (isBoldGroupHeadingRow(fr)) break;
                subBlockRowCount++;
              }
              const priorHasStructure =
                priorRows.length >= 2 &&
                (priorRows.some((pr) => pr.textItems.length >= 2) || priorRows.length >= 3);
              if (priorHasStructure && subBlockRowCount >= 2) {
                const hdrText = (row.textItems[0].region.text ?? '').trim();
                flushFull();
                activeFull = {
                  semanticName: makeFullName(hdrText, pNum),
                  track: 'full',
                  leftIn: 0,
                  widthIn: maxBudgetWidthIn,
                  pageNumber: pNum,
                  pageBreakBefore: false,
                  items: row.items.map((it) => ({ ...it, y: it.y + (pNum - 1) * 100 })),
                };
                continue;
              }
            }

            if (!activeFull) {
              activeFull = {
                semanticName: makeFullName(undefined, pNum),
                track: 'full',
                leftIn: 0,
                widthIn: maxBudgetWidthIn,
                pageNumber: pNum,
                pageBreakBefore: false,
                items: [],
              };
            }
            activeFull.items.push(
              ...row.items.map((it) => ({ ...it, y: it.y + (pNum - 1) * 100 }))
            );
          }
        }
      };

      const processNonBannerSegment = (segmentItems: PositionedItem[]) => {
        if (segmentItems.length === 0) return;

        // Operator A: Split localized twin side-by-side grid Y-bands into Tablix_Left + Tablix_Right
        if (!sideBySide) {
          const twinBand = detectTwinSubTableBand(segmentItems);
          if (twinBand) {
            const beforeTwin = segmentItems.filter((it) => it.y + it.height / 2 < twinBand.yMin);
            const twinItems = segmentItems.filter((it) => {
              const cy = it.y + it.height / 2;
              return cy >= twinBand.yMin && cy <= twinBand.yMax;
            });
            const afterTwin = segmentItems.filter((it) => it.y + it.height / 2 > twinBand.yMax);

            if (beforeTwin.length > 0) {
              processNonBannerSegment(beforeTwin);
            }
            flushFull();
            sideBySide = true;
            gutterXIn = twinBand.gutterX;
            const bounds = computeTrackBounds(gutterXIn);
            activeLeft = {
              semanticName: makeTrackName('Left', `Grid_P${pNum}`),
              track: 'left',
              leftIn: 0,
              widthIn: bounds.leftWidth,
              pageNumber: pNum,
              pageBreakBefore: false,
              pairedStart: true,
              items: [],
            };
            activeRight = {
              semanticName: makeTrackName('Right', `Grid_P${pNum}`),
              track: 'right',
              leftIn: bounds.rightLeft,
              widthIn: bounds.rightWidth,
              pageNumber: pNum,
              pageBreakBefore: false,
              pairedStart: true,
              items: [],
            };
            processBandRows(twinItems, false);
            flushAllSideBySide();

            if (afterTwin.length > 0) {
              processNonBannerSegment(afterTwin);
            }
            return;
          }
        }

        if (!sideBySide) {
          const detectedGutter = detectWhitespaceGutter(segmentItems);
          if (detectedGutter !== undefined) {
            flushFull();
            sideBySide = true;
            gutterXIn = detectedGutter;
            const bounds = computeTrackBounds(gutterXIn);
            activeLeft = {
              semanticName: makeTrackName('Left', `Page${pNum}`),
              track: 'left',
              leftIn: 0,
              widthIn: bounds.leftWidth,
              pageNumber: pNum,
              pageBreakBefore: false,
              pairedStart: true,
              items: [],
            };
            activeRight = {
              semanticName: makeTrackName('Right', `Page${pNum}`),
              track: 'right',
              leftIn: bounds.rightLeft,
              widthIn: bounds.rightWidth,
              pageNumber: pNum,
              pageBreakBefore: false,
              pairedStart: true,
              items: [],
            };
          }
        }

        if (!sideBySide) {
          const forcedPageSplits = constraints.forceTablixSplitsY
            .filter((fs) => fs.pageNumber === pNum)
            .map((fs) => Math.max(0, ptToIn(fs.yPt) - bodyTopOriginIn));
          const dividerLines = segmentItems.filter(
            (it) =>
              (it.kind === 'line' || it.kind === 'rect') &&
              it.height <= ptToIn(3.5) &&
              it.width >= maxBudgetWidthIn * weights.hDividerMinWidthRatio
          );
          const allSplitYs = [
            ...dividerLines.map((d) => d.y),
            ...forcedPageSplits,
          ];
          if (allSplitYs.length > 0) {
            const dividerYs = clusterValues(allSplitYs, ptToIn(4));
            const subBands: PositionedItem[][] = [];
            let prevCut = -Infinity;
            for (const dy of dividerYs) {
              const band = segmentItems.filter(
                (it) => it.y >= prevCut && it.y < dy - ptToIn(1) && !dividerLines.includes(it)
              );
              if (band.length > 0) subBands.push(band);
              prevCut = dy - ptToIn(1);
            }
            const tailBand = segmentItems.filter(
              (it) => it.y >= prevCut && !dividerLines.includes(it)
            );
            if (tailBand.length > 0) subBands.push(tailBand);

            if (subBands.length >= 2) {
              let prevTopo: 'multiGrid' | 'narrative' | null = activeFull?.items.length
                ? classifyBandTopology(activeFull.items)
                : null;
              for (let sbIdx = 0; sbIdx < subBands.length; sbIdx++) {
                const subBand = subBands[sbIdx];
                const curTopo = classifyBandTopology(subBand);
                const isForcedCut = forcedPageSplits.length > 0;
                if (sbIdx > 0 && (isForcedCut || (prevTopo && (curTopo !== prevTopo || prevTopo === 'multiGrid')))) {
                  flushFull();
                }
                processBandRows(subBand, dividerLines.length > 0 && !isForcedCut);
                prevTopo = curTopo;
              }
              return;
            }
          }
        }

        processBandRows(segmentItems, false);
      };

      // Hard FillBanner vertical fence: strictly partition nonBannerItems around every banner by cy < ev.y
      let remainingItems = [...nonBannerItems];
      for (const ev of bannerEvents) {
        const beforeItems: PositionedItem[] = [];
        const afterItems: PositionedItem[] = [];
        const evBot =
          ev.kind === 'twoTier'
            ? Math.max(ev.topBanner.y + ev.topBanner.height, ev.left.y + ev.left.height, ev.right.y + ev.right.height)
            : ev.kind === 'pair'
              ? Math.max(ev.left.y + ev.left.height, ev.right.y + ev.right.height)
              : ev.banner.y + ev.banner.height;
        const evXMin =
          ev.kind === 'singleTrack' ? ev.banner.x : 0;
        const evXMax =
          ev.kind === 'singleTrack' ? ev.banner.x + ev.banner.width : maxBudgetWidthIn;

        for (const it of remainingItems) {
          const cy = it.y + it.height / 2;
          const cx = it.x + it.width / 2;
          if (cy < ev.y - ptToIn(0.5)) {
            beforeItems.push(it);
          } else if (
            cy <= evBot + ptToIn(1.5) &&
            cx >= evXMin - ptToIn(3) &&
            cx <= evXMax + ptToIn(3) &&
            it.kind === 'text'
          ) {
            // Drop residual/duplicate text centered strictly inside the banner fill box
            continue;
          } else {
            afterItems.push(it);
          }
        }
        remainingItems = afterItems;
        processNonBannerSegment(beforeItems);

        if (ev.kind === 'full') {
          flushAllSideBySide();
          flushFull();
          activeFull = {
            semanticName: makeFullName(ev.banner.titleText, pNum),
            track: 'full',
            leftIn: 0,
            widthIn: maxBudgetWidthIn,
            pageNumber: pNum,
            pageBreakBefore: false,
            banner: ev.banner,
            items: [],
          };
        } else if (ev.kind === 'twoTier') {
          flushAllSideBySide();
          flushFull();
          blocks.push({
            semanticName: makeFullName(ev.topBanner.titleText, pNum),
            track: 'full',
            leftIn: 0,
            widthIn: maxBudgetWidthIn,
            pageNumber: pNum,
            pageBreakBefore: false,
            isBannerOnly: true,
            banner: ev.topBanner,
            items: [],
          });
          sideBySide = true;
          gutterXIn = roundIn((ev.left.x + ev.left.width + ev.right.x) / 2);
          const bounds = computeTrackBounds(gutterXIn);
          activeLeft = {
            semanticName: makeTrackName('Left', ev.left.titleText),
            track: 'left',
            leftIn: 0,
            widthIn: bounds.leftWidth,
            pageNumber: pNum,
            pageBreakBefore: false,
            pairedStart: true,
            banner: ev.left,
            items: [],
          };
          activeRight = {
            semanticName: makeTrackName('Right', ev.right.titleText),
            track: 'right',
            leftIn: bounds.rightLeft,
            widthIn: bounds.rightWidth,
            pageNumber: pNum,
            pageBreakBefore: false,
            pairedStart: true,
            banner: ev.right,
            items: [],
          };
        } else if (ev.kind === 'pair') {
          flushAllSideBySide();
          flushFull();
          sideBySide = true;
          gutterXIn = roundIn((ev.left.x + ev.left.width + ev.right.x) / 2);
          const bounds = computeTrackBounds(gutterXIn);
          activeLeft = {
            semanticName: makeTrackName('Left', ev.left.titleText),
            track: 'left',
            leftIn: 0,
            widthIn: bounds.leftWidth,
            pageNumber: pNum,
            pageBreakBefore: false,
            pairedStart: true,
            banner: ev.left,
            items: [],
          };
          activeRight = {
            semanticName: makeTrackName('Right', ev.right.titleText),
            track: 'right',
            leftIn: bounds.rightLeft,
            widthIn: bounds.rightWidth,
            pageNumber: pNum,
            pageBreakBefore: false,
            pairedStart: true,
            banner: ev.right,
            items: [],
          };
        } else if (ev.kind === 'singleTrack') {
          const b = ev.banner;
          const cx = b.x + b.width / 2;
          if (!sideBySide) {
            flushFull();
            sideBySide = true;
            gutterXIn = maxBudgetWidthIn / 2;
          }
          const bounds = computeTrackBounds(gutterXIn);
          if (cx < gutterXIn) {
            flushLeft();
            activeLeft = {
              semanticName: makeTrackName('Left', b.titleText),
              track: 'left',
              leftIn: 0,
              widthIn: bounds.leftWidth,
              pageNumber: pNum,
              pageBreakBefore: false,
              banner: b,
              items: [],
            };
          } else {
            flushRight();
            activeRight = {
              semanticName: makeTrackName('Right', b.titleText),
              track: 'right',
              leftIn: bounds.rightLeft,
              widthIn: bounds.rightWidth,
              pageNumber: pNum,
              pageBreakBefore: false,
              banner: b,
              items: [],
            };
          }
        }
      }

      if (remainingItems.length > 0) {
        processNonBannerSegment(remainingItems);
      }

      if (activeFull?.isFootnote) {
        flushFull();
      }
    }

    flushAllSideBySide();
    flushFull();

    // Enforce Single <PageBreak> Rule per page > 1:
    // - Never emit <PageBreak> on a right-track Tablix
    // - Ensure the first full or left-track Tablix on page > 1 carries pageBreakBefore = true
    //   and appears before any right-track Tablix on that same page.
    const seenPages = new Set<number>();
    const normalizedBlocks: LogicalSegmentBlock[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const blk = blocks[i];
      if (blk.track === 'right') {
        blk.pageBreakBefore = false;
      }
    }
    const pageGroups = new Map<number, LogicalSegmentBlock[]>();
    for (const blk of blocks) {
      const list = pageGroups.get(blk.pageNumber) ?? [];
      list.push(blk);
      pageGroups.set(blk.pageNumber, list);
    }
    const sortedPageNums = Array.from(pageGroups.keys()).sort((a, b) => a - b);
    for (const pNum of sortedPageNums) {
      const pBlocks = pageGroups.get(pNum)!;
      if (seenPages.size > 0) {
        const firstAnchorIdx = pBlocks.findIndex((b) => b.track === 'full' || b.track === 'left');
        if (firstAnchorIdx > 0 && pBlocks[0].track === 'right') {
          const [anchor] = pBlocks.splice(firstAnchorIdx, 1);
          pBlocks.unshift(anchor);
        }
        const breakTarget = pBlocks.find((b) => b.track === 'full' || b.track === 'left');
        if (breakTarget) {
          breakTarget.pageBreakBefore = true;
        }
      }
      seenPages.add(pNum);
      normalizedBlocks.push(...pBlocks);
    }

    return normalizedBlocks;
  }

  private compileFlatMasterGridTablix(
    tablixName: string,
    block: LogicalSegmentBlock,
    topIn: number,
    dataSetName: string,
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string,
    nextUniqueName: (prefix: string) => string,
    pagePrimitives: ExtractedVectorPrimitive[] = [],
    bodyTopOriginIn = 0,
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS,
    constraints: CalibrationConstraints = { forbidColumnSplits: [], forceTablixSplitsY: [], forceRowSplitsY: [] }
  ): TablixRegion {
    const blockLeft = block.leftIn;
    const blockW = roundIn(Math.max(0.5, block.widthIn));
    const { pageWeights, override: pageOverride } = resolvePageCompilerWeights(
      weights,
      constraints,
      block.pageNumber
    );

    // Normalize all items relative to blockLeft
    const relItems: PositionedItem[] = block.items.map((it) => ({
      ...it,
      x: Math.max(0, it.x - blockLeft),
      width: Math.min(blockW - Math.max(0, it.x - blockLeft), it.width),
    }));

    const containerKey =
      block.containerKey ??
      `P${block.pageNumber}:${block.track}:${Math.round(inToPt(blockLeft))}:${Math.round(inToPt(topIn))}`;

    // Banner-only 1-row full-width header block (e.g. Two-tier top banner)
    if (block.isBannerOnly && block.banner && relItems.length === 0) {
      const bannerCell = this.buildBannerTextboxCell(
        block.banner,
        0,
        0,
        1,
        nextUniqueName,
        pageWeights
      );
      const bannerStyle = bannerCell.content.kind === 'Textbox' ? bannerCell.content.style : defaultTextStyle(9.5, pageWeights);
      const minBannerH = pageOverride?.minRowHeightPt ?? 14;
      const bannerH = roundIn(
        Math.max(
          ptToIn(minBannerH),
          block.banner.height,
          ptToIn(
            estimateWrappedRowHeightPt(
              [{ text: block.banner.titleText, style: bannerStyle, coveredWidthPt: inToPt(blockW) }],
              minBannerH,
              pageWeights
            )
          )
        )
      );
      return {
        id: tablixName,
        name: tablixName,
        pageNumber: block.pageNumber,
        sourcePageIndex: block.pageNumber - 1,
        bandKind: 'Detail',
        containerKey,
        solverStrategy: block.track === 'full' ? 'INDENTATION_CLAUSE_SOLVER' : 'DUAL_TRACK_STREAM_SOLVER',
        pageBreakBefore: block.pageBreakBefore,
        keepTogether: false,
        topIn: roundIn(topIn),
        leftIn: roundIn(blockLeft),
        widthIn: blockW,
        heightIn: bannerH,
        dataSetName,
        isRepeatingDetail: false,
        columnWidthsIn: [blockW],
        rows: [
          {
            heightIn: bannerH,
            isDetailRow: false,
            cells: [bannerCell],
          },
        ],
        zIndex: 1,
      };
    }

    // Footnote 2-column Tablix (MarkerColumn + ContentColumn) — DENSITY_TRANSITION_SPLITTER
    if (block.isFootnote) {
      const fnTablix = this.compileFootnoteTablix(
        tablixName,
        block,
        relItems,
        topIn,
        dataSetName,
        nextUniqueName,
        pageWeights,
        pageOverride
      );
      return {
        ...fnTablix,
        sourcePageIndex: block.pageNumber - 1,
        containerKey,
        solverStrategy: 'DENSITY_TRANSITION_SPLITTER',
        geometricSignature: {
          internalVLineCount: 0,
          shadedRowBandCount: 0,
          hasEmbeddedSubGrid: false,
          indentationLevels: 2,
          operatorColumnCount: 0,
          columnDensityDrop: true,
        },
      };
    }

    // Separate structural vector rects from content items and isolate full-section outer perimeter frames
    const rectItems = relItems.filter(
      (it) =>
        it.kind === 'rect' &&
        it.width >= ptToIn(8) &&
        it.height >= ptToIn(8) &&
        Boolean(it.region.style.backgroundColor || it.region.style.borderColor)
    );
    const contentItems = relItems.filter((it) => it.kind === 'text' || it.kind === 'image');
    const lineItems = relItems.filter((it) => it.kind === 'line');
    const contentSpanY =
      contentItems.length > 0
        ? Math.max(...contentItems.map((i) => i.y + i.height)) - Math.min(...contentItems.map((i) => i.y))
        : 0;

    // Relative RowFillBands from RLE/Vector primitives inside this block's X bounds
    const blockMinY = contentItems.length > 0 ? Math.min(...contentItems.map((i) => i.y)) - ptToIn(4) : 0;
    const blockMaxY = contentItems.length > 0 ? Math.max(...contentItems.map((i) => i.y + i.height)) + ptToIn(4) : Infinity;
    const yPageShift = (block.pageNumber - 1) * 100;
    const rowFillBandsRel = pagePrimitives
      .filter(
        (pr) =>
          pr.kind === 'RowFillBand' &&
          pr.x + pr.width > blockLeft + ptToIn(4) &&
          pr.x < blockLeft + blockW - ptToIn(4) &&
          pr.y + yPageShift >= blockMinY &&
          pr.y + yPageShift <= blockMaxY
      )
      .map((pr) => ({
        yTop: pr.y + yPageShift,
        yBottom: pr.y + pr.height + yPageShift,
      }));

    const outerFrameRects = rectItems.filter((rc) => {
      if (rc.width < blockW * 0.80 || rc.height < Math.max(ptToIn(85), contentSpanY * 0.55)) {
        return false;
      }
      const innerCellRects = rectItems.filter(
        (other) =>
          other !== rc &&
          other.width < rc.width * 0.75 &&
          other.x >= rc.x - ptToIn(2) &&
          other.x + other.width <= rc.x + rc.width + ptToIn(2) &&
          other.y >= rc.y - ptToIn(2) &&
          other.y + other.height <= rc.y + rc.height + ptToIn(2)
      );
      const innerVLines = lineItems.filter(
        (ln) =>
          ln.width <= ptToIn(3) &&
          ln.height >= ptToIn(18) &&
          ln.x >= rc.x + ptToIn(6) &&
          ln.x <= rc.x + rc.width - ptToIn(6) &&
          ln.y >= rc.y - ptToIn(2) &&
          ln.y + ln.height <= rc.y + rc.height + ptToIn(2)
      );
      return innerCellRects.length < 2 && innerVLines.length < 2;
    });
    const outerFrameSet = new Set(outerFrameRects);
    const tableRects = rectItems.filter((rc) => !outerFrameSet.has(rc));

    // Layer 3 Portfolio: Extract pure geometric signature & route to specialized solver
    const signature = this.extractContainerSignature(
      contentItems,
      tableRects,
      lineItems,
      rowFillBandsRel,
      blockW,
      contentSpanY,
      Boolean(block.isFootnote),
      weights
    );
    const blockX0Pt = inToPt(block.leftIn);
    const blockX1Pt = inToPt(block.leftIn + block.widthIn);
    const blockY0Pt =
      contentItems.length > 0
        ? inToPt(Math.min(...contentItems.map((it) => it.y)))
        : 0;
    const blockY1Pt =
      contentItems.length > 0
        ? inToPt(Math.max(...contentItems.map((it) => it.y + it.height)))
        : blockY0Pt + inToPt(contentSpanY);

    const override = constraints.strategyOverrides?.find((o) => {
      if (o.pageNumber !== block.pageNumber) return false;
      if (o.containerKey === containerKey || o.containerKey === tablixName) return true;
      if (o.yRangePt && o.yRangePt.length === 2) {
        const yOverlap =
          Math.min(blockY1Pt, o.yRangePt[1]) - Math.max(blockY0Pt, o.yRangePt[0]);
        const minH = Math.max(8, Math.min(blockY1Pt - blockY0Pt, o.yRangePt[1] - o.yRangePt[0]));
        if (yOverlap / minH >= 0.35) {
          if (!o.xRangePt || o.xRangePt.length !== 2) return true;
          const xOverlap =
            Math.min(blockX1Pt, o.xRangePt[1]) - Math.max(blockX0Pt, o.xRangePt[0]);
          const minW = Math.max(12, Math.min(blockX1Pt - blockX0Pt, o.xRangePt[1] - o.xRangePt[0]));
          if (xOverlap / minW >= 0.35) return true;
        }
      }
      return false;
    });
    let selectedStrategy: SolverStrategy = override?.strategy ?? this.selectContainerStrategy(signature, tableRects.length);

    let logicalRows: LogicalRowBucket[];
    let atomicColBoundaries: number[];
    let isDataTable: boolean;

    const modeAResult =
      selectedStrategy === 'PLANAR_GRID_SOLVER'
        ? this.tryBuildModeAGrid(
            contentItems,
            tableRects,
            lineItems,
            rowFillBandsRel,
            blockW,
            contentSpanY,
            weights
          )
        : null;

    if (modeAResult) {
      logicalRows = modeAResult.logicalRows;
      atomicColBoundaries = modeAResult.atomicColBoundaries;
      isDataTable = true;
    } else {
      if (selectedStrategy === 'PLANAR_GRID_SOLVER') {
        selectedStrategy = signature.hasEmbeddedSubGrid
          ? 'KEY_VALUE_SUBGRID_FLATTENER'
          : signature.operatorColumnCount >= 2
            ? 'HLINE_OPERATOR_EQUATION_SOLVER'
            : 'INDENTATION_CLAUSE_SOLVER';
      }
      const preparedItems =
        selectedStrategy === 'HLINE_OPERATOR_EQUATION_SOLVER'
          ? this.splitOperatorAlignedTokens(contentItems, weights)
          : contentItems;
      const expandedContentItems = this.expandMultilineItems(preparedItems);
      const rawRows = this.clusterItemsIntoRows(expandedContentItems, tableRects, weights);
      const markedRows = this.splitClauseTitleRows(rawRows);
      const paraRows = this.reconstructParagraphBlocks(
        markedRows,
        tableRects,
        lineItems,
        blockW,
        block.pageNumber,
        bodyTopOriginIn,
        weights,
        constraints
      );
      logicalRows =
        selectedStrategy === 'KEY_VALUE_SUBGRID_FLATTENER' || signature.hasEmbeddedSubGrid
          ? this.compactEmbeddedSubTableZones(
              paraRows,
              tableRects,
              lineItems,
              blockW,
              contentSpanY,
              weights
            )
          : paraRows;
      atomicColBoundaries = this.buildAtomicMasterColumnGrid(
        logicalRows,
        tableRects,
        lineItems,
        blockW,
        blockLeft,
        block.pageNumber,
        bodyTopOriginIn,
        weights,
        constraints
      );
      isDataTable = this.detectStructuredDataTable(logicalRows, tableRects, Math.max(1, atomicColBoundaries.length - 1));
    }

    const numCols = Math.max(1, atomicColBoundaries.length - 1);
    const columnWidthsIn: number[] = [];
    for (let c = 0; c < numCols; c++) {
      columnWidthsIn.push(roundIn(Math.max(ptToIn(8), atomicColBoundaries[c + 1] - atomicColBoundaries[c])));
    }
    // Normalize widths to exact blockW
    const sumW = columnWidthsIn.reduce((s, w) => s + w, 0);
    if (sumW > 0 && Math.abs(sumW - blockW) > 0.001) {
      const scale = blockW / sumW;
      for (let c = 0; c < columnWidthsIn.length; c++) {
        columnWidthsIn[c] = roundIn(columnWidthsIn[c] * scale);
      }
      const drift = roundIn(blockW - columnWidthsIn.reduce((s, w) => s + w, 0));
      columnWidthsIn[columnWidthsIn.length - 1] = roundIn(
        Math.max(ptToIn(8), columnWidthsIn[columnWidthsIn.length - 1] + drift)
      );
    }

    const tablixRows: TablixRow[] = [];

    // Row 0: Banner Row (ColSpan = all columns, preserving extracted banner fill & contrasting text)
    if (block.banner) {
      const bannerRowCell = this.buildBannerTextboxCell(block.banner, 0, 0, numCols, nextUniqueName, pageWeights);
      const bannerStyle = bannerRowCell.content.kind === 'Textbox' ? bannerRowCell.content.style : defaultTextStyle(9.5, pageWeights);
      const minBannerH = pageOverride?.minRowHeightPt ?? 14;
      const bannerH = roundIn(
        Math.max(
          ptToIn(minBannerH),
          block.banner.height,
          ptToIn(
            estimateWrappedRowHeightPt(
              [{ text: block.banner.titleText, style: bannerStyle, coveredWidthPt: inToPt(blockW) }],
              minBannerH,
              pageWeights
            )
          )
        )
      );
      const cells: TablixCell[] = [];
      for (let c = 0; c < numCols; c++) {
        if (c === 0) {
          cells.push(bannerRowCell);
        } else {
          cells.push({
            colIndex: c,
            rowIndex: 0,
            colSpan: 1,
            rowSpan: 1,
            skipBecauseMerged: true,
            content: { kind: 'Empty', name: nextUniqueName('Empty') },
          });
        }
      }
      tablixRows.push({
        heightIn: bannerH,
        isDetailRow: false,
        cells,
      });
    }

    // Map each logical row onto the flat Master Column Grid (ordered top-to-bottom by Y).
    // Strict 1 Block = 1 Cell: never place two separate blocks into the same <TablixCell>.
    const orderedLogicalRows = [...logicalRows].sort((a, b) => a.yTop - b.yTop);
    const emittedLogicalRows: LogicalRowBucket[] = [];
    const pageForbiddenSplits = constraints.forbidColumnSplits.filter(
      (fc) => fc.pageNumber === block.pageNumber
    );
    const pageVLines = lineItems.filter((ln) => ln.width <= ptToIn(3) && ln.height >= ptToIn(8));
    const minRowHeightPt = pageOverride?.minRowHeightPt ?? 13.5;

    for (let rIdx = 0; rIdx < orderedLogicalRows.length; rIdx++) {
      const lr = orderedLogicalRows[rIdx];
      const pendingSlices: PositionedItem[][] = [[...lr.items].sort((a, b) => a.x - b.x)];

      while (pendingSlices.length > 0) {
        const sliceItems = pendingSlices.shift()!;
        if (sliceItems.length === 0) continue;

        const outRowIndex = tablixRows.length;
        const rowSlots: Array<{
          startCol: number;
          endCol: number;
          items: PositionedItem[];
          rect?: PositionedItem;
          centerAlign?: boolean;
        }> = [];
        const overflowItems: PositionedItem[] = [];

        for (const it of sliceItems) {
          const overrideSpan = lr.spanOverrides?.get(it);
          let { startCol, endCol } = overrideSpan
            ? overrideSpan
            : this.mapItemToAtomicSpan(
                it,
                atomicColBoundaries,
                numCols,
                sliceItems,
                isDataTable || Boolean(lr.isSubTableRow),
                lr.rects,
                pageWeights
              );

          const itemMinYPt = inToPt(it.region.y);
          const itemMaxYPt = inToPt(it.region.y + it.region.height);
          const itemAbsXMinPt = inToPt(blockLeft + it.x);
          const itemAbsXMaxPt = inToPt(blockLeft + it.x + it.width);
          const matchesForbiddenSplit = pageForbiddenSplits.some(
            (fc) =>
              itemMaxYPt >= fc.yMinPt - 4 &&
              itemMinYPt <= fc.yMaxPt + 4 &&
              itemAbsXMaxPt >= fc.xMinPt - 4 &&
              itemAbsXMinPt <= fc.xMaxPt + 4
          );
          if (matchesForbiddenSplit && !overrideSpan) {
            const matchingFc = pageForbiddenSplits.find(
              (fc) =>
                itemMaxYPt >= fc.yMinPt - 4 &&
                itemMinYPt <= fc.yMaxPt + 4 &&
                itemAbsXMaxPt >= fc.xMinPt - 4 &&
                itemAbsXMinPt <= fc.xMaxPt + 4
            );
            if (matchingFc) {
              const targetRightRelIn = Math.max(0, ptToIn(matchingFc.xMaxPt) - blockLeft);
              for (let c = startCol; c < numCols; c++) {
                if (targetRightRelIn > atomicColBoundaries[c] + ptToIn(2)) {
                  endCol = Math.max(endCol, c);
                }
              }
            }
          }

          const itemMidX = it.x + it.width / 2;
          const matchingRect =
            lr.rects.find((rc) => itemMidX >= rc.x - ptToIn(4) && itemMidX <= rc.x + rc.width + ptToIn(4)) ??
            lr.rects.find((rc) => it.x >= rc.x - ptToIn(5) && it.x < rc.x + rc.width - ptToIn(2));
          const exactCollision = rowSlots.find((s) => s.startCol === startCol);
          if (exactCollision) {
            // Keep 1 block = 1 cell: emit colliding block as its own subsequent row
            overflowItems.push(it);
            continue;
          }
          rowSlots.push({
            startCol,
            endCol,
            items: [it],
            rect: matchingRect,
            centerAlign: overrideSpan?.centerAlign,
          });
        }

        rowSlots.sort((a, b) => a.startCol - b.startCol);

        // Step 1 ColSpan recovery: extend slots across empty trailing columns when permitted
        if (pageOverride?.extendTrailingColSpan || pageForbiddenSplits.length > 0) {
          const rowMidY = (lr.yTop + lr.yBottom) / 2;
          for (let sIdx = 0; sIdx < rowSlots.length; sIdx++) {
            const sl = rowSlots[sIdx];
            const nextSl = rowSlots[sIdx + 1];
            const maxAllowedEnd = nextSl ? nextSl.startCol - 1 : numCols - 1;
            if (sl.endCol >= maxAllowedEnd) continue;
            if (sl.rect && sl.rect.width < blockW * 0.85) continue;

            const hasForbiddenOnSlot = sl.items.some((it) => {
              const minYPt = inToPt(it.region.y);
              const maxYPt = inToPt(it.region.y + it.region.height);
              return pageForbiddenSplits.some(
                (fc) => maxYPt >= fc.yMinPt - 4 && minYPt <= fc.yMaxPt + 4
              );
            });
            if (!pageOverride?.extendTrailingColSpan && !hasForbiddenOnSlot) continue;

            // Only extend across boundaries that have no explicit vertical divider at rowMidY
            let extendedEnd = sl.endCol;
            for (let c = sl.endCol + 1; c <= maxAllowedEnd; c++) {
              const boundaryX = atomicColBoundaries[c];
              const hasLocalVLine = pageVLines.some(
                (vl) =>
                  Math.abs(vl.x - boundaryX) <= ptToIn(3) &&
                  vl.y - ptToIn(2) <= rowMidY &&
                  rowMidY <= vl.y + vl.height + ptToIn(2)
              );
              const hasLocalRectWall = lr.rects.some(
                (rc) =>
                  rc.width < blockW * 0.85 &&
                  (Math.abs(rc.x - boundaryX) <= ptToIn(3) ||
                    Math.abs(rc.x + rc.width - boundaryX) <= ptToIn(3))
              );
              if (hasLocalVLine || hasLocalRectWall) break;
              extendedEnd = c;
            }
            sl.endCol = extendedEnd;
          }
        }

        // Resolve any remaining slot overlaps monotonically without merging separate blocks
        const cleanSlots: typeof rowSlots = [];
        let cursorCol = 0;
        for (const sl of rowSlots) {
          if (cleanSlots.length > 0) {
            const prev = cleanSlots[cleanSlots.length - 1];
            if (sl.startCol > prev.startCol && prev.endCol >= sl.startCol) {
              prev.endCol = sl.startCol - 1;
              cursorCol = prev.endCol + 1;
            }
          }
          const sCol = Math.max(cursorCol, sl.startCol);
          if (sCol >= numCols) {
            overflowItems.push(...sl.items);
            continue;
          }
          const eCol = Math.max(sCol, Math.min(numCols - 1, sl.endCol));
          cleanSlots.push({ ...sl, startCol: sCol, endCol: eCol });
          cursorCol = eCol + 1;
        }

        if (overflowItems.length > 0) {
          pendingSlices.unshift(overflowItems.sort((a, b) => a.x - b.x));
        }
        if (cleanSlots.length === 0) continue;

        const rowAppliesTableGrid =
          selectedStrategy === 'PLANAR_GRID_SOLVER' ||
          (isDataTable && lr.rects.length > 0 && selectedStrategy !== 'KEY_VALUE_SUBGRID_FLATTENER') ||
          Boolean(lr.isSubTableRow);
        const cells: TablixCell[] = [];
        const rowHeightInputs: Array<{
          text: string;
          runs?: VisualTextRun[];
          style: RegionStyle;
          coveredWidthPt: number;
        }> = [];

        let col = 0;
        for (const sl of cleanSlots) {
          while (col < sl.startCol) {
            const colW = columnWidthsIn[col];
            const emptyStyle = this.buildTableCellStyle(undefined, undefined, rowAppliesTableGrid, false, pageWeights);
            cells.push({
              colIndex: col,
              rowIndex: outRowIndex,
              colSpan: 1,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: {
                kind: 'Textbox',
                name: nextUniqueName('Cell'),
                value: '',
                isExpression: false,
                style: emptyStyle,
                canGrow: true,
              },
            });
            rowHeightInputs.push({
              text: '',
              style: emptyStyle,
              coveredWidthPt: inToPt(colW),
            });
            col++;
          }

          const colSpan = sl.endCol - sl.startCol + 1;
          let coveredWidthIn = 0;
          for (let cc = sl.startCol; cc <= sl.endCol; cc++) coveredWidthIn += columnWidthsIn[cc];

          const firstImage = sl.items.find((i) => i.kind === 'image' && i.region.imageAssetBase64);
          if (firstImage && firstImage.region.imageAssetBase64) {
            const embName = registerEmbeddedImage(
              firstImage.region.imageAssetBase64,
              firstImage.region.imageAssetName ?? `Graphic_${outRowIndex}`
            );
            void embName;
            cells.push({
              colIndex: sl.startCol,
              rowIndex: outRowIndex,
              colSpan,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: {
                kind: 'Image',
                name: nextUniqueName('Img'),
                mimeType: 'image/png',
                base64Data: firstImage.region.imageAssetBase64,
                sizing: 'FitProportional',
              },
            });
            rowHeightInputs.push({
              text: '',
              style: defaultTextStyle(8.5, pageWeights),
              coveredWidthPt: inToPt(coveredWidthIn),
            });
          } else {
            const textParts = sl.items
              .filter((i) => i.kind === 'text')
              .sort((a, b) => a.y - b.y || a.x - b.x);
            const mergedText = textParts
              .reduce((acc, tp, idx) => {
                const part = (tp.region.text ?? '').trim();
                if (!part) return acc;
                if (!acc) return part;
                const prev = textParts[idx - 1];
                const sameLine = prev && Math.abs(tp.y - prev.y) <= ptToIn(3.5);
                return `${acc}${sameLine ? ' ' : '\n'}${part}`;
              }, '');
            const primary = textParts[0]?.region;
            const applyCellBorder = rowAppliesTableGrid || Boolean(sl.rect?.region.style.borderColor);
            const baseStyle = this.buildTableCellStyle(
              primary?.style,
              sl.rect?.region.style,
              applyCellBorder,
              Boolean(lr.isHeaderRow),
              pageWeights
            );

            if (sl.centerAlign) {
              baseStyle.textAlign = 'Center';
            } else if (textParts.length > 0) {
              const colCenterX = (atomicColBoundaries[sl.startCol] + atomicColBoundaries[sl.endCol + 1]) / 2;
              const minTX = Math.min(...textParts.map((t) => t.x));
              const maxTX = Math.max(...textParts.map((t) => t.x + t.width));
              const textMidX = (minTX + maxTX) / 2;
              const rectMidX = sl.rect && sl.rect.width < blockW * 0.9 ? sl.rect.x + sl.rect.width / 2 : colCenterX;
              if (
                Math.abs(textMidX - colCenterX) <= ptToIn(4) ||
                (sl.rect && sl.rect.width < blockW * 0.9 && Math.abs(textMidX - rectMidX) <= ptToIn(6) && maxTX - minTX < sl.rect.width * 0.82)
              ) {
                baseStyle.textAlign = 'Center';
              }
            }

            // Align numeric/parenthesized negative cells right in multi-col data tables when not centered
            if (
              rowAppliesTableGrid &&
              !lr.isHeaderRow &&
              baseStyle.textAlign !== 'Center' &&
              sl.startCol > 0 &&
              /^(\(?\s*-?[0-9][0-9.,]*\s*\)?|Rp\s*[0-9.,-]+|-)$/i.test(mergedText)
            ) {
              baseStyle.textAlign = 'Right';
            }

            const runs: VisualTextRun[] = [];
            textParts.forEach((tp, idx) => {
              if (idx > 0 && runs.length > 0) {
                const prev = textParts[idx - 1];
                const sameLine = prev && Math.abs(tp.y - prev.y) <= ptToIn(3.5);
                runs.push({
                  ...runs[runs.length - 1],
                  text: sameLine ? ' ' : '\n',
                });
              }
              if (tp.region.runs && tp.region.runs.length > 0) {
                for (const r of tp.region.runs) {
                  runs.push({ ...r });
                }
              } else if (tp.region.text) {
                runs.push({
                  text: tp.region.text,
                  fontFamily: baseStyle.fontFamily,
                  fontSizePt: baseStyle.fontSizePt,
                  bold: baseStyle.bold,
                  italic: baseStyle.italic,
                  underline: baseStyle.underline,
                  color: baseStyle.color,
                });
              }
            });

            let distinctSrcLines = 0;
            let prevLineY = -Infinity;
            for (const tp of textParts) {
              const subLines = (tp.region.text ?? '').split(/\r?\n/).filter((s) => s.trim().length > 0).length;
              if (subLines > 1) {
                distinctSrcLines += subLines;
                prevLineY = tp.y;
              } else if (prevLineY === -Infinity || Math.abs(tp.y - prevLineY) > ptToIn(3.5)) {
                distinctSrcLines += 1;
                prevLineY = tp.y;
              }
            }
            const srcMinXIn = textParts.length > 0 ? Math.min(...textParts.map((t) => t.x)) : undefined;
            const srcMaxXIn = textParts.length > 0 ? Math.max(...textParts.map((t) => t.x + t.width)) : undefined;
            const srcMinYPt =
              textParts.length > 0
                ? Math.round(inToPt(Math.min(...textParts.map((t) => t.region.y))) * 10) / 10
                : undefined;
            const srcMaxYPt =
              textParts.length > 0
                ? Math.round(inToPt(Math.max(...textParts.map((t) => t.region.y + t.region.height))) * 10) / 10
                : undefined;

            cells.push({
              colIndex: sl.startCol,
              rowIndex: outRowIndex,
              colSpan,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: {
                kind: 'Textbox',
                name: nextUniqueName('Cell'),
                value: mergedText,
                runs: runs.length > 0 ? runs : undefined,
                isExpression: false,
                style: baseStyle,
                canGrow: true,
                sourceLineCount: Math.max(1, distinctSrcLines),
                sourceX0In: srcMinXIn !== undefined ? roundIn(blockLeft + srcMinXIn) : undefined,
                sourceWidthIn:
                  srcMinXIn !== undefined && srcMaxXIn !== undefined
                    ? roundIn(srcMaxXIn - srcMinXIn)
                    : undefined,
                sourceYMinPt: srcMinYPt,
                sourceYMaxPt: srcMaxYPt,
              },
            });

            rowHeightInputs.push({
              text: mergedText,
              runs,
              style: baseStyle,
              coveredWidthPt: inToPt(coveredWidthIn),
            });
          }

          for (let mc = sl.startCol + 1; mc <= sl.endCol; mc++) {
            cells.push({
              colIndex: mc,
              rowIndex: outRowIndex,
              colSpan: 1,
              rowSpan: 1,
              skipBecauseMerged: true,
              content: { kind: 'Empty', name: nextUniqueName('Empty') },
            });
          }

          col = sl.endCol + 1;
        }

        while (col < numCols) {
          const colW = columnWidthsIn[col];
          const emptyStyle = this.buildTableCellStyle(undefined, undefined, rowAppliesTableGrid, false, pageWeights);
          cells.push({
            colIndex: col,
            rowIndex: outRowIndex,
            colSpan: 1,
            rowSpan: 1,
            skipBecauseMerged: false,
            content: {
              kind: 'Textbox',
              name: nextUniqueName('Cell'),
              value: '',
              isExpression: false,
              style: emptyStyle,
              canGrow: true,
            },
          });
          rowHeightInputs.push({
            text: '',
            style: emptyStyle,
            coveredWidthPt: inToPt(colW),
          });
          col++;
        }

        const rowHeightPt = estimateWrappedRowHeightPt(rowHeightInputs, minRowHeightPt, pageWeights);
        tablixRows.push({
          heightIn: roundIn(ptToIn(rowHeightPt)),
          isDetailRow: false,
          cells,
        });
        emittedLogicalRows.push({
          ...lr,
          items: cleanSlots.flatMap((s) => s.items),
        });
      }
    }

    // Step 2 Over-Split Row Recovery: merge consecutive Regular prose rows sharing x0 without dividers
    if (pageOverride?.mergeOverSplitRows && !isDataTable && selectedStrategy !== 'PLANAR_GRID_SOLVER') {
      this.mergeOverSplitTablixRows(
        tablixRows,
        emittedLogicalRows,
        columnWidthsIn,
        Boolean(block.banner),
        minRowHeightPt,
        pageWeights
      );
    }

    // Layer 3 Rule 5: Vertical Merging WITHOUT <RowSpan> (border suppression for grouped vertical labels)
    this.applyVerticalMergeBorderSuppression(
      tablixRows,
      tableRects,
      lineItems,
      emittedLogicalRows,
      atomicColBoundaries,
      isDataTable
    );

    // Apply perimeter-only border if a full-section outer frame box wrapped a narrative/non-table block
    if (!isDataTable && outerFrameRects.length > 0 && tablixRows.length > 0) {
      const frameColor = outerFrameRects[0].region.style.borderColor;
      const frameWidthPt = outerFrameRects[0].region.style.borderWidthPt ?? 0.5;
      if (frameColor) {
        const firstBodyIdx = block.banner ? 1 : 0;
        const lastBodyIdx = tablixRows.length - 1;
        const solidEdge: CellBorderEdge = { style: 'Solid', color: frameColor, widthPt: frameWidthPt };
        const noneEdge: CellBorderEdge = { style: 'None' };
        for (let rIdx = firstBodyIdx; rIdx <= lastBodyIdx; rIdx++) {
          const row = tablixRows[rIdx];
          for (const cell of row.cells) {
            if (cell.skipBecauseMerged || cell.content.kind !== 'Textbox') continue;
            if (cell.content.style.borderColor) continue;
            cell.content.style.borderEdges = {
              top: rIdx === firstBodyIdx ? solidEdge : noneEdge,
              bottom: rIdx === lastBodyIdx ? solidEdge : noneEdge,
              left: cell.colIndex === 0 ? solidEdge : noneEdge,
              right: cell.colIndex + cell.colSpan >= numCols ? solidEdge : noneEdge,
            };
          }
        }
      }
    }

    const totalHeightIn = roundIn(
      Math.max(ptToIn(14), tablixRows.reduce((s, r) => s + r.heightIn, 0))
    );

    return {
      id: tablixName,
      name: tablixName,
      pageNumber: block.pageNumber,
      sourcePageIndex: block.pageNumber - 1,
      bandKind: 'Detail',
      containerKey,
      solverStrategy: selectedStrategy,
      geometricSignature: signature,
      pageBreakBefore: block.pageBreakBefore,
      keepTogether: false,
      topIn: roundIn(topIn),
      leftIn: roundIn(blockLeft),
      widthIn: blockW,
      heightIn: totalHeightIn,
      dataSetName,
      isRepeatingDetail: false,
      columnWidthsIn,
      rows: tablixRows,
      zIndex: 1,
    };
  }

  private extractContainerSignature(
    contentItems: PositionedItem[],
    tableRects: PositionedItem[],
    lineItems: PositionedItem[],
    rowFillBands: Array<{ yTop: number; yBottom: number }>,
    blockW: number,
    contentSpanY: number,
    isFootnote: boolean,
    weights: CompilerWeights
  ): ContainerGeometricSignature {
    const vLines = lineItems.filter(
      (ln) =>
        ln.width <= ptToIn(3.5) &&
        ln.height >= ptToIn(12) &&
        ln.x >= ptToIn(4) &&
        ln.x <= blockW - ptToIn(4)
    );
    const rectInteriorXs = clusterValues(
      tableRects
        .flatMap((rc) => [clamp(rc.x, 0, blockW), clamp(rc.x + rc.width, 0, blockW)])
        .filter((x) => x > ptToIn(6) && x < blockW - ptToIn(6)),
      ptToIn(2.5)
    );
    const internalVLineCount = Math.max(vLines.length, rectInteriorXs.length);

    const shadedRectYs = clusterValues(
      tableRects.filter((rc) => isNonWhiteFill(rc.region.style.backgroundColor)).map((rc) => rc.y),
      ptToIn(weights.yRowClusterTolPt)
    );
    const shadedRowBandCount = Math.max(rowFillBands.length, shadedRectYs.length);

    // Check localized embedded sub-grid (cluster of tableRects/vLines spanning < 65% of container Y)
    let hasEmbeddedSubGrid = false;
    if (tableRects.length >= 2 && contentSpanY > 0) {
      const sortedRects = [...tableRects].sort((a, b) => a.y - b.y);
      const zones: Array<{ yTop: number; yBottom: number; rects: PositionedItem[] }> = [];
      for (const rc of sortedRects) {
        const last = zones[zones.length - 1];
        if (last && rc.y <= last.yBottom + ptToIn(6)) {
          last.yBottom = Math.max(last.yBottom, rc.y + rc.height);
          last.rects.push(rc);
        } else {
          zones.push({ yTop: rc.y, yBottom: rc.y + rc.height, rects: [rc] });
        }
      }
      hasEmbeddedSubGrid = zones.some((z) => {
        if (z.rects.length < 2) return false;
        if (z.yBottom - z.yTop >= contentSpanY * 0.65) return false;
        const xs = clusterValues(
          z.rects.flatMap((r) => [clamp(r.x, 0, blockW), clamp(r.x + r.width, 0, blockW)]),
          ptToIn(2.5)
        );
        const ys = clusterValues(z.rects.flatMap((r) => [r.y, r.y + r.height]), ptToIn(weights.yRowClusterTolPt));
        const outsideCount = contentItems.filter((it) => {
          const cy = it.y + it.height / 2;
          return cy < z.yTop - ptToIn(4) || cy > z.yBottom + ptToIn(4);
        }).length;
        return xs.length >= 3 && ys.length >= 2 && outsideCount >= 2;
      });
    }

    // Count distinct recurring left-edge x0 indentation tracks
    const textItems = contentItems.filter((it) => it.kind === 'text');
    const rowBuckets = this.clusterItemsIntoRows(textItems, tableRects, weights);
    const indentCandidates: number[] = [];
    for (const rb of rowBuckets) {
      if (rb.items.length === 0) continue;
      indentCandidates.push(rb.items[0].x);
      if (rb.items.length >= 2 && STANDALONE_MARKER_RE.test((rb.items[0].region.text ?? '').trim())) {
        indentCandidates.push(rb.items[1].x);
      }
    }
    const indentClusters = clusterValues(indentCandidates, ptToIn(weights.xClusterTolPt));
    const indentationLevels = indentClusters.length;

    const denseRowsCount = rowBuckets.filter((r) => r.items.filter((i) => i.kind === 'text').length >= 4).length;

    // Count aligned ':' or '=' operator tokens across >= 2 rows (ignore stray punctuation in dense multi-col numeric tables)
    const operatorXs: number[] = [];
    if (internalVLineCount < 3 && denseRowsCount < 3) {
      for (const rb of rowBuckets) {
        for (const it of rb.items) {
          const txt = (it.region.text ?? '').trim();
          if (txt === ':' || txt === '=') {
            operatorXs.push(it.x);
            continue;
          }
          const opMatch = txt.match(/^(.{2,36}?)\s*([:=])\s+(.+)$/);
          if (opMatch && opMatch[1].length + opMatch[3].length >= 3) {
            const ratio = (opMatch[1].length + 0.5) / Math.max(1, txt.length);
            operatorXs.push(it.x + it.width * ratio);
          }
        }
      }
    }
    let operatorColumnCount = 0;
    if (operatorXs.length >= 2) {
      const sortedOps = [...operatorXs].sort((a, b) => a - b);
      let grpCount = 1;
      for (let i = 1; i < sortedOps.length; i++) {
        if (Math.abs(sortedOps[i] - sortedOps[i - 1]) <= ptToIn(weights.xClusterTolPt * 1.6)) {
          grpCount++;
        } else {
          if (grpCount >= 2) operatorColumnCount++;
          grpCount = 1;
        }
      }
      if (grpCount >= 2) operatorColumnCount++;
    }
    const trailingWideRows = rowBuckets.slice(-3).filter((r) => {
      const txts = r.items.filter((i) => i.kind === 'text');
      if (txts.length === 0 || txts.length > 2) return false;
      const minX = Math.min(...txts.map((t) => t.x));
      const maxX = Math.max(...txts.map((t) => t.x + t.width));
      return maxX - minX >= blockW * 0.75;
    }).length;
    const columnDensityDrop = isFootnote || (denseRowsCount >= 3 && trailingWideRows >= 1);

    return {
      internalVLineCount,
      shadedRowBandCount,
      hasEmbeddedSubGrid,
      indentationLevels,
      operatorColumnCount,
      columnDensityDrop,
    };
  }

  private selectContainerStrategy(
    sig: ContainerGeometricSignature,
    tableRectCount: number
  ): SolverStrategy {
    if (sig.columnDensityDrop) {
      return 'DENSITY_TRANSITION_SPLITTER';
    }
    if (sig.internalVLineCount >= 3 || (tableRectCount >= 4 && !sig.hasEmbeddedSubGrid && sig.internalVLineCount >= 1)) {
      return 'PLANAR_GRID_SOLVER';
    }
    if (sig.hasEmbeddedSubGrid) {
      return 'KEY_VALUE_SUBGRID_FLATTENER';
    }
    if (sig.operatorColumnCount >= 1) {
      return 'HLINE_OPERATOR_EQUATION_SOLVER';
    }
    return 'INDENTATION_CLAUSE_SOLVER';
  }

  private splitOperatorAlignedTokens(
    contentItems: PositionedItem[],
    weights: CompilerWeights
  ): PositionedItem[] {
    const out: PositionedItem[] = [];
    const candidateOpXs: number[] = [];

    for (const it of contentItems) {
      if (it.kind !== 'text') continue;
      const txt = (it.region.text ?? '').trim();
      if (txt === ':' || txt === '=') {
        candidateOpXs.push(it.x);
      } else {
        const m = txt.match(/^(.{2,36}?)\s*([:=])\s+(.+)$/);
        if (m) {
          const ratio = (m[1].length + 0.5) / Math.max(1, txt.length);
          candidateOpXs.push(it.x + it.width * ratio);
        }
      }
    }

    const opClusters = clusterValues(candidateOpXs, ptToIn(weights.xClusterTolPt * 1.6));
    const alignedOpXs = opClusters.filter(
      (cx) => candidateOpXs.filter((x) => Math.abs(x - cx) <= ptToIn(weights.xClusterTolPt * 1.6)).length >= 2
    );
    if (alignedOpXs.length === 0) return contentItems;

    for (const it of contentItems) {
      if (it.kind !== 'text') {
        out.push(it);
        continue;
      }
      const txt = (it.region.text ?? '').trim();
      const m = txt.match(/^(.{2,36}?)\s*([:=])\s+(.+)$/);
      if (!m) {
        out.push(it);
        continue;
      }
      const [, lhs, op, rhs] = m;
      const totalLen = Math.max(1, txt.length);
      const ratio = (lhs.length + 0.5) / totalLen;
      const estOpX = it.x + it.width * ratio;
      const matchedOpX = alignedOpXs.find((ax) => Math.abs(ax - estOpX) <= ptToIn(weights.xClusterTolPt * 2));
      if (matchedOpX === undefined) {
        out.push(it);
        continue;
      }

      const opW = ptToIn(Math.max(6, (it.region.style.fontSizePt || 8.5) * 0.7));
      const lhsW = Math.max(ptToIn(12), matchedOpX - it.x - ptToIn(2));
      const rhsX = matchedOpX + opW + ptToIn(3);
      const rhsW = Math.max(ptToIn(14), it.x + it.width - rhsX);

      out.push({
        ...it,
        width: lhsW,
        region: {
          ...it.region,
          id: `${it.region.id}-lhs`,
          width: lhsW,
          text: lhs.trim(),
          runs: undefined,
        },
      });
      out.push({
        ...it,
        x: matchedOpX,
        width: opW,
        region: {
          ...it.region,
          id: `${it.region.id}-op`,
          x: it.region.x + (matchedOpX - it.x),
          width: opW,
          text: op,
          runs: undefined,
        },
      });
      out.push({
        ...it,
        x: rhsX,
        width: rhsW,
        region: {
          ...it.region,
          id: `${it.region.id}-rhs`,
          x: it.region.x + (rhsX - it.x),
          width: rhsW,
          text: rhs.trim(),
          runs: undefined,
        },
      });
    }

    return out;
  }

  private compileFootnoteTablix(
    tablixName: string,
    block: LogicalSegmentBlock,
    relItems: PositionedItem[],
    topIn: number,
    dataSetName: string,
    nextUniqueName: (prefix: string) => string,
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS,
    pageOverride?: PageDensityOverride
  ): TablixRegion {
    const blockW = roundIn(Math.max(1.0, block.widthIn));
    const markerColW = roundIn(cmToIn(0.85));
    const contentColW = roundIn(Math.max(0.5, blockW - markerColW));
    const columnWidthsIn = [markerColW, contentColW];

    const textItems = relItems
      .filter((i) => i.kind === 'text' && (i.region.text ?? '').trim().length > 0)
      .sort((a, b) => a.y - b.y || a.x - b.x);

    const rawFootnoteRows = this.clusterItemsIntoRows(textItems, [], weights);
    const mergedFootnoteRows: Array<{
      marker: string;
      text: string;
      isTitle: boolean;
      style: RegionStyle;
      lastBottom: number;
      lastX: number;
      lastRight: number;
      lineCount: number;
      minY: number;
      maxY: number;
    }> = [];

    const padV = Math.max(0.25, Math.round((weights.cellPadVerticalPt / 2) * 100) / 100);
    const padH = Math.max(1.5, Math.round(weights.cellPadHorizontalPt * 0.75 * 100) / 100);

    for (let i = 0; i < rawFootnoteRows.length; i++) {
      const rb = rawFootnoteRows[i];
      const sortedLineItems = [...rb.items].sort((a, b) => a.x - b.x);
      const lineText = sortedLineItems
        .map((it) => (it.region.text ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
      if (!lineText) continue;

      const markerMatch = lineText.match(/^(\(\d+\)|\d+\.|[a-z]\.|[•\u2022\-–])\s+(.+)$/i);
      const isTitle =
        i === 0 &&
        rawFootnoteRows.length >= 2 &&
        !markerMatch &&
        lineText.length <= 45 &&
        (rb.items.some((it) => it.region.style.bold) || lineText.endsWith(':'));

      const firstItem = sortedLineItems[0];
      const lastItem = sortedLineItems[sortedLineItems.length - 1];
      const fsPt = Math.max(6.5, firstItem.region.style.fontSizePt || 8.0);
      const prev = mergedFootnoteRows[mergedFootnoteRows.length - 1];

      if (
        prev &&
        !prev.isTitle &&
        !isTitle &&
        !markerMatch &&
        !STANDALONE_MARKER_RE.test(lineText) &&
        rb.yTop - prev.lastBottom <= ptToIn(fsPt * (pageOverride?.mergeOverSplitRows ? 1.25 : 0.95))
      ) {
        prev.text = `${prev.text} ${lineText}`.replace(/\s+/g, ' ').trim();
        prev.lastBottom = rb.yBottom;
        prev.lastRight = Math.max(prev.lastRight, lastItem.x + lastItem.width);
        prev.lineCount += 1;
        prev.maxY = Math.max(prev.maxY, ...sortedLineItems.map((it) => it.region.y + it.region.height));
        continue;
      }

      const baseStyle = defaultTextStyle(isTitle ? 8.5 : 8.0, weights);
      baseStyle.bold = isTitle;
      baseStyle.paddingPt = { top: padV, right: padH, bottom: padV, left: padH };
      mergedFootnoteRows.push({
        marker: markerMatch ? markerMatch[1] : '',
        text: markerMatch ? markerMatch[2] : lineText,
        isTitle,
        style: baseStyle,
        lastBottom: rb.yBottom,
        lastX: firstItem.x,
        lastRight: lastItem.x + lastItem.width,
        lineCount: 1,
        minY: Math.min(...sortedLineItems.map((it) => it.region.y)),
        maxY: Math.max(...sortedLineItems.map((it) => it.region.y + it.region.height)),
      });
    }

    const minRowH = pageOverride?.minRowHeightPt ?? 12.5;
    const rows: TablixRow[] = [];
    for (const fnRow of mergedFootnoteRows) {
      const markerText = fnRow.marker;
      const bodyText = fnRow.text;
      const baseStyle = fnRow.style;
      const outIdx = rows.length;
      if (fnRow.isTitle) {
        const hPt = estimateWrappedRowHeightPt(
          [{ text: bodyText, style: baseStyle, coveredWidthPt: inToPt(blockW) }],
          minRowH,
          weights
        );
        rows.push({
          heightIn: roundIn(ptToIn(hPt)),
          isDetailRow: false,
          cells: [
            {
              colIndex: 0,
              rowIndex: outIdx,
              colSpan: 2,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: {
                kind: 'Textbox',
                name: nextUniqueName('FootnoteHdr'),
                value: bodyText,
                isExpression: false,
                style: baseStyle,
                canGrow: true,
                sourceLineCount: fnRow.lineCount,
                sourceX0In: roundIn(block.leftIn + fnRow.lastX),
                sourceWidthIn: roundIn(Math.max(0.05, fnRow.lastRight - fnRow.lastX)),
                sourceYMinPt: Math.round(inToPt(fnRow.minY) * 10) / 10,
                sourceYMaxPt: Math.round(inToPt(fnRow.maxY) * 10) / 10,
              },
            },
            {
              colIndex: 1,
              rowIndex: outIdx,
              colSpan: 1,
              rowSpan: 1,
              skipBecauseMerged: true,
              content: { kind: 'Empty', name: nextUniqueName('Empty') },
            },
          ],
        });
      } else {
        const hPt = estimateWrappedRowHeightPt(
          [
            { text: markerText, style: baseStyle, coveredWidthPt: inToPt(markerColW) },
            { text: bodyText, style: baseStyle, coveredWidthPt: inToPt(contentColW) },
          ],
          minRowH,
          weights
        );
        rows.push({
          heightIn: roundIn(ptToIn(hPt)),
          isDetailRow: false,
          cells: [
            {
              colIndex: 0,
              rowIndex: outIdx,
              colSpan: 1,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: {
                kind: 'Textbox',
                name: nextUniqueName('NoteMark'),
                value: markerText,
                isExpression: false,
                style: baseStyle,
                canGrow: true,
              },
            },
            {
              colIndex: 1,
              rowIndex: outIdx,
              colSpan: 1,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: {
                kind: 'Textbox',
                name: nextUniqueName('NoteText'),
                value: bodyText,
                isExpression: false,
                style: baseStyle,
                canGrow: true,
                sourceLineCount: fnRow.lineCount,
                sourceX0In: roundIn(block.leftIn + fnRow.lastX),
                sourceWidthIn: roundIn(Math.max(0.05, fnRow.lastRight - fnRow.lastX)),
                sourceYMinPt: Math.round(inToPt(fnRow.minY) * 10) / 10,
                sourceYMaxPt: Math.round(inToPt(fnRow.maxY) * 10) / 10,
              },
            },
          ],
        });
      }
    }

    const totalH = roundIn(Math.max(ptToIn(14), rows.reduce((s, r) => s + r.heightIn, 0)));
    return {
      id: tablixName,
      name: tablixName,
      pageNumber: block.pageNumber,
      sourcePageIndex: block.pageNumber - 1,
      bandKind: 'Notes',
      pageBreakBefore: false,
      keepTogether: false,
      topIn: roundIn(topIn),
      leftIn: roundIn(block.leftIn),
      widthIn: blockW,
      heightIn: totalH,
      dataSetName,
      isRepeatingDetail: false,
      columnWidthsIn,
      rows,
      zIndex: 1,
    };
  }

  private buildBannerTextboxCell(
    banner: BannerElement,
    colIndex: number,
    rowIndex: number,
    colSpan: number,
    nextUniqueName: (prefix: string) => string,
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS
  ): TablixCell {
    const bg = banner.rect.region.style.backgroundColor ?? '#334155';
    const bgRgb = parseHexRgb(bg);
    const fallbackTextCol = bgRgb && relativeLuminance(bgRgb) < 0.45 ? '#FFFFFF' : '#0F172A';
    const extractedCol = banner.textItems[0]?.region.style.color;
    const textColor =
      extractedCol && contrastRatio(extractedCol, bg) >= 2.6 ? extractedCol : fallbackTextCol;
    const primaryStyle = banner.textItems[0]?.region.style;
    const fontSizePt = primaryStyle?.fontSizePt ?? 9.5;
    const fontFamily = primaryStyle?.fontFamily ?? 'Arial';
    const bannerCenterX = banner.x + banner.width / 2;
    const minTextX = banner.textItems.length > 0 ? Math.min(...banner.textItems.map((t) => t.x)) : banner.x;
    const maxTextX = banner.textItems.length > 0 ? Math.max(...banner.textItems.map((t) => t.x + t.width)) : banner.x;
    const textCenterX = (minTextX + maxTextX) / 2;
    const isCentered = banner.textItems.length > 0 && Math.abs(textCenterX - bannerCenterX) <= ptToIn(8);
    const padV = Math.max(0.5, Math.round(Math.min(3, weights.cellPadVerticalPt * 0.75) * 100) / 100);
    const style: RegionStyle = {
      fontFamily,
      fontSizePt,
      bold: primaryStyle?.bold ?? true,
      italic: primaryStyle?.italic ?? false,
      color: textColor,
      backgroundColor: bg,
      textAlign: isCentered ? 'Center' : (primaryStyle?.textAlign ?? 'Left'),
      verticalAlign: 'Middle',
      lineHeightPt: Math.round(fontSizePt * weights.lineHeightMultiplier * 100) / 100,
      paddingPt: { top: padV, right: 5, bottom: padV, left: 5 },
    };

    return {
      colIndex,
      rowIndex,
      colSpan,
      rowSpan: 1,
      skipBecauseMerged: false,
      content: {
        kind: 'Textbox',
        name: nextUniqueName('Banner'),
        value: banner.titleText,
        runs: [
          {
            text: banner.titleText,
            fontFamily,
            fontSizePt,
            bold: style.bold,
            italic: style.italic,
            color: textColor,
          },
        ],
        isExpression: false,
        style,
        canGrow: true,
      },
    };
  }

  private expandMultilineItems(items: PositionedItem[]): PositionedItem[] {
    const out: PositionedItem[] = [];
    for (const it of items) {
      if (it.kind !== 'text' || !(it.region.text ?? '').includes('\n')) {
        out.push(it);
        continue;
      }
      const lines = (it.region.text ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (lines.length <= 1) {
        out.push(it);
        continue;
      }
      const lineStep = it.height / lines.length;
      lines.forEach((ln, idx) => {
        const lineY = it.y + idx * lineStep;
        out.push({
          ...it,
          y: lineY,
          height: lineStep,
          region: {
            ...it.region,
            id: `${it.region.id}-ln${idx}`,
            y: it.region.y + idx * lineStep,
            height: lineStep,
            text: ln,
            runs: [
              {
                text: ln,
                fontFamily: it.region.style.fontFamily,
                fontSizePt: it.region.style.fontSizePt,
                bold: idx === 0 ? it.region.style.bold : false,
                italic: it.region.style.italic,
                color: it.region.style.color,
              },
            ],
          },
        });
      });
    }
    return out;
  }

  private clusterItemsIntoRows(
    contentItems: PositionedItem[],
    rectItems: PositionedItem[],
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS
  ): LogicalRowBucket[] {
    const sorted = [...contentItems].sort((a, b) => a.y - b.y || a.x - b.x);
    const buckets: LogicalRowBucket[] = [];

    for (const it of sorted) {
      const last = buckets[buckets.length - 1];
      if (last) {
        const minFs = Math.min(
          it.region.style.fontSizePt || 8.5,
          ...last.items.map((pi) => pi.region.style.fontSizePt || 8.5)
        );
        // Distinct Y baselines (dy > min(yRowClusterTolPt, fontSize * 0.45)) MUST stay on separate rows
        const sameBaselineTolIn = Math.min(ptToIn(weights.yRowClusterTolPt), ptToIn(minFs * 0.45));
        if (Math.abs(it.y - last.yTop) <= sameBaselineTolIn) {
          last.items.push(it);
          last.yBottom = Math.max(last.yBottom, it.y + it.height);
          continue;
        }
      }
      buckets.push({
        yTop: it.y,
        yBottom: it.y + it.height,
        items: [it],
        rects: [],
      });
    }

    // Sort items inside each row strictly left-to-right, and attach intersecting cell rects
    for (const b of buckets) {
      b.items.sort((a, c) => a.x - c.x);
      const midY = (b.yTop + b.yBottom) / 2;
      b.rects = rectItems.filter(
        (rc) => midY >= rc.y - ptToIn(2) && midY <= rc.y + rc.height + ptToIn(2)
      );
      b.isHeaderRow =
        b.items.length >= 2 &&
        b.items.every((it) => it.region.style.bold || Boolean(b.rects.find((rc) => rc.region.style.backgroundColor)));
    }

    buckets.sort((a, b) => a.yTop - b.yTop);
    return buckets;
  }

  private splitClauseTitleRows(rows: LogicalRowBucket[]): LogicalRowBucket[] {
    const out: LogicalRowBucket[] = [];
    for (const row of rows) {
      if (row.items.length === 1 && row.items[0].kind === 'text') {
        const it = row.items[0];
        const txt = (it.region.text ?? '').trim();
        const m = txt.match(CLAUSE_TITLE_WITH_MARKER_RE);
        if (m) {
          const marker = m[1];
          const rest = m[2];
          const fs = it.region.style.fontSizePt || 8.5;
          const markerWidth = clamp(
            ptToIn((marker.length + 0.8) * fs * 0.56),
            ptToIn(8),
            Math.max(ptToIn(8), it.width * 0.4)
          );
          const markerRegion: LayoutRegion = {
            ...it.region,
            id: `${it.region.id}-mark`,
            text: marker,
            width: markerWidth,
            runs: [
              {
                text: marker,
                fontFamily: it.region.style.fontFamily,
                fontSizePt: it.region.style.fontSizePt,
                bold: it.region.style.bold,
                italic: it.region.style.italic,
                color: it.region.style.color,
              },
            ],
          };
          const contentRegion: LayoutRegion = {
            ...it.region,
            id: `${it.region.id}-body`,
            x: it.region.x + markerWidth,
            width: Math.max(ptToIn(20), it.region.width - markerWidth),
            text: rest,
            runs: [
              {
                text: rest,
                fontFamily: it.region.style.fontFamily,
                fontSizePt: it.region.style.fontSizePt,
                bold: it.region.style.bold,
                italic: it.region.style.italic,
                color: it.region.style.color,
              },
            ],
          };
          out.push({
            ...row,
            items: [
              { ...it, width: markerWidth, region: markerRegion },
              {
                ...it,
                x: it.x + markerWidth,
                width: Math.max(ptToIn(20), it.width - markerWidth),
                region: contentRegion,
              },
            ],
            isClauseTitleRow: it.region.style.bold && rest.length <= 90,
          });
          continue;
        }
      }

      if (row.items.length === 2 && row.items[0].kind === 'text' && row.items[1].kind === 'text') {
        const t0 = (row.items[0].region.text ?? '').trim();
        const t1 = (row.items[1].region.text ?? '').trim();
        if (STANDALONE_MARKER_RE.test(t0) && t1.includes('\n')) {
          const [titleLine, ...bodyLines] = t1.split('\n');
          const titleReg: LayoutRegion = { ...row.items[1].region, text: titleLine.trim(), runs: undefined };
          const bodyReg: LayoutRegion = {
            ...row.items[1].region,
            text: bodyLines.join('\n').trim(),
            style: { ...row.items[1].region.style, bold: false },
            runs: undefined,
          };
          out.push({
            ...row,
            items: [row.items[0], { ...row.items[1], region: titleReg }],
            isClauseTitleRow: true,
          });
          out.push({
            ...row,
            items: [{ ...row.items[1], region: bodyReg }],
          });
          continue;
        }
      }

      out.push(row);
    }
    return out;
  }

  private reconstructParagraphBlocks(
    rows: LogicalRowBucket[],
    rectItems: PositionedItem[],
    lineItems: PositionedItem[],
    blockW: number,
    pageNumber = 1,
    bodyTopOriginIn = 0,
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS,
    constraints: CalibrationConstraints = { forbidColumnSplits: [], forceTablixSplitsY: [], forceRowSplitsY: [] }
  ): LogicalRowBucket[] {
    if (rows.length <= 1) return rows;

    const yPageShift = (pageNumber - 1) * 100;
    const forcedRowSplits = constraints.forceRowSplitsY
      .filter((fs) => fs.pageNumber === pageNumber)
      .map((fs) => Math.max(0, ptToIn(fs.yPt) - bodyTopOriginIn) + yPageShift);

    const horizLines = lineItems.filter(
      (ln) => ln.height <= ptToIn(3) && ln.width >= ptToIn(8)
    );

    const findEnclosingRect = (it: PositionedItem): PositionedItem | undefined => {
      const cx = it.x + it.width / 2;
      const cy = it.y + it.height / 2;
      return rectItems
        .filter(
          (rc) =>
            cx >= rc.x - ptToIn(2) &&
            cx <= rc.x + rc.width + ptToIn(2) &&
            cy >= rc.y - ptToIn(2) &&
            cy <= rc.y + rc.height + ptToIn(2)
        )
        .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    };

    const hasSeparatorBetween = (
      y1: number,
      y2: number,
      x1: number,
      x2: number,
      sharedRectId?: string
    ): boolean => {
      if (forcedRowSplits.some((sy) => sy >= y1 - ptToIn(2) && sy <= y2 + ptToIn(2))) {
        return true;
      }
      const hasLine = horizLines.some(
        (ln) =>
          ln.y >= y1 - ptToIn(2) &&
          ln.y <= y2 + ptToIn(2) &&
          ln.x <= x2 - ptToIn(4) &&
          ln.x + ln.width >= x1 + ptToIn(4)
      );
      if (hasLine) return true;

      return rectItems.some((rc) => {
        if (sharedRectId && rc.region.id === sharedRectId) return false;
        const overlapsX = rc.x <= x2 - ptToIn(4) && rc.x + rc.width >= x1 + ptToIn(4);
        if (!overlapsX) return false;
        const topCross = rc.y >= y1 - ptToIn(1.5) && rc.y <= y2 + ptToIn(1.5);
        const botCross =
          rc.y + rc.height >= y1 - ptToIn(1.5) && rc.y + rc.height <= y2 + ptToIn(1.5);
        return topCross || botCross;
      });
    };

    const isAllBold = (it: PositionedItem): boolean => {
      const nonEmptyRuns = it.region.runs?.filter((r) => r.text.trim().length > 0);
      if (nonEmptyRuns && nonEmptyRuns.length > 0) {
        return nonEmptyRuns.every((r) => r.bold);
      }
      return Boolean(it.region.style.bold);
    };

    const getLocalRightBound = (baseX: number, yRef: number, boldFlag: boolean): number => {
      let localMax = 0;
      for (const r of rows) {
        if (Math.abs(r.yTop - yRef) > 2.5) continue;
        if (r.items.length === 1) {
          const it = r.items[0];
          if (
            it.kind === 'text' &&
            Math.abs(it.x - baseX) <= ptToIn(weights.xClusterTolPt) &&
            isAllBold(it) === boldFlag
          ) {
            localMax = Math.max(localMax, it.x + it.width);
          }
        } else if (
          r.items.length === 2 &&
          STANDALONE_MARKER_RE.test((r.items[0].region.text ?? '').trim())
        ) {
          const it = r.items[1];
          if (
            it.kind === 'text' &&
            Math.abs(it.x - baseX) <= ptToIn(weights.xClusterTolPt) &&
            isAllBold(it) === boldFlag
          ) {
            localMax = Math.max(localMax, it.x + it.width);
          }
        }
      }
      return localMax > 0 ? localMax : Math.max(blockW * 0.72, baseX + ptToIn(60));
    };

    const mergeOverride = constraints.pageOverrides?.find((o) => o.pageNumber === pageNumber)?.mergeOverSplitRows;
    const leadRatio = mergeOverride ? weights.paragraphLeadingRatio * 1.25 : weights.paragraphLeadingRatio;
    const gapRatio = mergeOverride ? 1.25 : 0.95;

    const out: LogicalRowBucket[] = [];
    let lastState:
      | {
          row: LogicalRowBucket;
          targetBaseX: number;
          lastLineX: number;
          lastLineRight: number;
          lastLineY: number;
          lastLineBottom: number;
          lastLineText: string;
          lastRectId?: string;
          lineCount: number;
        }
      | undefined;

    for (const curRow of rows) {
      let merged = false;

      if (
        lastState &&
        !lastState.row.isHeaderRow &&
        curRow.items.length === 1 &&
        curRow.items[0].kind === 'text'
      ) {
        const accRow = lastState.row;
        const targetItem = accRow.items[accRow.items.length - 1];
        const curItem = curRow.items[0];
        const curText = (curItem.region.text ?? '').trim();

        const targetRect = findEnclosingRect(targetItem);
        const curRect = findEnclosingRect(curItem);
        const sameRect = (targetRect?.region.id ?? undefined) === (curRect?.region.id ?? undefined);

        const curStartsNewMarker =
          CLAUSE_TITLE_WITH_MARKER_RE.test(curText) || STANDALONE_MARKER_RE.test(curText);

        const isSingleOrMarkerPair =
          accRow.items.length === 1 ||
          (accRow.items.length === 2 &&
            STANDALONE_MARKER_RE.test((accRow.items[0].region.text ?? '').trim()));

        if (
          targetItem.kind === 'text' &&
          curText.length > 0 &&
          !curStartsNewMarker &&
          sameRect &&
          (isSingleOrMarkerPair || Boolean(curRect))
        ) {
          const targetAllBold = isAllBold(targetItem);
          const curAllBold = isAllBold(curItem);
          const targetFs = Math.max(6.5, targetItem.region.style.fontSizePt || 8.5);
          const curFs = Math.max(6.5, curItem.region.style.fontSizePt || 8.5);
          const targetCol = (targetItem.region.style.color ?? '#0F172A').toUpperCase();
          const curCol = (curItem.region.style.color ?? '#0F172A').toUpperCase();

          const compatibleFont =
            targetAllBold === curAllBold &&
            targetItem.region.style.italic === curItem.region.style.italic &&
            Math.abs(targetFs - curFs) <= 1.2 &&
            targetCol === curCol;

          const dyBaseline = curItem.y - lastState.lastLineY;
          const dyGap = curItem.y - lastState.lastLineBottom;
          const validLeading =
            dyBaseline > 0 &&
            dyBaseline <= ptToIn(targetFs * leadRatio) &&
            dyGap <= ptToIn(targetFs * gapRatio);

          const isCenteredPair =
            targetItem.region.style.textAlign === 'Center' &&
            curItem.region.style.textAlign === 'Center' &&
            Math.abs(
              lastState.lastLineX +
                (lastState.lastLineRight - lastState.lastLineX) / 2 -
                (curItem.x + curItem.width / 2)
            ) <= ptToIn(10);

          // Strict left-edge match |Δx0| <= xClusterTolPt
          const alignedLeft = Math.abs(curItem.x - lastState.targetBaseX) <= ptToIn(weights.xClusterTolPt);

          const colRightBound = curRect
            ? curRect.x + curRect.width - ptToIn(2)
            : Math.max(
                lastState.lastLineRight,
                getLocalRightBound(lastState.targetBaseX, curItem.y, targetAllBold)
              );
          const firstWord = curText.split(/\s+/)[0] ?? '';
          const estFirstWordW = ptToIn(firstWord.length * targetFs * weights.charWidthFactor);
          const lastLineFilledW = lastState.lastLineRight - lastState.lastLineX;
          const availSpan = Math.max(ptToIn(24), colRightBound - lastState.lastLineX);
          const couldFitOnPrevLine =
            lastState.lastLineRight + estFirstWordW + ptToIn(6) < colRightBound;
          const endsWithColonIntro =
            /:$/.test(lastState.lastLineText) && lastLineFilledW < availSpan * 0.85;
          const endsShortSentence =
            /[.?!]$/.test(lastState.lastLineText) && lastLineFilledW < availSpan * 0.68;

          const passesWrapTest =
            !endsWithColonIntro &&
            !endsShortSentence &&
            (mergeOverride ||
              !couldFitOnPrevLine ||
              lastLineFilledW >= availSpan * 0.65 ||
              lastState.lastLineRight >= colRightBound - ptToIn(24) ||
              (isCenteredPair && lastLineFilledW >= availSpan * 0.55));

          const clearBetween = !hasSeparatorBetween(
            lastState.lastLineBottom,
            curItem.y,
            Math.min(lastState.lastLineX, curItem.x),
            Math.max(lastState.lastLineRight, curItem.x + curItem.width),
            targetRect?.region.id
          );

          if (
            compatibleFont &&
            validLeading &&
            (alignedLeft || isCenteredPair) &&
            passesWrapTest &&
            clearBetween
          ) {
            const prevText = (targetItem.region.text ?? '').trim();
            const joinedText = `${prevText} ${curText}`.replace(/\s+/g, ' ').trim();

            const targetRuns: VisualTextRun[] =
              targetItem.region.runs && targetItem.region.runs.length > 0
                ? targetItem.region.runs.map((r) => ({ ...r }))
                : [
                    {
                      text: prevText,
                      fontFamily: targetItem.region.style.fontFamily,
                      fontSizePt: targetItem.region.style.fontSizePt,
                      bold: targetItem.region.style.bold,
                      italic: targetItem.region.style.italic,
                      underline: targetItem.region.style.underline,
                      color: targetItem.region.style.color,
                    },
                  ];
            const curRuns: VisualTextRun[] =
              curItem.region.runs && curItem.region.runs.length > 0
                ? curItem.region.runs.map((r) => ({ ...r }))
                : [
                    {
                      text: curText,
                      fontFamily: curItem.region.style.fontFamily,
                      fontSizePt: curItem.region.style.fontSizePt,
                      bold: curItem.region.style.bold,
                      italic: curItem.region.style.italic,
                      underline: curItem.region.style.underline,
                      color: curItem.region.style.color,
                    },
                  ];
            if (targetRuns.length > 0 && curRuns.length > 0) {
              const lastRun = targetRuns[targetRuns.length - 1];
              if (!/\s$/.test(lastRun.text) && !/^\s/.test(curRuns[0].text)) {
                targetRuns.push({ ...lastRun, text: ' ' });
              }
              targetRuns.push(...curRuns);
            }

            const newX = Math.min(targetItem.x, curItem.x);
            const newRight = Math.max(targetItem.x + targetItem.width, curItem.x + curItem.width);
            const newBottom = Math.max(targetItem.y + targetItem.height, curItem.y + curItem.height);

            targetItem.x = newX;
            targetItem.width = newRight - newX;
            targetItem.height = newBottom - targetItem.y;
            targetItem.region = {
              ...targetItem.region,
              x: Math.min(targetItem.region.x, curItem.region.x),
              width: newRight - newX,
              height: newBottom - targetItem.y,
              text: joinedText,
              runs: targetRuns,
            };

            accRow.yBottom = Math.max(accRow.yBottom, curItem.y + curItem.height);
            lastState.lastLineX = curItem.x;
            lastState.lastLineRight = curItem.x + curItem.width;
            lastState.lastLineY = curItem.y;
            lastState.lastLineBottom = curItem.y + curItem.height;
            lastState.lastLineText = curText;
            lastState.lineCount++;
            merged = true;
          }
        }
      }

      if (!merged) {
        const clonedRow: LogicalRowBucket = {
          ...curRow,
          items: curRow.items.map((it) => ({
            ...it,
            region: {
              ...it.region,
              style: { ...it.region.style },
              runs: it.region.runs?.map((r) => ({ ...r })),
            },
          })),
        };
        out.push(clonedRow);

        const tail = clonedRow.items[clonedRow.items.length - 1];
        if (tail && tail.kind === 'text') {
          const tailRect = findEnclosingRect(tail);
          lastState = {
            row: clonedRow,
            targetBaseX: tail.x,
            lastLineX: tail.x,
            lastLineRight: tail.x + tail.width,
            lastLineY: tail.y,
            lastLineBottom: tail.y + tail.height,
            lastLineText: (tail.region.text ?? '').trim(),
            lastRectId: tailRect?.region.id,
            lineCount: 1,
          };
        } else {
          lastState = undefined;
        }
      }
    }

    return out;
  }

  private mergeCellBucketItems(cellItems: PositionedItem[], colWidthIn?: number): PositionedItem {
    const sorted = [...cellItems].sort((a, b) => a.y - b.y || a.x - b.x);
    if (sorted.length === 1) return sorted[0];
    const imageItem = sorted.find((i) => i.kind === 'image');
    if (imageItem && sorted.every((i) => i.kind === 'image')) return imageItem;

    const textParts = sorted.filter((i) => i.kind === 'text');
    if (textParts.length === 0) return sorted[0];
    if (textParts.length === 1) return textParts[0];

    const STANDALONE_VALUE_TOKEN_RE = /^(?:\(?\s*-?\d[\d.,]*\s*%?\s*\)?|Rp\s*[\d.,-]+|-|N\/A)$/i;
    let mergedText = '';
    const mergedRuns: VisualTextRun[] = [];
    for (let idx = 0; idx < textParts.length; idx++) {
      const tp = textParts[idx];
      const part = (tp.region.text ?? '').trim();
      if (!part) continue;
      let sep = '';
      if (mergedText.length > 0) {
        const prev = textParts[idx - 1];
        const prevTxt = (prev.region.text ?? '').trim();
        const dyBase = tp.y - prev.y;
        const fs = Math.max(6.5, prev.region.style.fontSizePt || 8.5);
        const sameLine = Math.abs(dyBase) <= ptToIn(3.5);
        const isNumericOrParenStack =
          STANDALONE_VALUE_TOKEN_RE.test(prevTxt) ||
          STANDALONE_VALUE_TOKEN_RE.test(part) ||
          /^\(/.test(part);
        const fillsColumnOrLowercaseCont =
          (colWidthIn !== undefined ? prev.width >= colWidthIn * 0.52 : prevTxt.length >= 16) ||
          /^[a-z]/.test(part);
        const isWrapCont =
          !sameLine &&
          !isNumericOrParenStack &&
          fillsColumnOrLowercaseCont &&
          dyBase > 0 &&
          dyBase <= ptToIn(fs * 1.65) &&
          !/[:.?!]$/.test(prevTxt);
        sep = sameLine || isWrapCont ? ' ' : '\n';
      }
      mergedText = `${mergedText}${sep}${part}`;
      if (sep && mergedRuns.length > 0) {
        mergedRuns.push({ ...mergedRuns[mergedRuns.length - 1], text: sep });
      }
      if (tp.region.runs && tp.region.runs.length > 0) {
        for (const r of tp.region.runs) mergedRuns.push({ ...r });
      } else {
        mergedRuns.push({
          text: part,
          fontFamily: tp.region.style.fontFamily,
          fontSizePt: tp.region.style.fontSizePt,
          bold: tp.region.style.bold,
          italic: tp.region.style.italic,
          underline: tp.region.style.underline,
          color: tp.region.style.color,
        });
      }
    }

    const first = textParts[0];
    const minX = Math.min(...textParts.map((t) => t.x));
    const minY = Math.min(...textParts.map((t) => t.y));
    const maxR = Math.max(...textParts.map((t) => t.x + t.width));
    const maxB = Math.max(...textParts.map((t) => t.y + t.height));
    return {
      ...first,
      x: minX,
      y: minY,
      width: maxR - minX,
      height: maxB - minY,
      region: {
        ...first.region,
        x: minX,
        y: minY,
        width: maxR - minX,
        height: maxB - minY,
        text: mergedText,
        runs: mergedRuns,
      },
    };
  }

  private tryBuildModeAGrid(
    contentItems: PositionedItem[],
    tableRects: PositionedItem[],
    lineItems: PositionedItem[],
    rowFillBands: Array<{ yTop: number; yBottom: number }>,
    blockW: number,
    contentSpanY: number,
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS
  ): { atomicColBoundaries: number[]; logicalRows: LogicalRowBucket[] } | null {
    if (contentItems.length < 4) return null;

    const vLines = lineItems.filter((ln) => ln.width <= ptToIn(3) && ln.height >= ptToIn(12));
    const hLines = lineItems.filter((ln) => ln.height <= ptToIn(3) && ln.width >= blockW * 0.55);

    // Mode A activates only when explicit vertical dividers (>= 3 VLines or structured bordered table rects) exist
    if (vLines.length < 3 && tableRects.length < 4) return null;

    const rawGridXs: number[] = [
      0,
      blockW,
      ...vLines.map((ln) => clamp(ln.x, 0, blockW)),
      ...tableRects.flatMap((rc) => [clamp(rc.x, 0, blockW), clamp(rc.x + rc.width, 0, blockW)]),
    ];
    // Dedup VLine X edges within <= 2.5pt
    const clusteredXs = clusterValues(rawGridXs, ptToIn(2.5));
    const gridXs: number[] = [0];
    for (let i = 1; i < clusteredXs.length - 1; i++) {
      const prev = gridXs[gridXs.length - 1];
      if (clusteredXs[i] - prev >= ptToIn(8) && blockW - clusteredXs[i] >= ptToIn(8)) {
        gridXs.push(clusteredXs[i]);
      }
    }
    gridXs.push(blockW);

    const rawGridYs: number[] = [
      ...hLines.map((ln) => ln.y),
      ...rowFillBands.flatMap((rb) => [rb.yTop, rb.yBottom]),
      ...tableRects.flatMap((rc) => [rc.y, rc.y + rc.height]),
    ];
    const gridYs = clusterValues(rawGridYs, ptToIn(weights.yRowClusterTolPt));

    if (gridXs.length < 4 || gridYs.length < 3) return null;
    const gridSpanY = gridYs[gridYs.length - 1] - gridYs[0];
    if (gridSpanY < Math.max(ptToIn(40), contentSpanY * 0.60)) return null;

    const expanded = this.expandMultilineItems(contentItems);
    const intervals: Array<[number, number]> = [];
    const above = expanded.filter((it) => it.y + it.height / 2 < gridYs[0] - ptToIn(3));
    if (above.length > 0) {
      intervals.push([Math.min(...above.map((i) => i.y)) - ptToIn(1), gridYs[0]]);
    }
    const wideHLines = hLines.filter((ln) => ln.width >= blockW * 0.68);
    for (let k = 0; k < gridYs.length - 1; k++) {
      const yA = gridYs[k];
      const yB = gridYs[k + 1];
      if (yB - yA < ptToIn(4)) continue;
      const topBoundedByWideH = wideHLines.some((ln) => Math.abs(ln.y - yA) <= ptToIn(4));
      const botBoundedByWideH = wideHLines.some((ln) => Math.abs(ln.y - yB) <= ptToIn(4));
      const lockWideTableRowBand =
        gridXs.length >= 7 &&
        topBoundedByWideH &&
        botBoundedByWideH &&
        yB - yA <= ptToIn(140);
      // Sub-slice unshaded tall multi-row intervals using text baselines unless locked by full-width HLines in wide tables
      if (!lockWideTableRowBand && yB - yA > ptToIn(18)) {
        const inside = expanded.filter((it) => {
          const cy = it.y + it.height / 2;
          return cy >= yA - ptToIn(2) && cy <= yB + ptToIn(2);
        });
        const yClusters = clusterValues(inside.map((i) => i.y), ptToIn(weights.yRowClusterTolPt));
        const subRows = this.clusterItemsIntoRows(inside, tableRects, weights);
        const multiColSubRows = subRows.filter((sr) => sr.items.length >= 2).length;
        if (yClusters.length >= 2 && (multiColSubRows >= 2 || yB - yA > ptToIn(120))) {
          subRows.forEach((sr, idx) => {
            const top = idx === 0 ? yA : (subRows[idx - 1].yBottom + sr.yTop) / 2;
            const bot = idx === subRows.length - 1 ? yB : (sr.yBottom + subRows[idx + 1].yTop) / 2;
            intervals.push([top, bot]);
          });
          continue;
        }
      }
      intervals.push([yA, yB]);
    }
    const below = expanded.filter((it) => it.y + it.height / 2 > gridYs[gridYs.length - 1] + ptToIn(3));
    if (below.length > 0) {
      intervals.push([gridYs[gridYs.length - 1], Math.max(...below.map((i) => i.y + i.height)) + ptToIn(1)]);
    }

    const numCols = gridXs.length - 1;
    const logicalRows: LogicalRowBucket[] = [];
    for (let iIdx = 0; iIdx < intervals.length; iIdx++) {
      const [yA, yB] = intervals[iIdx];
      const rowItems = expanded.filter((it) => {
        const cy = it.y + it.height / 2;
        return cy >= yA - ptToIn(2) && cy <= yB + ptToIn(2);
      });
      if (rowItems.length === 0) continue;

      const midY = (yA + yB) / 2;

      // Span-aware vertical splitting: identify which atomic vertical column boundaries exist at midY
      const activeAtRow = (xBoundary: number): boolean => {
        if (xBoundary <= ptToIn(2) || xBoundary >= blockW - ptToIn(2)) return true;
        const hasSpanningVLine = vLines.some(
          (vl) =>
            Math.abs(clamp(vl.x, 0, blockW) - xBoundary) <= ptToIn(3) &&
            vl.y - ptToIn(2) <= midY &&
            midY <= vl.y + vl.height + ptToIn(2)
        );
        const hasSpanningRectEdge = tableRects.some(
          (rc) =>
            rc.y - ptToIn(2) <= midY &&
            midY <= rc.y + rc.height + ptToIn(2) &&
            (Math.abs(clamp(rc.x, 0, blockW) - xBoundary) <= ptToIn(3) ||
              Math.abs(clamp(rc.x + rc.width, 0, blockW) - xBoundary) <= ptToIn(3))
        );
        return hasSpanningVLine || hasSpanningRectEdge;
      };

      const rowGroupBounds: Array<{ startCol: number; endCol: number; x0: number; x1: number }> = [];
      let curStart = 0;
      for (let c = 1; c < numCols; c++) {
        if (activeAtRow(gridXs[c])) {
          rowGroupBounds.push({
            startCol: curStart,
            endCol: c - 1,
            x0: gridXs[curStart],
            x1: gridXs[c],
          });
          curStart = c;
        }
      }
      rowGroupBounds.push({
        startCol: curStart,
        endCol: numCols - 1,
        x0: gridXs[curStart],
        x1: gridXs[numCols],
      });

      const byGroup = new Map<number, PositionedItem[]>();
      for (const it of rowItems) {
        const cx = clamp(it.x + it.width / 2, 0, blockW - 0.001);
        let gIdx = 0;
        for (let g = 0; g < rowGroupBounds.length; g++) {
          if (cx >= rowGroupBounds[g].x0 - ptToIn(2) && cx <= rowGroupBounds[g].x1 + ptToIn(2)) {
            gIdx = g;
            break;
          }
        }
        const arr = byGroup.get(gIdx) ?? [];
        arr.push(it);
        byGroup.set(gIdx, arr);
      }

      const spanOverrides = new WeakMap<PositionedItem, { startCol: number; endCol: number; centerAlign?: boolean }>();
      const mergedCells = Array.from(byGroup.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([gIdx, list]) => {
          const grp = rowGroupBounds[gIdx];
          const merged = this.mergeCellBucketItems(list, grp.x1 - grp.x0);
          const grpCenterX = (grp.x0 + grp.x1) / 2;
          const minTX = Math.min(...list.map((i) => i.x));
          const maxTX = Math.max(...list.map((i) => i.x + i.width));
          const textCenterX = (minTX + maxTX) / 2;
          const isCentered = Math.abs(textCenterX - grpCenterX) <= ptToIn(4);
          spanOverrides.set(merged, {
            startCol: grp.startCol,
            endCol: grp.endCol,
            centerAlign: isCentered,
          });
          return merged;
        });

      const rowRects = tableRects.filter(
        (rc) => midY >= rc.y - ptToIn(2) && midY <= rc.y + rc.height + ptToIn(2)
      );
      const isHdr =
        (iIdx === 0 || rowGroupBounds.length < numCols) &&
        (mergedCells.every((it) => it.region.style.bold) ||
          rowRects.some((rc) => Boolean(rc.region.style.backgroundColor)));

      logicalRows.push({
        yTop: yA,
        yBottom: yB,
        items: mergedCells,
        rects: rowRects,
        isHeaderRow: isHdr,
        spanOverrides,
      });
    }

    if (logicalRows.length < 2) return null;
    return { atomicColBoundaries: gridXs, logicalRows };
  }

  private compactEmbeddedSubTableZones(
    rows: LogicalRowBucket[],
    tableRects: PositionedItem[],
    lineItems: PositionedItem[],
    blockW: number,
    contentSpanY: number,
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS
  ): LogicalRowBucket[] {
    if (rows.length < 2 || tableRects.length < 2) return rows;

    const sortedRects = [...tableRects].sort((a, b) => a.y - b.y);
    const zones: Array<{ yTop: number; yBottom: number; rects: PositionedItem[] }> = [];
    for (const rc of sortedRects) {
      const last = zones[zones.length - 1];
      if (last && rc.y <= last.yBottom + ptToIn(6)) {
        last.yBottom = Math.max(last.yBottom, rc.y + rc.height);
        last.rects.push(rc);
      } else {
        zones.push({ yTop: rc.y, yBottom: rc.y + rc.height, rects: [rc] });
      }
    }

    const validZones = zones.filter((z) => {
      if (z.rects.length < 2) return false;
      if (contentSpanY > 0 && z.yBottom - z.yTop >= contentSpanY * 0.65) return false;
      const xs = clusterValues(
        z.rects.flatMap((r) => [clamp(r.x, 0, blockW), clamp(r.x + r.width, 0, blockW)]),
        ptToIn(2.5)
      );
      const ys = clusterValues(z.rects.flatMap((r) => [r.y, r.y + r.height]), ptToIn(weights.yRowClusterTolPt));
      return xs.length >= 3 && ys.length >= 2;
    });
    if (validZones.length === 0) return rows;

    let currentRows = rows;
    for (const zone of validZones) {
      const zVLines = lineItems.filter(
        (ln) =>
          ln.width <= ptToIn(3) &&
          ln.height >= ptToIn(10) &&
          ln.y + ln.height >= zone.yTop - ptToIn(4) &&
          ln.y <= zone.yBottom + ptToIn(4)
      );
      const zHLines = lineItems.filter(
        (ln) =>
          ln.height <= ptToIn(3) &&
          ln.width >= ptToIn(20) &&
          ln.y >= zone.yTop - ptToIn(4) &&
          ln.y <= zone.yBottom + ptToIn(4)
      );
      const subGridXs = clusterValues(
        [
          ...zone.rects.flatMap((r) => [clamp(r.x, 0, blockW), clamp(r.x + r.width, 0, blockW)]),
          ...zVLines.map((l) => clamp(l.x, 0, blockW)),
        ],
        ptToIn(2.5)
      );
      const subGridYs = clusterValues(
        [...zone.rects.flatMap((r) => [r.y, r.y + r.height]), ...zHLines.map((l) => l.y)],
        ptToIn(weights.yRowClusterTolPt)
      );
      if (subGridXs.length < 3 || subGridYs.length < 2) continue;

      const before: LogicalRowBucket[] = [];
      const insideItems: PositionedItem[] = [];
      const after: LogicalRowBucket[] = [];

      for (const r of currentRows) {
        const midY = (r.yTop + r.yBottom) / 2;
        if (midY < zone.yTop - ptToIn(2)) {
          before.push(r);
        } else if (midY > zone.yBottom + ptToIn(2)) {
          after.push(r);
        } else {
          insideItems.push(...r.items);
        }
      }

      if (insideItems.length === 0) continue;
      const expandedInside = this.expandMultilineItems(insideItems);
      const subRows: LogicalRowBucket[] = [];
      for (let k = 0; k < subGridYs.length - 1; k++) {
        const yA = subGridYs[k];
        const yB = subGridYs[k + 1];
        if (yB - yA < ptToIn(4)) continue;
        const rowItems = expandedInside.filter((it) => {
          const cy = it.y + it.height / 2;
          return cy >= yA - ptToIn(2) && cy <= yB + ptToIn(2);
        });
        if (rowItems.length === 0) continue;

        const byCol = new Map<number, PositionedItem[]>();
        for (const it of rowItems) {
          const cx = it.x + it.width / 2;
          let col = 0;
          for (let c = 0; c < subGridXs.length - 1; c++) {
            if (cx >= subGridXs[c] - ptToIn(2) && cx <= subGridXs[c + 1] + ptToIn(2)) {
              col = c;
              break;
            }
          }
          const arr = byCol.get(col) ?? [];
          arr.push(it);
          byCol.set(col, arr);
        }

        const mergedCells = Array.from(byCol.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([colIdx, list]) =>
            this.mergeCellBucketItems(
              list,
              colIdx + 1 < subGridXs.length ? subGridXs[colIdx + 1] - subGridXs[colIdx] : undefined
            )
          );
        const midY = (yA + yB) / 2;
        const rowRects = zone.rects.filter(
          (rc) => midY >= rc.y - ptToIn(2) && midY <= rc.y + rc.height + ptToIn(2)
        );
        subRows.push({
          yTop: yA,
          yBottom: yB,
          items: mergedCells,
          rects: rowRects,
          isHeaderRow: k === 0 && (mergedCells.every((it) => it.region.style.bold) || rowRects.some((rc) => Boolean(rc.region.style.backgroundColor))),
          isSubTableRow: true,
        });
      }

      if (subRows.length > 0) {
        currentRows = [...before, ...subRows, ...after];
      }
    }

    return currentRows;
  }

  private buildAtomicMasterColumnGrid(
    rows: LogicalRowBucket[],
    rectItems: PositionedItem[],
    lineItems: PositionedItem[],
    blockW: number,
    blockLeftIn = 0,
    pageNumber = 1,
    bodyTopOriginIn = 0,
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS,
    constraints: CalibrationConstraints = { forbidColumnSplits: [], forceTablixSplitsY: [], forceRowSplitsY: [] }
  ): number[] {
    const tolIn = ptToIn(weights.xClusterTolPt); // Cluster column X edges within <= xClusterTolPt
    const rawEdges: number[] = [0, blockW];
    const yPageShift = (pageNumber - 1) * 100;

    const isForbiddenColX = (relXIn: number, relYIn: number): boolean => {
      const absXPt = inToPt(blockLeftIn + relXIn);
      const absYPt = inToPt(Math.max(0, relYIn - yPageShift) + bodyTopOriginIn);
      return constraints.forbidColumnSplits.some(
        (fc) =>
          fc.pageNumber === pageNumber &&
          absXPt >= fc.xMinPt - 2 &&
          absXPt <= fc.xMaxPt + 2 &&
          absYPt >= fc.yMinPt - 4 &&
          absYPt <= fc.yMaxPt + 4
      );
    };

    // Add edges from structural cell rects (excluding full-width outer background rects and forbidden split boxes)
    for (const rc of rectItems) {
      if (rc.width < blockW * 0.94 && rc.height <= ptToIn(120)) {
        const rx0 = clamp(rc.x, 0, blockW);
        const rx1 = clamp(rc.x + rc.width, 0, blockW);
        if (!isForbiddenColX(rx0, rc.y)) rawEdges.push(rx0);
        if (!isForbiddenColX(rx1, rc.y)) rawEdges.push(rx1);
      }
    }

    // Add edges from vertical vector separator lines
    for (const ln of lineItems) {
      if (ln.width <= ptToIn(3) && ln.height >= ptToIn(8)) {
        const lx = clamp(ln.x, 0, blockW);
        if (!isForbiddenColX(lx, ln.y)) {
          rawEdges.push(lx);
        }
      }
    }

    // Register indented sub-marker column edges (x_marker and x_body when x_body - x_marker >= 8pt)
    // and start X edges from multi-cell narrative rows (never from sub-table rows whose grid comes from rect/line edges)
    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      if (row.items.length === 0 || row.isSubTableRow) continue;
      const firstText = (row.items[0].region.text ?? '').trim();
      if (STANDALONE_MARKER_RE.test(firstText)) {
        const xMarker = clamp(row.items[0].x, 0, blockW);
        if (!isForbiddenColX(xMarker, row.yTop)) {
          if (row.items.length >= 2) {
            const xBody = clamp(row.items[1].x, 0, blockW);
            rawEdges.push(xMarker);
            if (xBody - xMarker >= ptToIn(8) && !isForbiddenColX(xBody, row.yTop)) {
              rawEdges.push(xBody);
            }
          } else if (rIdx + 1 < rows.length && rows[rIdx + 1].items.length >= 1) {
            const nextItem = rows[rIdx + 1].items[0];
            const xBody = clamp(nextItem.x, 0, blockW);
            if (nextItem.y - row.yTop <= ptToIn(18) && xBody - xMarker >= ptToIn(8)) {
              rawEdges.push(xMarker);
              if (!isForbiddenColX(xBody, nextItem.y)) {
                rawEdges.push(xBody);
              }
            }
          }
        }
      }
      if (row.items.length >= 2) {
        for (const it of row.items) {
          const candidateX = clamp(it.x, 0, blockW);
          if (!isForbiddenColX(candidateX, it.y)) {
            rawEdges.push(candidateX);
          }
        }
      }
    }

    const clustered = clusterValues(rawEdges, tolIn);
    const minColW = ptToIn(8);
    const cleaned: number[] = [0];
    for (let i = 1; i < clustered.length - 1; i++) {
      const prev = cleaned[cleaned.length - 1];
      if (clustered[i] - prev >= minColW && blockW - clustered[i] >= minColW) {
        cleaned.push(clustered[i]);
      }
    }
    cleaned.push(blockW);

    const hasDenseTable = rows.filter((r) => r.items.length >= 4).length >= 3;
    if (!hasDenseTable && cleaned.length === 2 && rows.some((r) => r.items.length >= 2)) {
      const starts = rows
        .filter((r) => r.items.length >= 2)
        .flatMap((r) => r.items.slice(1).map((it) => it.x))
        .filter((x) => x >= minColW && blockW - x >= minColW);
      if (starts.length > 0) {
        const medianX = starts.sort((a, b) => a - b)[Math.floor(starts.length / 2)];
        return [0, roundIn(medianX), blockW];
      }
    }

    return cleaned;
  }

  private mapItemToAtomicSpan(
    item: PositionedItem,
    boundaries: number[],
    numCols: number,
    rowItems: PositionedItem[],
    isDataTable: boolean,
    rowRects: PositionedItem[],
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS
  ): { startCol: number; endCol: number } {
    const tol = ptToIn(weights.leftAnchorTolPt);
    const itemIdx = rowItems.indexOf(item);
    const nextItem = itemIdx >= 0 && itemIdx + 1 < rowItems.length ? rowItems[itemIdx + 1] : undefined;

    const itemMidX = item.x + item.width / 2;
    const enclosingNarrowRect = rowRects
      .filter(
        (rc) =>
          rc.width < boundaries[numCols] * 0.90 &&
          ((itemMidX >= rc.x - tol && itemMidX <= rc.x + rc.width + tol) ||
            (item.x >= rc.x - tol && item.x < rc.x + rc.width - ptToIn(2)))
      )
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];

    // Anchor startCol to enclosing rect left edge when inside a cell rect, otherwise item left edge (x0)
    const anchorX = enclosingNarrowRect ? enclosingNarrowRect.x : item.x;
    let startCol = 0;
    let bestSnapDist = Infinity;
    let snappedByTol = false;
    for (let c = 0; c < numCols; c++) {
      const dist = Math.abs(anchorX - boundaries[c]);
      if (dist <= tol && dist < bestSnapDist) {
        bestSnapDist = dist;
        startCol = c;
        snappedByTol = true;
      }
    }
    if (!snappedByTol) {
      for (let c = 0; c < numCols; c++) {
        if (anchorX >= boundaries[c]) {
          startCol = c;
        }
      }
    }

    const txt = (item.region.text ?? '').trim();
    const isMarkerFollowedByTrailing =
      rowItems.length === 2 &&
      itemIdx === 1 &&
      STANDALONE_MARKER_RE.test((rowItems[0].region.text ?? '').trim());
    const isSingleFullTrackNarrative =
      rowItems.length === 1 &&
      rowRects.length === 0 &&
      (Boolean(item.region.style.bold) ||
        item.width > (boundaries[Math.min(numCols, startCol + 1)] - item.x) + ptToIn(4) ||
        CLAUSE_TITLE_WITH_MARKER_RE.test(txt) ||
        txt.length > 35 ||
        !isDataTable);

    const shouldExtendToRightmost =
      !nextItem &&
      !enclosingNarrowRect &&
      (!isDataTable ||
        rowRects.length === 0 ||
        isMarkerFollowedByTrailing ||
        isSingleFullTrackNarrative);

    if (shouldExtendToRightmost) {
      return { startCol, endCol: numCols - 1 };
    }

    const effectiveRight = nextItem
      ? Math.min(enclosingNarrowRect ? enclosingNarrowRect.x + enclosingNarrowRect.width : item.x + item.width, nextItem.x - ptToIn(2))
      : enclosingNarrowRect
        ? Math.min(boundaries[numCols], enclosingNarrowRect.x + enclosingNarrowRect.width)
        : item.x + item.width;

    // Extend ColSpan across all atomic columns up to right edge (x1)
    let endCol = startCol;
    for (let c = startCol; c < numCols; c++) {
      if (effectiveRight > boundaries[c] + ptToIn(3)) {
        endCol = c;
      }
    }

    if (nextItem) {
      let nextStart = numCols;
      let nextBestDist = Infinity;
      let nextSnapped = false;
      for (let c = 0; c < numCols; c++) {
        const dist = Math.abs(nextItem.x - boundaries[c]);
        if (dist <= tol && dist < nextBestDist) {
          nextBestDist = dist;
          nextStart = c;
          nextSnapped = true;
        }
      }
      if (!nextSnapped) {
        for (let c = 0; c < numCols; c++) {
          if (nextItem.x >= boundaries[c]) nextStart = c;
        }
      }
      if (endCol >= nextStart && nextStart > startCol) {
        endCol = nextStart - 1;
      }
    }

    return { startCol, endCol: Math.max(startCol, Math.min(numCols - 1, endCol)) };
  }

  private detectStructuredDataTable(
    rows: LogicalRowBucket[],
    rectItems: PositionedItem[],
    numCols: number
  ): boolean {
    if (numCols >= 4 && rows.length >= 4) return true;
    const borderedRects = rectItems.filter(
      (r) => Boolean(r.region.style.borderColor) || Boolean(r.region.style.backgroundColor)
    );
    if (borderedRects.length >= 4 && numCols >= 3) return true;
    const numericRows = rows.filter(
      (r) =>
        r.items.length >= 3 &&
        r.items.slice(1).some((it) => /[0-9]/.test(it.region.text ?? ''))
    );
    return numericRows.length >= 3;
  }

  private buildTableCellStyle(
    textStyle: RegionStyle | undefined,
    rectStyle: RegionStyle | undefined,
    applyGridBorder: boolean,
    isHeaderRow: boolean,
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS
  ): RegionStyle {
    const fontSizePt = textStyle?.fontSizePt ?? 8.5;
    const padV = Math.max(0.25, Math.round((weights.cellPadVerticalPt / 2) * 100) / 100);
    const padH = Math.max(1.5, Math.round(weights.cellPadHorizontalPt * 0.75 * 100) / 100);
    const base: RegionStyle = {
      fontFamily: textStyle?.fontFamily ?? 'Arial',
      fontSizePt,
      bold: textStyle?.bold ?? isHeaderRow,
      italic: textStyle?.italic ?? false,
      underline: textStyle?.underline,
      color: textStyle?.color ?? '#0F172A',
      backgroundColor: rectStyle?.backgroundColor ?? textStyle?.backgroundColor,
      borderColor: applyGridBorder ? '#D0D7DE' : rectStyle?.borderColor,
      borderWidthPt: applyGridBorder ? 0.5 : rectStyle?.borderWidthPt,
      textAlign: textStyle?.textAlign ?? (isHeaderRow ? 'Center' : 'Left'),
      verticalAlign: isHeaderRow ? 'Middle' : 'Top',
      lineHeightPt: Math.round(fontSizePt * weights.lineHeightMultiplier * 100) / 100,
      paddingPt: { top: padV, right: padH, bottom: padV, left: padH },
    };
    return base;
  }

  private mergeOverSplitTablixRows(
    tablixRows: TablixRow[],
    emittedLogicalRows: LogicalRowBucket[],
    columnWidthsIn: number[],
    hasBannerRow: boolean,
    minRowHeightPt: number,
    weights: CompilerWeights
  ): void {
    const startIdx = hasBannerRow ? 1 : 0;
    let i = startIdx;
    while (i + 1 < tablixRows.length) {
      const r1 = tablixRows[i];
      const r2 = tablixRows[i + 1];
      const lrIdx1 = i - startIdx;
      const lrIdx2 = i + 1 - startIdx;
      const lr1 = emittedLogicalRows[lrIdx1];
      const lr2 = emittedLogicalRows[lrIdx2];
      if (!lr1 || !lr2 || lr1.isHeaderRow || lr2.isHeaderRow || lr1.isSubTableRow || lr2.isSubTableRow) {
        i++;
        continue;
      }

      const nonEmpty1 = r1.cells.filter(
        (c) => !c.skipBecauseMerged && c.content.kind === 'Textbox' && c.content.value.trim().length > 0
      );
      const nonEmpty2 = r2.cells.filter(
        (c) => !c.skipBecauseMerged && c.content.kind === 'Textbox' && c.content.value.trim().length > 0
      );

      if (nonEmpty2.length !== 1 || nonEmpty1.length === 0 || nonEmpty1.length > 2) {
        i++;
        continue;
      }

      // Target cell in r1 is either the single cell or the trailing text after a standalone marker
      const c1 =
        nonEmpty1.length === 1
          ? nonEmpty1[0]
          : STANDALONE_MARKER_RE.test(
              nonEmpty1[0].content.kind === 'Textbox' ? nonEmpty1[0].content.value.trim() : ''
            )
            ? nonEmpty1[1]
            : undefined;
      const c2 = nonEmpty2[0];
      if (!c1 || c1.content.kind !== 'Textbox' || c2.content.kind !== 'Textbox') {
        i++;
        continue;
      }

      const tb1 = c1.content;
      const tb2 = c2.content;
      const val1 = tb1.value.trim();
      const val2 = tb2.value.trim();
      if (!val1 || !val2 || /:$/.test(val1)) {
        i++;
        continue;
      }
      if (CLAUSE_TITLE_WITH_MARKER_RE.test(val2) || STANDALONE_MARKER_RE.test(val2)) {
        i++;
        continue;
      }
      if (tb1.style.bold || tb2.style.bold || tb1.style.italic !== tb2.style.italic) {
        i++;
        continue;
      }
      if (Math.abs((tb1.style.fontSizePt || 8.5) - (tb2.style.fontSizePt || 8.5)) > 1.0) {
        i++;
        continue;
      }
      if ((tb1.style.color ?? '').toUpperCase() !== (tb2.style.color ?? '').toUpperCase()) {
        i++;
        continue;
      }
      if ((tb1.style.backgroundColor ?? '') !== (tb2.style.backgroundColor ?? '')) {
        i++;
        continue;
      }
      if (tb1.style.borderColor || tb2.style.borderColor || tb1.style.borderEdges || tb2.style.borderEdges) {
        i++;
        continue;
      }

      const sameCol = c1.colIndex === c2.colIndex;
      const sameX0 =
        tb1.sourceX0In !== undefined &&
        tb2.sourceX0In !== undefined &&
        Math.abs(inToPt(tb1.sourceX0In - tb2.sourceX0In)) <= 4;
      if (!sameCol && !sameX0) {
        i++;
        continue;
      }

      // Merge r2 into r1
      tb1.value = `${val1} ${val2}`.replace(/\s+/g, ' ').trim();
      const runs1 = tb1.runs ? [...tb1.runs] : [];
      const runs2 = tb2.runs ? [...tb2.runs] : [];
      if (runs1.length > 0 && runs2.length > 0) {
        if (!/\s$/.test(runs1[runs1.length - 1].text) && !/^\s/.test(runs2[0].text)) {
          runs1.push({ ...runs1[runs1.length - 1], text: ' ' });
        }
        tb1.runs = [...runs1, ...runs2];
      }
      tb1.sourceLineCount = (tb1.sourceLineCount ?? 1) + (tb2.sourceLineCount ?? 1);
      if (tb2.sourceYMaxPt !== undefined) {
        tb1.sourceYMaxPt = Math.max(tb1.sourceYMaxPt ?? tb2.sourceYMaxPt, tb2.sourceYMaxPt);
      }

      const coveredWidthPt = inToPt(
        columnWidthsIn
          .slice(c1.colIndex, Math.min(columnWidthsIn.length, c1.colIndex + c1.colSpan))
          .reduce((s, w) => s + w, 0)
      );
      const rowHeightInputs = r1.cells
        .filter((cell) => !cell.skipBecauseMerged && cell.content.kind === 'Textbox')
        .map((cell) => {
          const ct = cell.content as Extract<typeof cell.content, { kind: 'Textbox' }>;
          const cw = inToPt(
            columnWidthsIn
              .slice(cell.colIndex, Math.min(columnWidthsIn.length, cell.colIndex + cell.colSpan))
              .reduce((s, w) => s + w, 0)
          );
          return {
            text: ct.value,
            runs: ct.runs,
            style: ct.style,
            coveredWidthPt: cell === c1 ? coveredWidthPt : cw,
          };
        });
      r1.heightIn = roundIn(
        ptToIn(estimateWrappedRowHeightPt(rowHeightInputs, minRowHeightPt, weights))
      );

      lr1.yBottom = Math.max(lr1.yBottom, lr2.yBottom);
      lr1.items = [...lr1.items, ...lr2.items];
      tablixRows.splice(i + 1, 1);
      emittedLogicalRows.splice(lrIdx2, 1);
    }

    for (let rIdx = 0; rIdx < tablixRows.length; rIdx++) {
      for (const cell of tablixRows[rIdx].cells) {
        cell.rowIndex = rIdx;
      }
    }
  }

  private applyVerticalMergeBorderSuppression(
    tablixRows: TablixRow[],
    rectItems: PositionedItem[],
    lineItems: PositionedItem[],
    logicalRows: LogicalRowBucket[],
    atomicBoundaries: number[],
    isDataTable: boolean
  ): void {
    const bannerOffset = tablixRows.length - logicalRows.length;
    if (logicalRows.length < 2) return;

    const numCols = atomicBoundaries.length - 1;

    const suppressVerticalGroup = (rowIndices: number[], targetCol: number) => {
      if (rowIndices.length < 2) return;
      const firstRowCell = tablixRows[rowIndices[0]]?.cells[targetCol];
      if (!firstRowCell || firstRowCell.skipBecauseMerged || firstRowCell.content.kind !== 'Textbox') return;
      if (!firstRowCell.content.value.trim()) return;

      const subsequentAllEmpty = rowIndices.slice(1).every((rIdx) => {
        const c = tablixRows[rIdx]?.cells[targetCol];
        return c && !c.skipBecauseMerged && c.content.kind === 'Textbox' && !c.content.value.trim();
      });
      if (!subsequentAllEmpty) return;

      for (let k = 0; k < rowIndices.length; k++) {
        const cell = tablixRows[rowIndices[k]].cells[targetCol];
        if (cell.content.kind !== 'Textbox') continue;
        const borderCol = cell.content.style.borderColor ?? '#D0D7DE';
        const borderW = cell.content.style.borderWidthPt ?? 0.5;
        const solidEdge: CellBorderEdge = { style: 'Solid', color: borderCol, widthPt: borderW };
        const noneEdge: CellBorderEdge = { style: 'None' };
        cell.content.style.borderEdges = {
          left: solidEdge,
          right: solidEdge,
          top: k === 0 ? solidEdge : noneEdge,
          bottom: k === rowIndices.length - 1 ? solidEdge : noneEdge,
        };
      }
    };

    // Pass A: Detect bordered/shaded rects whose vertical span covers K >= 2 logical rows in a column slice
    for (const rc of rectItems) {
      if (!rc.region.style.borderColor && !rc.region.style.backgroundColor) continue;
      const spannedRowIndices: number[] = [];
      for (let lrIdx = 0; lrIdx < logicalRows.length; lrIdx++) {
        const lr = logicalRows[lrIdx];
        const midY = (lr.yTop + lr.yBottom) / 2;
        if (midY >= rc.y - ptToIn(2) && midY <= rc.y + rc.height + ptToIn(2)) {
          spannedRowIndices.push(lrIdx + bannerOffset);
        }
      }
      if (spannedRowIndices.length < 2) continue;

      let targetCol = -1;
      for (let c = 0; c < numCols; c++) {
        const colMid = (atomicBoundaries[c] + atomicBoundaries[c + 1]) / 2;
        if (colMid >= rc.x - ptToIn(2) && colMid <= rc.x + rc.width + ptToIn(2)) {
          targetCol = c;
          break;
        }
      }
      if (targetCol < 0) continue;
      suppressVerticalGroup(spannedRowIndices, targetCol);
    }

    // Pass B: In structured data tables, merge consecutive empty-below group label cells (e.g. "Dana Mapan", "3 Tahun")
    // when no horizontal vector line separates the rows inside that column.
    if (!isDataTable || numCols < 3) return;
    const horizLines = lineItems.filter((ln) => ln.height <= ptToIn(3) && ln.width >= ptToIn(10));
    const hasHorizSeparatorBetween = (colIdx: number, y1: number, y2: number): boolean => {
      const colX1 = atomicBoundaries[colIdx];
      const colX2 = atomicBoundaries[colIdx + 1];
      const colMid = (colX1 + colX2) / 2;
      return horizLines.some(
        (ln) =>
          ln.y >= y1 - ptToIn(2) &&
          ln.y <= y2 + ptToIn(2) &&
          ln.x <= colMid &&
          ln.x + ln.width >= colMid
      );
    };

    for (let c = 0; c < Math.min(2, numCols - 1); c++) {
      let lrIdx = 0;
      while (lrIdx < logicalRows.length) {
        const lr = logicalRows[lrIdx];
        const outIdx = lrIdx + bannerOffset;
        const cell = tablixRows[outIdx]?.cells[c];
        if (
          lr.isHeaderRow ||
          !cell ||
          cell.skipBecauseMerged ||
          cell.content.kind !== 'Textbox' ||
          !cell.content.value.trim() ||
          cell.content.style.borderEdges
        ) {
          lrIdx++;
          continue;
        }

        const group = [outIdx];
        let nextLrIdx = lrIdx + 1;
        while (nextLrIdx < logicalRows.length) {
          const nextLr = logicalRows[nextLrIdx];
          if (nextLr.isHeaderRow) break;
          const nextOutIdx = nextLrIdx + bannerOffset;
          const nextCell = tablixRows[nextOutIdx]?.cells[c];
          if (
            !nextCell ||
            nextCell.skipBecauseMerged ||
            nextCell.content.kind !== 'Textbox' ||
            nextCell.content.value.trim().length > 0
          ) {
            break;
          }
          // Verify row has data in columns to the right so blank filler rows aren't grouped
          const hasRightData = tablixRows[nextOutIdx].cells
            .slice(c + 1)
            .some((rc) => !rc.skipBecauseMerged && rc.content.kind === 'Textbox' && rc.content.value.trim().length > 0);
          if (!hasRightData) break;

          const prevLr = logicalRows[nextLrIdx - 1];
          if (hasHorizSeparatorBetween(c, prevLr.yBottom, nextLr.yTop)) break;

          group.push(nextOutIdx);
          nextLrIdx++;
        }

        if (group.length >= 2) {
          suppressVerticalGroup(group, c);
        }
        lrIdx = Math.max(lrIdx + 1, nextLrIdx);
      }
    }
  }
}
