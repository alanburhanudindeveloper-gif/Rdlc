import crypto from 'crypto';
import {
  CellBorderEdge,
  LayoutPage,
  LayoutRegion,
  LayoutSectionSummary,
  RdlcBandContainerSpec,
  RdlcDocumentHierarchy,
  RegionStyle,
  ReportFieldDef,
  StructuredLogger,
  TablixCell,
  TablixRegion,
  TablixRow,
  VisualImageItem,
  VisualParagraphSpec,
  VisualRectItem,
  VisualTextboxItem,
  VisualTextRun,
} from '../core/types.ts';
import { ParameterDetectionContext, parameterizeTextRuns } from './parameterDetector.ts';

const PT_PER_INCH = 72;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function roundIn(val: number): number {
  return Math.round(val * 1000) / 1000;
}

export function sanitizeV3Identifier(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  if (!cleaned) return fallback;
  return /^[0-9]/.test(cleaned) ? `T_${cleaned}` : cleaned;
}

function makeSectionSlug(text: string | undefined, fallback: string): string {
  if (!text) return fallback;
  const words = text
    .replace(/[^A-Za-z0-9\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !/^\d+$/.test(w))
    .slice(0, 4);
  if (words.length === 0) return fallback;
  const joined = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
  return sanitizeV3Identifier(joined.slice(0, 28), fallback);
}

function normalizeChromeText(text: string): string {
  return text
    .trim()
    .replace(/\b(Hal\.?|Halaman|Page)\s+\d+(\s+(?:dari|of)\s+\d+)?\b/gi, '$1 # $2')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildDynamicPageFooterExpr(rawText: string): string | undefined {
  const fullMatch = rawText.match(
    /^(.*?\b(?:Hal\.?|Halaman|Page)\s+)(\d+)(\s+(?:dari|of)\s+)(\d+)(.*)$/i
  );
  if (fullMatch) {
    const esc = (s: string) => s.replace(/"/g, '""');
    const parts: string[] = [];
    if (fullMatch[1]) parts.push(`"${esc(fullMatch[1])}"`);
    parts.push('Globals!PageNumber');
    parts.push(`"${esc(fullMatch[3])}"`);
    parts.push('Globals!TotalPages');
    if (fullMatch[5]) parts.push(`"${esc(fullMatch[5])}"`);
    return `=${parts.join(' & ')}`;
  }
  const singleMatch = rawText.match(/^(.*?\b(?:Hal\.?|Halaman|Page)\s+)(\d+)(.*)$/i);
  if (singleMatch) {
    const esc = (s: string) => s.replace(/"/g, '""');
    const parts: string[] = [];
    if (singleMatch[1]) parts.push(`"${esc(singleMatch[1])}"`);
    parts.push('Globals!PageNumber');
    if (singleMatch[3]) parts.push(`"${esc(singleMatch[3])}"`);
    return `=${parts.join(' & ')}`;
  }
  return undefined;
}

function regionSignature(r: LayoutRegion): string {
  const yBucket = Math.round(r.y * 12);
  const xBucket = Math.round(r.x * 8);
  if (r.type === 'text' && r.text) {
    return `txt::${yBucket}::${xBucket}::${normalizeChromeText(r.text)}`;
  }
  if ((r.type === 'image' || r.type === 'vector_complex') && r.imageAssetBase64) {
    const sha = crypto.createHash('sha256').update(r.imageAssetBase64).digest('hex').slice(0, 12);
    return `img::${yBucket}::${xBucket}::${sha}`;
  }
  const wBucket = Math.round(r.width * 8);
  const hBucket = Math.round(r.height * 12);
  const col = r.style.backgroundColor ?? r.style.borderColor ?? '';
  return `vec::${yBucket}::${xBucket}::${wBucket}x${hBucket}::${col}`;
}

function isLikelyHeadingRegion(r: LayoutRegion, bodyMedianFontPt: number): boolean {
  if (r.type !== 'text' || !r.text) return false;
  const txt = r.text.trim();
  if (!txt || txt.length > 95) return false;
  if (r.semanticRole === 'reportTitle' || r.semanticRole === 'sectionHeading') return true;
  if (r.style.fontSizePt >= bodyMedianFontPt + 1.5 && r.style.bold) return true;
  if (r.style.bold && txt.length <= 55 && txt === txt.toUpperCase() && /[A-Z]/.test(txt)) return true;
  if (/^(?:[A-Z]\.|BAB\s+[IVX0-9]+|PASAL\s+\d+)/i.test(txt) && r.style.bold) return true;
  return false;
}

const CLAUSE_PREFIX_RE = /^(\d+(?:\.\d+)*\.|\([ivxa-z0-9]+\)|[a-z][\.\)]|[•\u2022\-–*])\s+(.+)$/i;
const STANDALONE_MARKER_RE = /^(\d+(?:\.\d+)*\.?|\([ivxa-z0-9]+\)|[a-z][\.\)]|[•\u2022\-–*])$/i;

function ptToIn(pt: number): number {
  return pt / PT_PER_INCH;
}

function inToPt(inches: number): number {
  return inches * PT_PER_INCH;
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
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function isNonWhiteFill(hex?: string): boolean {
  const rgb = parseHexRgb(hex);
  if (!rgb) return false;
  const lum = relativeLuminance(rgb);
  const chroma = Math.max(...rgb) - Math.min(...rgb);
  return lum < 0.88 || chroma >= 24;
}

function isBannerCandidateRect(r: LayoutRegion, trackOrPageWidthIn: number): boolean {
  if (r.type !== 'vector_rect') return false;
  if (r.height < ptToIn(10) || r.height > ptToIn(48)) return false;
  if (r.width < trackOrPageWidthIn * 0.25) return false;
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

function defaultTextStyle(fontSizePt = 8.5): RegionStyle {
  return {
    fontFamily: 'Arial',
    fontSizePt,
    bold: false,
    italic: false,
    color: '#0F172A',
    textAlign: 'Left',
    verticalAlign: 'Top',
    paddingPt: { top: 2, right: 3, bottom: 2, left: 3 },
  };
}

function estimateWrappedRowHeightPt(
  cells: Array<{
    text: string;
    runs?: VisualTextRun[];
    style: RegionStyle;
    coveredWidthPt: number;
  }>,
  minRowHeightPt = 13.5
): number {
  let maxH = minRowHeightPt;
  for (const c of cells) {
    const padL = c.style.paddingPt?.left ?? 2;
    const padR = c.style.paddingPt?.right ?? 2;
    const padT = c.style.paddingPt?.top ?? 2;
    const padB = c.style.paddingPt?.bottom ?? 2;
    const innerWidthPt = Math.max(16, c.coveredWidthPt - (padL + padR));
    const fontSizePt = Math.max(
      6.5,
      c.runs && c.runs.length > 0
        ? Math.max(...c.runs.map((r) => r.fontSizePt || c.style.fontSizePt))
        : c.style.fontSizePt || 8.5
    );
    const avgCharWidthPt = fontSizePt * (c.style.bold ? 0.58 : 0.545);
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
    const cellHeightPt = Math.max(
      minRowHeightPt,
      totalLines * (fontSizePt * 1.38) + padT + padB + (totalLines > 1 ? 1.5 : 0)
    );
    maxH = Math.max(maxH, cellHeightPt);
  }
  return maxH;
}

export interface V3CompileInput {
  pages: LayoutPage[];
  pageWidthIn: number;
  pageHeightIn: number;
  dataSetName: string;
  pageTablixesByPage: Map<number, TablixRegion[]>;
  coveredByTablixFn: (pageNumber: number, x: number, y: number, w: number, h: number) => boolean;
  paramCtx: ParameterDetectionContext;
  registerEmbeddedImage: (base64Data: string, preferredName: string) => string;
  nextUniqueName: (prefix: string) => string;
  fieldMap: Map<string, ReportFieldDef>;
}

export interface V3CompileOutput {
  pageHeaderSpec?: RdlcBandContainerSpec;
  pageFooterSpec?: RdlcBandContainerSpec;
  bodyTablixes: TablixRegion[];
  hierarchy: RdlcDocumentHierarchy;
}

interface DetectedChrome {
  pageHeader?: {
    heightIn: number;
    printOnFirstPage: boolean;
    printOnLastPage: boolean;
    regions: LayoutRegion[];
    matchedIdsByPage: Map<number, Set<string>>;
    textSignatures: Array<{ norm: string; x: number }>;
    imageShas: Array<{ sha: string; x: number }>;
  };
  pageFooter?: {
    topIn: number;
    heightIn: number;
    printOnFirstPage: boolean;
    printOnLastPage: boolean;
    regions: LayoutRegion[];
    matchedIdsByPage: Map<number, Set<string>>;
    textSignatures: Array<{ norm: string; x: number }>;
    imageShas: Array<{ sha: string; x: number }>;
  };
}

interface BodyItemBox {
  kind: 'rect' | 'line' | 'image' | 'text' | 'tablix';
  x: number;
  y: number;
  width: number;
  height: number;
  region?: LayoutRegion;
  tablix?: TablixRegion;
  rawIndex: number;
}

interface V3BannerElement {
  rect: BodyItemBox;
  titleText: string;
  textItems: BodyItemBox[];
  x: number;
  y: number;
  width: number;
  height: number;
  isFullWidth: boolean;
}

interface V3TrackBlock {
  semanticName: string;
  slug: string;
  track: 'full' | 'left' | 'right';
  leftIn: number;
  widthIn: number;
  pageNumber: number;
  pageBreakBefore: boolean;
  isBannerOnly?: boolean;
  isFootnote?: boolean;
  pairedStart?: boolean;
  banner?: V3BannerElement;
  items: BodyItemBox[];
}

interface V3LogicalRowBucket {
  yTop: number;
  yBottom: number;
  items: BodyItemBox[];
  rects: BodyItemBox[];
  isClauseTitleRow?: boolean;
  isHeaderRow?: boolean;
  isSubTableRow?: boolean;
}

export class V3TablixCompiler {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public compile(input: V3CompileInput): V3CompileOutput {
    const {
      pages,
      pageWidthIn,
      pageHeightIn,
      dataSetName,
      pageTablixesByPage,
      coveredByTablixFn,
      paramCtx,
      registerEmbeddedImage,
      nextUniqueName,
    } = input;

    // Stage 1: Expanded Header (top 20%) & Footer (bottom 13%) detection + Hard Body Exclusion
    const chrome = this.detectRepeatingHeaderFooter(pages, pageWidthIn, pageHeightIn, coveredByTablixFn);

    const pageHeaderSpec = chrome.pageHeader
      ? this.buildChromeBandSpec(
          'PageHeader',
          chrome.pageHeader.heightIn,
          0,
          pageWidthIn,
          chrome.pageHeader.printOnFirstPage,
          chrome.pageHeader.printOnLastPage,
          chrome.pageHeader.regions,
          paramCtx,
          registerEmbeddedImage,
          nextUniqueName
        )
      : undefined;

    const pageFooterSpec = chrome.pageFooter
      ? this.buildChromeBandSpec(
          'PageFooter',
          chrome.pageFooter.heightIn,
          chrome.pageFooter.topIn,
          pageWidthIn,
          chrome.pageFooter.printOnFirstPage,
          chrome.pageFooter.printOnLastPage,
          chrome.pageFooter.regions,
          paramCtx,
          registerEmbeddedImage,
          nextUniqueName
        )
      : undefined;

    const allFontSizes = pages
      .flatMap((p) => p.regions)
      .filter((r) => r.type === 'text')
      .map((r) => r.style.fontSizePt)
      .sort((a, b) => a - b);
    const bodyMedianFontPt =
      allFontSizes.length > 0 ? allFontSizes[Math.floor(allFontSizes.length / 2)] : 9;

    // Collect clean per-page body items first (excluding repeating PageHeader / PageFooter)
    const bodyItemsByPage = new Map<number, BodyItemBox[]>();
    const pageBodyHeights = new Map<number, number>();

    for (const page of pages) {
      const pNum = page.pageNumber;
      const showHeaderOnThisPage = Boolean(
        chrome.pageHeader && (pNum > 1 || chrome.pageHeader.printOnFirstPage)
      );
      const headerOffsetIn = showHeaderOnThisPage ? chrome.pageHeader!.heightIn : 0;
      const footerCutIn = chrome.pageFooter ? chrome.pageFooter.topIn : pageHeightIn;
      const pageBodyHeightIn = Math.max(
        1.0,
        roundIn(pageHeightIn - headerOffsetIn - (chrome.pageFooter ? chrome.pageFooter.heightIn : 0))
      );
      pageBodyHeights.set(pNum, pageBodyHeightIn);

      const headerExcludedIds = chrome.pageHeader?.matchedIdsByPage.get(pNum) ?? new Set<string>();
      const footerExcludedIds = chrome.pageFooter?.matchedIdsByPage.get(pNum) ?? new Set<string>();

      const isHardExcludedChrome = (r: LayoutRegion): boolean => {
        if (headerExcludedIds.has(r.id) || footerExcludedIds.has(r.id)) return true;
        if (showHeaderOnThisPage && r.y + r.height <= headerOffsetIn + 0.03) return true;
        if (chrome.pageFooter && r.y >= footerCutIn - 0.03) return true;

        if (r.type === 'text' && r.text) {
          const norm = normalizeChromeText(r.text);
          if (
            showHeaderOnThisPage &&
            chrome.pageHeader &&
            r.y <= pageHeightIn * 0.22 &&
            chrome.pageHeader.textSignatures.some(
              (sig) => sig.norm === norm && Math.abs(sig.x - r.x) <= 0.12
            )
          ) {
            return true;
          }
          if (
            chrome.pageFooter &&
            r.y >= pageHeightIn * 0.85 &&
            chrome.pageFooter.textSignatures.some(
              (sig) => sig.norm === norm && Math.abs(sig.x - r.x) <= 0.12
            )
          ) {
            return true;
          }
        }

        if ((r.type === 'image' || r.type === 'vector_complex') && r.imageAssetBase64) {
          const sha = crypto.createHash('sha256').update(r.imageAssetBase64).digest('hex').slice(0, 12);
          if (
            showHeaderOnThisPage &&
            chrome.pageHeader &&
            r.y <= pageHeightIn * 0.22 &&
            chrome.pageHeader.imageShas.some((s) => s.sha === sha && Math.abs(s.x - r.x) <= 0.12)
          ) {
            return true;
          }
          if (
            chrome.pageFooter &&
            r.y >= pageHeightIn * 0.85 &&
            chrome.pageFooter.imageShas.some((s) => s.sha === sha && Math.abs(s.x - r.x) <= 0.12)
          ) {
            return true;
          }
        }
        return false;
      };

      const bodyItems: BodyItemBox[] = [];
      let rawIdx = 0;

      // Preserve repeating detail Tablixes from TablixBuilder
      const pTablixes = pageTablixesByPage.get(pNum) ?? [];
      for (const tbl of pTablixes) {
        const localTop = Math.max(0, tbl.topIn - headerOffsetIn);
        bodyItems.push({
          kind: 'tablix',
          x: tbl.leftIn,
          y: localTop,
          width: tbl.widthIn,
          height: tbl.heightIn,
          tablix: { ...tbl, topIn: roundIn(localTop) },
          rawIndex: rawIdx++,
        });
      }

      for (const r of page.regions) {
        if (isHardExcludedChrome(r)) continue;
        if (coveredByTablixFn(pNum, r.x, r.y, r.width, r.height)) continue;

        // Skip invisible full-page white background fill
        if (
          r.type === 'vector_rect' &&
          r.width >= pageWidthIn - 0.12 &&
          r.height >= pageHeightIn - 0.12 &&
          (!r.style.backgroundColor || r.style.backgroundColor.toUpperCase() === '#FFFFFF') &&
          !r.style.borderColor
        ) {
          continue;
        }

        const isLineRegion = r.type === 'vector_line';
        const minDim = isLineRegion ? 0.005 : 0.015;
        const localY = Math.max(0, r.y - headerOffsetIn);
        const clampedX = clamp(r.x, 0, Math.max(0, pageWidthIn - minDim));
        const clampedW = clamp(r.width, minDim, pageWidthIn - clampedX);
        const clampedH = clamp(r.height, minDim, Math.max(minDim, pageBodyHeightIn - localY));

        const kind: BodyItemBox['kind'] =
          r.type === 'vector_line'
            ? 'line'
            : r.type === 'vector_rect'
              ? 'rect'
              : r.type === 'image' || r.type === 'vector_complex'
                ? 'image'
                : 'text';

        bodyItems.push({
          kind,
          x: clampedX,
          y: localY,
          width: clampedW,
          height: clampedH,
          region: r,
          rawIndex: rawIdx++,
        });
      }

      bodyItemsByPage.set(pNum, bodyItems);
    }

    // Stage 2: Persistent 2-Track Document Segmentation (splits side-by-side tracks into Tablix_Left & Tablix_Right + mid-track banners)
    const trackBlocks = this.segmentDocumentTracks(
      pages,
      bodyItemsByPage,
      roundIn(pageWidthIn),
      bodyMedianFontPt
    );

    const usedTablixNames = new Set<string>();
    const allocateTablixName = (desired: string): string => {
      const base = sanitizeV3Identifier(desired, 'Tablix_Section');
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

    const gapIn = roundIn(ptToIn(6));
    const sectionGapIn = roundIn(ptToIn(10));
    let fullCursorTopIn = 0;
    let leftTrackBottomIn = 0;
    let rightTrackBottomIn = 0;
    let prevWasSideBySide = false;
    let lastPageNum = pages[0]?.pageNumber ?? 1;

    for (const blk of trackBlocks) {
      // On page break, synchronize top cursor so new page starts cleanly from max bottom of previous page
      if (blk.pageNumber !== lastPageNum) {
        const pageStartTop = roundIn(Math.max(fullCursorTopIn, leftTrackBottomIn, rightTrackBottomIn) + sectionGapIn);
        fullCursorTopIn = pageStartTop;
        leftTrackBottomIn = pageStartTop;
        rightTrackBottomIn = pageStartTop;
        lastPageNum = blk.pageNumber;
      }

      let assignedTopIn: number;
      if (blk.track === 'full') {
        if (prevWasSideBySide) {
          fullCursorTopIn = roundIn(Math.max(fullCursorTopIn, leftTrackBottomIn, rightTrackBottomIn) + sectionGapIn);
          prevWasSideBySide = false;
        }
        assignedTopIn = roundIn(fullCursorTopIn);
      } else {
        if (!prevWasSideBySide) {
          const startY = roundIn(fullCursorTopIn);
          leftTrackBottomIn = startY;
          rightTrackBottomIn = startY;
          prevWasSideBySide = true;
        } else if (blk.pairedStart && blk.track === 'left') {
          const syncY = roundIn(Math.max(fullCursorTopIn, leftTrackBottomIn, rightTrackBottomIn));
          leftTrackBottomIn = syncY;
          rightTrackBottomIn = syncY;
        }
        assignedTopIn = blk.track === 'left' ? roundIn(leftTrackBottomIn) : roundIn(rightTrackBottomIn);
      }

      const tablixName = allocateTablixName(blk.semanticName);
      const compiled = this.compileTrackBlockToTablix(
        tablixName,
        blk,
        assignedTopIn,
        dataSetName,
        paramCtx,
        registerEmbeddedImage,
        nextUniqueName,
        bodyMedianFontPt
      );

      if (compiled.tablix.rows.length === 0) continue;

      compiled.tablix.slug = blk.slug;
      compiled.tablix.keepTogether = false;
      bodyTablixes.push(compiled.tablix);

      const postGap = blk.isBannerOnly ? ptToIn(1.5) : gapIn;
      if (blk.track === 'full') {
        fullCursorTopIn = roundIn(compiled.tablix.topIn + compiled.tablix.heightIn + postGap);
      } else if (blk.track === 'left') {
        leftTrackBottomIn = roundIn(compiled.tablix.topIn + compiled.tablix.heightIn + postGap);
      } else {
        rightTrackBottomIn = roundIn(compiled.tablix.topIn + compiled.tablix.heightIn + postGap);
      }

      sectionSummaries.push({
        name: compiled.tablix.name,
        slug: blk.slug,
        pageNumber: blk.pageNumber,
        pageBreakStart: Boolean(compiled.tablix.pageBreakBefore),
        topIn: compiled.tablix.topIn,
        leftIn: compiled.tablix.leftIn,
        widthIn: compiled.tablix.widthIn,
        heightIn: compiled.tablix.heightIn,
        layoutType: compiled.layoutType,
        rowCount: compiled.tablix.rows.length,
        colCount: compiled.tablix.columnWidthsIn.length,
        hasNestedTablixes: false,
        columnCount: compiled.columnCount,
        hasHeaderBand: Boolean(blk.banner),
        hasLeftColumn: blk.track === 'left',
        hasRightColumn: blk.track === 'right',
        hasFooterBand: Boolean(blk.isFootnote),
        childItemCount: compiled.childItemCount,
      });
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

    this.logger.info('V3TablixCompiler', 'Single-RDLC v3 Full-Tablix compilation complete', {
      hasPageHeader: Boolean(pageHeaderSpec),
      printOnFirstPage: pageHeaderSpec?.printOnFirstPage,
      hasPageFooter: Boolean(pageFooterSpec),
      bodyTablixes: bodyTablixes.length,
    });

    return {
      pageHeaderSpec,
      pageFooterSpec,
      bodyTablixes,
      hierarchy,
    };
  }

  private detectRepeatingHeaderFooter(
    pages: LayoutPage[],
    _pageWidthIn: number,
    pageHeightIn: number,
    coveredByTablixFn: (pageNumber: number, x: number, y: number, w: number, h: number) => boolean
  ): DetectedChrome {
    if (pages.length < 2) return {};

    const numPages = pages.length;
    const topBandLimitY = pageHeightIn * 0.20;
    const bottomBandLimitY = pageHeightIn * 0.87;
    const minConsensusAll = Math.max(2, Math.ceil(numPages * 0.6));
    const minConsensusTail = numPages >= 3 ? Math.max(2, Math.ceil((numPages - 1) * 0.6)) : 2;

    // --- HEADER DETECTION (top 20%) ---
    const headerSigCounts = new Map<string, { pages: Set<number>; sample: LayoutRegion }>();
    const tailSigCounts = new Map<string, { pages: Set<number>; sample: LayoutRegion }>();

    for (const p of pages) {
      const seenOnPage = new Set<string>();
      for (const r of p.regions) {
        if (r.y + r.height > topBandLimitY) continue;
        if (coveredByTablixFn(p.pageNumber, r.x, r.y, r.width, r.height)) continue;
        const sig = regionSignature(r);
        if (seenOnPage.has(sig)) continue;
        seenOnPage.add(sig);

        const allEntry = headerSigCounts.get(sig) ?? { pages: new Set<number>(), sample: r };
        allEntry.pages.add(p.pageNumber);
        headerSigCounts.set(sig, allEntry);

        if (p.pageNumber >= 2) {
          const tailEntry = tailSigCounts.get(sig) ?? { pages: new Set<number>(), sample: r };
          tailEntry.pages.add(p.pageNumber);
          tailSigCounts.set(sig, tailEntry);
        }
      }
    }

    const consensusTailSigs = new Set<string>();
    for (const [sig, info] of tailSigCounts.entries()) {
      if (info.pages.size >= minConsensusTail) consensusTailSigs.add(sig);
    }
    const consensusAllSigs = new Set<string>();
    for (const [sig, info] of headerSigCounts.entries()) {
      if (info.pages.size >= minConsensusAll) consensusAllSigs.add(sig);
    }

    const activeHeaderSigs =
      consensusAllSigs.size >= consensusTailSigs.size ? consensusAllSigs : consensusTailSigs;

    let pageHeader: DetectedChrome['pageHeader'];
    if (activeHeaderSigs.size > 0) {
      const templatePage = pages.find((p) => p.pageNumber >= 2) ?? pages[0];
      const matchedHeaderRegions = templatePage.regions.filter((r) => {
        if (r.y + r.height > topBandLimitY) return false;
        return activeHeaderSigs.has(regionSignature(r));
      });

      if (matchedHeaderRegions.length > 0) {
        const headerHeightIn = roundIn(
          clamp(
            Math.max(...matchedHeaderRegions.map((r) => r.y + r.height)) + 0.03,
            0.2,
            topBandLimitY
          )
        );
        const page1Sigs = new Set(
          pages[0].regions
            .filter((r) => r.y + r.height <= headerHeightIn + 0.08)
            .map((r) => regionSignature(r))
        );
        let p1Matches = 0;
        for (const sig of activeHeaderSigs) {
          if (page1Sigs.has(sig)) p1Matches++;
        }
        const printOnFirstPage = p1Matches / activeHeaderSigs.size >= 0.6;

        const matchedIdsByPage = new Map<number, Set<string>>();
        for (const p of pages) {
          const ids = new Set<string>();
          if (p.pageNumber > 1 || printOnFirstPage) {
            for (const r of p.regions) {
              if (r.y + r.height <= headerHeightIn + 0.04 && activeHeaderSigs.has(regionSignature(r))) {
                ids.add(r.id);
              }
            }
          }
          matchedIdsByPage.set(p.pageNumber, ids);
        }

        pageHeader = {
          heightIn: headerHeightIn,
          printOnFirstPage,
          printOnLastPage: true,
          regions: matchedHeaderRegions,
          matchedIdsByPage,
          textSignatures: matchedHeaderRegions
            .filter((r) => r.type === 'text' && r.text)
            .map((r) => ({ norm: normalizeChromeText(r.text!), x: r.x })),
          imageShas: matchedHeaderRegions
            .filter((r) => (r.type === 'image' || r.type === 'vector_complex') && r.imageAssetBase64)
            .map((r) => ({
              sha: crypto.createHash('sha256').update(r.imageAssetBase64!).digest('hex').slice(0, 12),
              x: r.x,
            })),
        };
      }
    }

    // --- FOOTER DETECTION (bottom 13%) ---
    const footerSigCounts = new Map<string, { pages: Set<number>; sample: LayoutRegion }>();
    for (const p of pages) {
      const seenOnPage = new Set<string>();
      for (const r of p.regions) {
        if (r.y < bottomBandLimitY) continue;
        if (coveredByTablixFn(p.pageNumber, r.x, r.y, r.width, r.height)) continue;
        const sig = regionSignature(r);
        if (seenOnPage.has(sig)) continue;
        seenOnPage.add(sig);

        const entry = footerSigCounts.get(sig) ?? { pages: new Set<number>(), sample: r };
        entry.pages.add(p.pageNumber);
        footerSigCounts.set(sig, entry);
      }
    }

    const consensusFooterSigs = new Set<string>();
    for (const [sig, info] of footerSigCounts.entries()) {
      if (info.pages.size >= minConsensusAll) {
        consensusFooterSigs.add(sig);
      }
    }

    let pageFooter: DetectedChrome['pageFooter'];
    if (consensusFooterSigs.size > 0) {
      const templatePage = pages[0];
      let matchedFooterRegions = templatePage.regions.filter(
        (r) => r.y >= bottomBandLimitY && consensusFooterSigs.has(regionSignature(r))
      );
      if (matchedFooterRegions.length === 0 && pages[1]) {
        matchedFooterRegions = pages[1].regions.filter(
          (r) => r.y >= bottomBandLimitY && consensusFooterSigs.has(regionSignature(r))
        );
      }

      if (matchedFooterRegions.length > 0) {
        const minY = Math.min(...matchedFooterRegions.map((r) => r.y));
        const footerTopIn = roundIn(clamp(minY - 0.015, pageHeightIn * 0.85, pageHeightIn - 0.16));
        const footerHeightIn = roundIn(Math.max(0.16, pageHeightIn - footerTopIn));

        const matchedIdsByPage = new Map<number, Set<string>>();
        for (const p of pages) {
          const ids = new Set<string>();
          for (const r of p.regions) {
            if (r.y >= footerTopIn - 0.04 && consensusFooterSigs.has(regionSignature(r))) {
              ids.add(r.id);
            }
          }
          matchedIdsByPage.set(p.pageNumber, ids);
        }

        pageFooter = {
          topIn: footerTopIn,
          heightIn: footerHeightIn,
          printOnFirstPage: true,
          printOnLastPage: true,
          regions: matchedFooterRegions,
          matchedIdsByPage,
          textSignatures: matchedFooterRegions
            .filter((r) => r.type === 'text' && r.text)
            .map((r) => ({ norm: normalizeChromeText(r.text!), x: r.x })),
          imageShas: matchedFooterRegions
            .filter((r) => (r.type === 'image' || r.type === 'vector_complex') && r.imageAssetBase64)
            .map((r) => ({
              sha: crypto.createHash('sha256').update(r.imageAssetBase64!).digest('hex').slice(0, 12),
              x: r.x,
            })),
        };
      }
    }

    return { pageHeader, pageFooter };
  }

  private buildChromeBandSpec(
    kind: 'PageHeader' | 'PageFooter',
    bandHeightIn: number,
    bandTopIn: number,
    pageWidthIn: number,
    printOnFirstPage: boolean,
    printOnLastPage: boolean,
    regions: LayoutRegion[],
    paramCtx: ParameterDetectionContext,
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string,
    nextUniqueName: (prefix: string) => string
  ): RdlcBandContainerSpec {
    const items: BodyItemBox[] = regions.map((r, idx) => ({
      kind:
        r.type === 'vector_line'
          ? 'line'
          : r.type === 'vector_rect'
            ? 'rect'
            : r.type === 'image' || r.type === 'vector_complex'
              ? 'image'
              : 'text',
      x: clamp(r.x, 0, pageWidthIn - 0.02),
      y: clamp(r.y - bandTopIn, 0, Math.max(0, bandHeightIn - 0.02)),
      width: clamp(r.width, r.type === 'vector_line' ? 0.005 : 0.015, pageWidthIn - clamp(r.x, 0, pageWidthIn - 0.02)),
      height: clamp(
        r.height,
        r.type === 'vector_line' ? 0.005 : 0.015,
        Math.max(r.type === 'vector_line' ? 0.005 : 0.015, bandHeightIn - clamp(r.y - bandTopIn, 0, bandHeightIn))
      ),
      region: r,
      rawIndex: idx,
    }));

    const { rectangles, images, textboxes } = this.emitItemsIntoFlatBoxLayer(
      items,
      pageWidthIn,
      bandHeightIn,
      1,
      paramCtx,
      registerEmbeddedImage,
      nextUniqueName,
      9,
      { allowMultiLineGrouping: false, normalizeFooterExpressions: kind === 'PageFooter' }
    );

    return {
      kind,
      heightIn: bandHeightIn,
      printOnFirstPage,
      printOnLastPage,
      rectangles,
      images,
      textboxes,
      tablixes: [],
    };
  }

  private extractV3Banners(
    items: BodyItemBox[],
    pageWidthIn: number
  ): { banners: V3BannerElement[]; consumedRegionIds: Set<string> } {
    const consumedRegionIds = new Set<string>();
    const bannerRects = items
      .filter((it) => it.kind === 'rect' && it.region && isBannerCandidateRect(it.region, pageWidthIn))
      .sort((a, b) => a.y - b.y || a.x - b.x);

    const banners: V3BannerElement[] = [];
    for (const br of bannerRects) {
      const bgHex = br.region!.style.backgroundColor;
      const bgRgb = parseHexRgb(bgHex);
      if (!bgRgb) continue;
      const bgLum = relativeLuminance(bgRgb);

      const enclosed = items
        .filter((it) => {
          if (it.kind !== 'text' || !it.region?.text) return false;
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
        .map((t) => (t.region!.text ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
      if (!titleText) continue;

      const maxTextContrast = Math.max(
        ...enclosed.map((t) => contrastRatio(t.region!.style.color, bgHex))
      );
      const hasLightTextOnDarkFill =
        bgLum < 0.45 &&
        enclosed.some((t) => {
          const tRgb = parseHexRgb(t.region!.style.color);
          return tRgb ? relativeLuminance(tRgb) > 0.55 && contrastRatio(t.region!.style.color, bgHex) >= 2.6 : false;
        });

      let distinctHorizontalCols = 1;
      for (let k = 1; k < enclosed.length; k++) {
        const gap = enclosed[k].x - (enclosed[k - 1].x + enclosed[k - 1].width);
        if (gap > ptToIn(10)) distinctHorizontalCols++;
      }
      const isSingleHeadingBar = distinctHorizontalCols <= 2 && bgLum < 0.78 && maxTextContrast >= 2.8;
      if (!hasLightTextOnDarkFill && !isSingleHeadingBar) continue;

      if (br.region) consumedRegionIds.add(br.region.id);
      enclosed.forEach((t) => {
        if (t.region) consumedRegionIds.add(t.region.id);
      });

      banners.push({
        rect: br,
        titleText,
        textItems: enclosed,
        x: br.x,
        y: br.y,
        width: br.width,
        height: br.height,
        isFullWidth: br.width >= pageWidthIn * 0.7,
      });
    }

    return { banners, consumedRegionIds };
  }

  private detectWhitespaceGutterInItems(
    items: BodyItemBox[],
    containerW: number
  ): number | undefined {
    if (items.some((it) => it.width >= containerW * 0.68)) return undefined;
    const contentItems = items.filter((it) => it.kind === 'text' || it.kind === 'image');
    if (contentItems.length < 6) return undefined;

    const narrowItems = items.filter(
      (it) =>
        (it.kind === 'text' || it.kind === 'image' || (it.kind === 'rect' && it.height >= 0.15)) &&
        it.width < containerW * 0.62
    );
    if (narrowItems.length < 6) return undefined;

    const enclosedTrackRects = items.filter(
      (it) => it.kind === 'rect' && it.height >= 0.35 && it.width < containerW * 0.62
    );
    if (enclosedTrackRects.length < 2) return undefined;

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

    const minGutterW = ptToIn(8);
    let bestGutter: { center: number; width: number } | undefined;
    for (let i = 0; i < mergedX.length - 1; i++) {
      const gapLeft = mergedX[i].x2;
      const gapRight = mergedX[i + 1].x1;
      const gutterW = gapRight - gapLeft;
      const center = (gapLeft + gapRight) / 2;
      if (
        gutterW < minGutterW ||
        center < containerW * 0.25 ||
        center > containerW * 0.75
      ) {
        continue;
      }
      // Verify no item crosses this gutter
      const crossing = items.some(
        (it) =>
          it.x < center - ptToIn(2) &&
          it.x + it.width > center + ptToIn(2)
      );
      if (crossing) continue;

      const leftBoxes = enclosedTrackRects.filter((rc) => rc.x + rc.width <= center + ptToIn(2));
      const rightBoxes = enclosedTrackRects.filter((rc) => rc.x >= center - ptToIn(2));
      if (leftBoxes.length === 0 || rightBoxes.length === 0) continue;
      const maxLeftX2 = Math.max(...leftBoxes.map((b) => b.x + b.width));
      const minRightX1 = Math.min(...rightBoxes.map((b) => b.x));
      if (minRightX1 - maxLeftX2 < ptToIn(6)) continue;

      const leftCount = contentItems.filter((it) => it.x < center).length;
      const rightCount = contentItems.filter((it) => it.x >= center).length;
      if (leftCount >= 3 && rightCount >= 3) {
        if (!bestGutter || gutterW > bestGutter.width) {
          bestGutter = { center: roundIn(center), width: gutterW };
        }
      }
    }

    return bestGutter?.center;
  }

  private segmentDocumentTracks(
    pages: LayoutPage[],
    bodyItemsByPage: Map<number, BodyItemBox[]>,
    pageWidthIn: number,
    bodyMedianFontPt: number
  ): V3TrackBlock[] {
    const blocks: V3TrackBlock[] = [];
    const trackGapIn = roundIn(ptToIn(6));

    const computeTrackBounds = (rawGutterX: number) => {
      const leftWidth = roundIn(
        clamp(rawGutterX - trackGapIn / 2, 1.0, Math.max(1.0, pageWidthIn - 1.0 - trackGapIn))
      );
      const rightLeft = roundIn(leftWidth + trackGapIn);
      const rightWidth = roundIn(Math.max(1.0, pageWidthIn - rightLeft));
      return { leftWidth, rightLeft, rightWidth };
    };

    let sideBySide = false;
    let gutterXIn = pageWidthIn / 2;
    let activeFull: V3TrackBlock | null = null;
    let activeLeft: V3TrackBlock | null = null;
    let activeRight: V3TrackBlock | null = null;
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

    const makeFullName = (title?: string, fallbackPage = 1): { semanticName: string; slug: string } => {
      const slug = makeSectionSlug(title, `Page${fallbackPage}Section`);
      const seq = String(sectionSeq++).padStart(2, '0');
      return {
        semanticName: sanitizeV3Identifier(`Tablix_${seq}_${slug}`, `Tablix_${seq}`),
        slug,
      };
    };

    const makeTrackName = (side: 'Left' | 'Right', title?: string, fallbackPage = 1): { semanticName: string; slug: string } => {
      const slug = makeSectionSlug(title, `${side}Page${fallbackPage}`);
      const seq = String(sectionSeq++).padStart(2, '0');
      return {
        semanticName: sanitizeV3Identifier(`Tablix_${side}_${seq}_${slug}`, `Tablix_${side}_${seq}`),
        slug,
      };
    };

    const groupItemsIntoYRows = (list: BodyItemBox[]): Array<{ y: number; items: BodyItemBox[]; textItems: BodyItemBox[] }> => {
      const sorted = [...list].sort((a, b) => a.y - b.y || a.x - b.x);
      const rows: Array<{ y: number; items: BodyItemBox[]; textItems: BodyItemBox[] }> = [];
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

    const isBoldGroupHeadingRow = (row: { textItems: BodyItemBox[] }): boolean => {
      if (row.textItems.length !== 1) return false;
      const it = row.textItems[0];
      if (!it.region) return false;
      const txt = (it.region.text ?? '').trim();
      if (txt.length < 3 || txt.length > 60) return false;
      if (!isLikelyHeadingRegion(it.region, bodyMedianFontPt) && !it.region.style.bold) return false;
      if (/^(\d+(?:\.\d+)*\.|\([a-z0-9]+\)|[a-z]\.|[•\u2022\-–])\s+/i.test(txt)) return false;
      if (/[.,;?!]$/.test(txt)) return false;
      return true;
    };

    const countDenseRows = (items: BodyItemBox[]): number =>
      groupItemsIntoYRows(items).filter((r) => r.textItems.length >= 4).length;

    for (let pageLoopIdx = 0; pageLoopIdx < pages.length; pageLoopIdx++) {
      const page = pages[pageLoopIdx];
      const pNum = page.pageNumber;
      if (pageLoopIdx > 0) {
        if (sideBySide) {
          flushLeft();
          flushRight();
        } else {
          flushFull();
        }
      }

      const items = bodyItemsByPage.get(pNum) ?? [];
      const { banners, consumedRegionIds } = this.extractV3Banners(items, pageWidthIn);
      const nonBannerItems = items
        .filter((it) => !it.region || !consumedRegionIds.has(it.region.id))
        .sort((a, b) => a.y - b.y || a.x - b.x);

      const pairedBannerIndices = new Set<number>();
      type BannerEvent =
        | { kind: 'twoTier'; y: number; topBanner: V3BannerElement; left: V3BannerElement; right: V3BannerElement }
        | { kind: 'pair'; y: number; left: V3BannerElement; right: V3BannerElement }
        | { kind: 'full'; y: number; banner: V3BannerElement }
        | { kind: 'singleTrack'; y: number; banner: V3BannerElement };

      const bannerEvents: BannerEvent[] = [];
      for (let i = 0; i < banners.length; i++) {
        if (pairedBannerIndices.has(i)) continue;
        const b = banners[i];
        if (b.isFullWidth) {
          const subCandidates: Array<{ idx: number; b: V3BannerElement }> = [];
          for (let j = i + 1; j < banners.length; j++) {
            const nb = banners[j];
            if (nb.isFullWidth) continue;
            const gapBelow = nb.y - (b.y + b.height);
            if (gapBelow >= -ptToIn(1) && gapBelow <= ptToIn(4)) {
              subCandidates.push({ idx: j, b: nb });
            }
          }
          if (subCandidates.length >= 2) {
            const sortedSubs = subCandidates.slice(0, 2).sort((a, c) => a.b.x - c.b.x);
            if (Math.abs(sortedSubs[0].b.y - sortedSubs[1].b.y) <= ptToIn(6)) {
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
          const partnerIdx = banners.findIndex(
            (other, j) =>
              j > i &&
              !pairedBannerIndices.has(j) &&
              !other.isFullWidth &&
              other.width < pageWidthIn * 0.65 &&
              b.width < pageWidthIn * 0.65 &&
              Math.abs(other.y - b.y) <= ptToIn(6)
          );
          if (partnerIdx >= 0) {
            const partner = banners[partnerIdx];
            pairedBannerIndices.add(i);
            pairedBannerIndices.add(partnerIdx);
            const [left, right] = b.x <= partner.x ? [b, partner] : [partner, b];
            bannerEvents.push({ kind: 'pair', y: Math.min(left.y, right.y), left, right });
          } else {
            pairedBannerIndices.add(i);
            bannerEvents.push({ kind: 'singleTrack', y: b.y, banner: b });
          }
        }
      }

      bannerEvents.sort((a, b) => a.y - b.y);

      const classifyBandTopology = (bandItems: BodyItemBox[]): 'multiGrid' | 'narrative' => {
        const bandRows = groupItemsIntoYRows(bandItems);
        const multiColRows = bandRows.filter((r) => r.textItems.length >= 3).length;
        return multiColRows >= 2 ? 'multiGrid' : 'narrative';
      };

      const processBandRows = (bandItems: BodyItemBox[], isDividerBoundedBand: boolean) => {
        const rows = groupItemsIntoYRows(bandItems);
        for (let rIdx = 0; rIdx < rows.length; rIdx++) {
          const row = rows[rIdx];
          const remainingRows = rows.slice(rIdx);

          // If in sideBySide mode, check if this row introduces a genuine full-width crossing section/footnote
          if (sideBySide) {
            const hasFullWidthCrossing = row.items.some(
              (it) =>
                (it.kind === 'text' || it.kind === 'tablix') &&
                it.x < gutterXIn - ptToIn(10) &&
                it.x + it.width > gutterXIn + ptToIn(10) &&
                it.width >= pageWidthIn * 0.68
            );
            if (hasFullWidthCrossing) {
              flushAllSideBySide();
            }
          }

          // Isolate repeating Tablix controls cleanly
          const repeatingTblItem = row.items.find((it) => it.kind === 'tablix' && it.tablix?.isRepeatingDetail);
          if (repeatingTblItem && row.items.length === 1) {
            if (sideBySide) flushAllSideBySide();
            flushFull();
            const meta = makeFullName(repeatingTblItem.tablix?.name, pNum);
            blocks.push({
              semanticName: meta.semanticName,
              slug: meta.slug,
              track: 'full',
              leftIn: 0,
              widthIn: pageWidthIn,
              pageNumber: pNum,
              pageBreakBefore: false,
              items: [{ ...repeatingTblItem, y: repeatingTblItem.y + (pNum - 1) * 100 }],
            });
            continue;
          }

          // Post-Table Footnote Split
          if (!sideBySide && activeFull && !activeFull.isFootnote && countDenseRows(activeFull.items) >= 3) {
            const allRemainingAreWideNotes =
              remainingRows.length >= 1 &&
              remainingRows.every((rr) => {
                if (rr.textItems.length === 0) return true;
                if (rr.textItems.length > 2) return false;
                const minX = Math.min(...rr.textItems.map((t) => t.x));
                const maxX = Math.max(...rr.textItems.map((t) => t.x + t.width));
                const firstTxt = (rr.textItems[0].region?.text ?? '').trim();
                const isNoteHeading =
                  rr.textItems.length === 1 &&
                  firstTxt.length <= 45 &&
                  (Boolean(rr.textItems[0].region?.style.bold) || firstTxt.endsWith(':'));
                return isNoteHeading || maxX - minX >= pageWidthIn * 0.72;
              }) &&
              remainingRows.some((rr) => {
                if (rr.textItems.length === 0 || rr.textItems.length > 2) return false;
                const minX = Math.min(...rr.textItems.map((t) => t.x));
                const maxX = Math.max(...rr.textItems.map((t) => t.x + t.width));
                return maxX - minX >= pageWidthIn * 0.72;
              });

            if (allRemainingAreWideNotes) {
              flushFull();
              const firstTitle = (row.textItems[0]?.region?.text ?? 'Notes').trim();
              const meta = makeFullName(firstTitle, pNum);
              activeFull = {
                semanticName: meta.semanticName,
                slug: meta.slug,
                track: 'full',
                leftIn: 0,
                widthIn: pageWidthIn,
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

          if (sideBySide) {
            // Split strictly by left-edge x < gutterXIn vs x >= gutterXIn
            const leftRowItems = row.items.filter((it) => it.x < gutterXIn);
            const rightRowItems = row.items.filter((it) => it.x >= gutterXIn);
            const bounds = computeTrackBounds(gutterXIn);

            const handleTrackRow = (trackSide: 'left' | 'right', trackItems: BodyItemBox[]) => {
              if (trackItems.length === 0) return;
              const trackText = trackItems.filter((i) => i.kind === 'text');
              const activeTrack = trackSide === 'left' ? activeLeft : activeRight;
              const isSubGroupHeader = isBoldGroupHeadingRow({ textItems: trackText });
              const trackHasContainerLock =
                Boolean(activeTrack?.banner) ||
                (activeTrack?.items.some(
                  (it) => it.kind === 'rect' && it.width >= (activeTrack?.widthIn ?? pageWidthIn) * 0.78 && it.height >= ptToIn(80)
                ) ?? false);

              if (!trackHasContainerLock && isSubGroupHeader && activeTrack && countDenseRows(activeTrack.items) < 3) {
                const priorRows = groupItemsIntoYRows(activeTrack.items);
                const futureTrackRows = rows
                  .slice(rIdx + 1)
                  .map((fr) =>
                    fr.items.filter((it) => (trackSide === 'left' ? it.x < gutterXIn : it.x >= gutterXIn))
                  )
                  .filter((arr) => arr.length > 0);
                if (priorRows.length >= 2 && futureTrackRows.length >= 2) {
                  const hdrText = (trackText[0].region?.text ?? '').trim();
                  if (trackSide === 'left') {
                    flushLeft();
                    const meta = makeTrackName('Left', hdrText, pNum);
                    activeLeft = {
                      semanticName: meta.semanticName,
                      slug: meta.slug,
                      track: 'left',
                      leftIn: 0,
                      widthIn: bounds.leftWidth,
                      pageNumber: pNum,
                      pageBreakBefore: false,
                      items: trackItems.map((it) => ({ ...it, y: it.y + (pNum - 1) * 100 })),
                    };
                  } else {
                    flushRight();
                    const meta = makeTrackName('Right', hdrText, pNum);
                    activeRight = {
                      semanticName: meta.semanticName,
                      slug: meta.slug,
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
                  const meta = makeTrackName('Left', undefined, pNum);
                  activeLeft = {
                    semanticName: meta.semanticName,
                    slug: meta.slug,
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
                  const meta = makeTrackName('Right', undefined, pNum);
                  activeRight = {
                    semanticName: meta.semanticName,
                    slug: meta.slug,
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
                (it) => it.kind === 'rect' && it.width >= pageWidthIn * 0.78 && it.height >= ptToIn(80)
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
                const hdrText = (row.textItems[0].region?.text ?? '').trim();
                flushFull();
                const meta = makeFullName(hdrText, pNum);
                activeFull = {
                  semanticName: meta.semanticName,
                  slug: meta.slug,
                  track: 'full',
                  leftIn: 0,
                  widthIn: pageWidthIn,
                  pageNumber: pNum,
                  pageBreakBefore: false,
                  items: row.items.map((it) => ({ ...it, y: it.y + (pNum - 1) * 100 })),
                };
                continue;
              }
            }

            if (!activeFull) {
              const meta = makeFullName(row.textItems[0]?.region?.text, pNum);
              activeFull = {
                semanticName: meta.semanticName,
                slug: meta.slug,
                track: 'full',
                leftIn: 0,
                widthIn: pageWidthIn,
                pageNumber: pNum,
                pageBreakBefore: false,
                items: [],
              };
            }
            activeFull.items.push(...row.items.map((it) => ({ ...it, y: it.y + (pNum - 1) * 100 })));
          }
        }
      };

      const processNonBannerSegment = (segmentItems: BodyItemBox[]) => {
        if (segmentItems.length === 0) return;

        // If not yet sideBySide and not under a full-width banner, detect if twin boxed columns split this segment
        if (!sideBySide && !(activeFull && activeFull.track === 'full' && activeFull.banner?.isFullWidth)) {
          const detectedGutter = this.detectWhitespaceGutterInItems(segmentItems, pageWidthIn);
          if (detectedGutter !== undefined) {
            flushFull();
            sideBySide = true;
            gutterXIn = detectedGutter;
            const bounds = computeTrackBounds(gutterXIn);
            const leftMeta = makeTrackName('Left', undefined, pNum);
            const rightMeta = makeTrackName('Right', undefined, pNum);
            activeLeft = {
              semanticName: leftMeta.semanticName,
              slug: leftMeta.slug,
              track: 'left',
              leftIn: 0,
              widthIn: bounds.leftWidth,
              pageNumber: pNum,
              pageBreakBefore: false,
              pairedStart: true,
              items: [],
            };
            activeRight = {
              semanticName: rightMeta.semanticName,
              slug: rightMeta.slug,
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
          const dividerLines = segmentItems.filter(
            (it) =>
              (it.kind === 'line' || it.kind === 'rect') &&
              it.height <= ptToIn(3.5) &&
              it.width >= pageWidthIn * 0.85
          );
          if (dividerLines.length > 0) {
            const dividerYs = clusterValues(
              dividerLines.map((d) => d.y),
              ptToIn(4)
            );
            const subBands: BodyItemBox[][] = [];
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
                if (sbIdx > 0 && prevTopo && (curTopo !== prevTopo || prevTopo === 'multiGrid')) {
                  flushFull();
                }
                processBandRows(subBand, true);
                prevTopo = curTopo;
              }
              return;
            }
          }
        }

        processBandRows(segmentItems, false);
      };

      let cursorIdx = 0;
      for (const ev of bannerEvents) {
        const beforeItems: BodyItemBox[] = [];
        while (cursorIdx < nonBannerItems.length && nonBannerItems[cursorIdx].y < ev.y) {
          beforeItems.push(nonBannerItems[cursorIdx++]);
        }
        processNonBannerSegment(beforeItems);

        if (ev.kind === 'full') {
          flushAllSideBySide();
          flushFull();
          const meta = makeFullName(ev.banner.titleText, pNum);
          activeFull = {
            semanticName: meta.semanticName,
            slug: meta.slug,
            track: 'full',
            leftIn: 0,
            widthIn: pageWidthIn,
            pageNumber: pNum,
            pageBreakBefore: false,
            banner: ev.banner,
            items: [],
          };
        } else if (ev.kind === 'twoTier') {
          flushAllSideBySide();
          flushFull();
          const topMeta = makeFullName(ev.topBanner.titleText, pNum);
          blocks.push({
            semanticName: topMeta.semanticName,
            slug: topMeta.slug,
            track: 'full',
            leftIn: 0,
            widthIn: pageWidthIn,
            pageNumber: pNum,
            pageBreakBefore: false,
            isBannerOnly: true,
            banner: ev.topBanner,
            items: [],
          });
          sideBySide = true;
          gutterXIn = roundIn((ev.left.x + ev.left.width + ev.right.x) / 2);
          const bounds = computeTrackBounds(gutterXIn);
          const leftMeta = makeTrackName('Left', ev.left.titleText, pNum);
          const rightMeta = makeTrackName('Right', ev.right.titleText, pNum);
          activeLeft = {
            semanticName: leftMeta.semanticName,
            slug: leftMeta.slug,
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
            semanticName: rightMeta.semanticName,
            slug: rightMeta.slug,
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
          const leftMeta = makeTrackName('Left', ev.left.titleText, pNum);
          const rightMeta = makeTrackName('Right', ev.right.titleText, pNum);
          activeLeft = {
            semanticName: leftMeta.semanticName,
            slug: leftMeta.slug,
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
            semanticName: rightMeta.semanticName,
            slug: rightMeta.slug,
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
            gutterXIn = pageWidthIn / 2;
          }
          const bounds = computeTrackBounds(gutterXIn);
          if (cx < gutterXIn) {
            flushLeft();
            const meta = makeTrackName('Left', b.titleText, pNum);
            activeLeft = {
              semanticName: meta.semanticName,
              slug: meta.slug,
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
            const meta = makeTrackName('Right', b.titleText, pNum);
            activeRight = {
              semanticName: meta.semanticName,
              slug: meta.slug,
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

      if (cursorIdx < nonBannerItems.length) {
        processNonBannerSegment(nonBannerItems.slice(cursorIdx));
      }

      if (activeFull?.isFootnote) {
        flushFull();
      }
    }

    flushAllSideBySide();
    flushFull();

    // Enforce Single <PageBreak> Rule per page > 1:
    // Never emit <PageBreak> on right-track Tablix; anchor PageBreak on first full or left Tablix of page > 1.
    const seenPages = new Set<number>();
    const normalizedBlocks: V3TrackBlock[] = [];
    for (const blk of blocks) {
      if (blk.track === 'right') blk.pageBreakBefore = false;
    }
    const pageGroups = new Map<number, V3TrackBlock[]>();
    for (const blk of blocks) {
      const list = pageGroups.get(blk.pageNumber) ?? [];
      list.push(blk);
      pageGroups.set(blk.pageNumber, list);
    }
    for (const pNum of Array.from(pageGroups.keys()).sort((a, b) => a - b)) {
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

  private compileTrackBlockToTablix(
    tablixName: string,
    block: V3TrackBlock,
    topIn: number,
    dataSetName: string,
    paramCtx: ParameterDetectionContext,
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string,
    nextUniqueName: (prefix: string) => string,
    bodyMedianFontPt: number
  ): {
    tablix: TablixRegion;
    layoutType: LayoutSectionSummary['layoutType'];
    columnCount: number;
    childItemCount: number;
  } {
    const blockLeft = block.leftIn;
    const blockW = roundIn(Math.max(0.5, block.widthIn));

    // Normalize coordinates relative to blockLeft
    const relItems: BodyItemBox[] = block.items.map((it) => {
      const rx = Math.max(0, it.x - blockLeft);
      const rw = Math.min(Math.max(0.005, blockW - rx), it.width);
      return {
        ...it,
        x: rx,
        width: rw,
        tablix: it.tablix
          ? { ...it.tablix, leftIn: roundIn(rx), topIn: roundIn(it.y) }
          : undefined,
      };
    });

    // Preserve repeating detail Tablix directly
    const repeatingTbl = relItems.find((i) => i.kind === 'tablix' && i.tablix?.isRepeatingDetail)?.tablix;
    if (repeatingTbl && relItems.filter((i) => i.kind === 'text' || i.kind === 'image').length <= 1) {
      const cloned: TablixRegion = {
        ...repeatingTbl,
        id: tablixName,
        name: tablixName,
        pageBreakBefore: block.pageBreakBefore,
        topIn: roundIn(topIn),
        leftIn: roundIn(blockLeft),
        rows: repeatingTbl.rows.map((r, rIdx) => ({
          ...r,
          pageBreakBefore: rIdx === 0 && block.pageBreakBefore ? true : undefined,
        })),
      };
      return {
        tablix: cloned,
        layoutType: 'Tablix',
        columnCount: cloned.columnWidthsIn.length,
        childItemCount: cloned.rows.length,
      };
    }

    // Banner-only 1-row block
    if (block.isBannerOnly && block.banner && relItems.length === 0) {
      const bannerCell = this.buildV3BannerCell(block.banner, 0, 0, 1, nextUniqueName);
      const bannerStyle = bannerCell.content.kind === 'Textbox' ? bannerCell.content.style : defaultTextStyle(9.5);
      const bannerH = roundIn(
        Math.max(
          ptToIn(18),
          block.banner.height,
          ptToIn(
            estimateWrappedRowHeightPt(
              [{ text: block.banner.titleText, style: bannerStyle, coveredWidthPt: inToPt(blockW) }],
              14
            )
          )
        )
      );
      const tablix: TablixRegion = {
        id: tablixName,
        name: tablixName,
        pageNumber: block.pageNumber,
        bandKind: 'Detail',
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
            pageBreakBefore: block.pageBreakBefore ? true : undefined,
            cells: [bannerCell],
          },
        ],
        zIndex: 1,
      };
      return {
        tablix,
        layoutType: 'Single-Column',
        columnCount: 1,
        childItemCount: 1,
      };
    }

    // Hybrid graphic/image callout canvas (Archetype D) when images exist alongside positioned graphics
    const hasImages = relItems.some((it) => it.kind === 'image');
    if (hasImages) {
      const minY = relItems.length > 0 ? Math.min(...relItems.map((i) => i.y)) : 0;
      const normalized = relItems.map((it) => ({ ...it, y: Math.max(0, it.y - minY) }));
      const maxY = normalized.length > 0 ? Math.max(...normalized.map((i) => i.y + i.height)) : 0.3;
      const canvasH = roundIn(Math.max(0.3, maxY + ptToIn(4)));
      const flat = this.emitItemsIntoFlatBoxLayer(
        normalized,
        blockW,
        canvasH,
        block.pageNumber,
        paramCtx,
        registerEmbeddedImage,
        nextUniqueName,
        bodyMedianFontPt,
        { allowMultiLineGrouping: true }
      );
      const rows: TablixRow[] = [];
      if (block.banner) {
        const bannerCell = this.buildV3BannerCell(block.banner, 0, 0, 1, nextUniqueName);
        const bannerStyle = bannerCell.content.kind === 'Textbox' ? bannerCell.content.style : defaultTextStyle(9.5);
        const bannerH = roundIn(
          Math.max(
            ptToIn(18),
            block.banner.height,
            ptToIn(
              estimateWrappedRowHeightPt(
                [{ text: block.banner.titleText, style: bannerStyle, coveredWidthPt: inToPt(blockW) }],
                14
              )
            )
          )
        );
        rows.push({
          heightIn: bannerH,
          isDetailRow: false,
          pageBreakBefore: block.pageBreakBefore ? true : undefined,
          cells: [bannerCell],
        });
      }
      rows.push({
        heightIn: canvasH,
        isDetailRow: false,
        pageBreakBefore: rows.length === 0 && block.pageBreakBefore ? true : undefined,
        cells: [
          {
            colIndex: 0,
            rowIndex: rows.length,
            colSpan: 1,
            rowSpan: 1,
            skipBecauseMerged: false,
            content: {
              kind: 'Rectangle',
              name: `${tablixName}_Canvas`,
              rectangles: flat.rectangles,
              images: flat.images,
              textboxes: flat.textboxes,
              tablixes: flat.tablixes,
            },
          },
        ],
      });
      const totalH = roundIn(rows.reduce((s, r) => s + r.heightIn, 0));
      const tablix: TablixRegion = {
        id: tablixName,
        name: tablixName,
        pageNumber: block.pageNumber,
        bandKind: 'Detail',
        pageBreakBefore: block.pageBreakBefore,
        keepTogether: false,
        topIn: roundIn(topIn),
        leftIn: roundIn(blockLeft),
        widthIn: blockW,
        heightIn: totalH,
        dataSetName,
        isRepeatingDetail: false,
        columnWidthsIn: [blockW],
        rows,
        zIndex: 1,
      };
      return {
        tablix,
        layoutType: 'Hybrid-Callout',
        columnCount: 1,
        childItemCount: flat.rectangles.length + flat.images.length + flat.textboxes.length,
      };
    }

    // Paragraph-First Atomic Left-Edge Grid Compiler (FIX 2):
    // 1. Expand multi-line explicit '\n' items
    // 2. Cluster same-baseline items
    // 3. Split leading list markers (`1.`, `a.`, `(1)`, `-`)
    // 4. Reconstruct full paragraphs BEFORE intersecting with sub-table columns
    // 5. Build self-contained atomic column grid from recurring left edges, markers & table rects
    // 6. Map strictly by left edge (x0) + ColSpan, CanGrow = true, exact wrapped row heights
    const rectItems = relItems.filter(
      (it) =>
        it.kind === 'rect' &&
        it.region &&
        it.width >= ptToIn(8) &&
        it.height >= ptToIn(8) &&
        Boolean(it.region.style.backgroundColor || it.region.style.borderColor)
    );
    const contentItems = relItems.filter((it) => it.kind === 'text');
    const lineItems = relItems.filter((it) => it.kind === 'line');
    const contentSpanY =
      contentItems.length > 0
        ? Math.max(...contentItems.map((i) => i.y + i.height)) - Math.min(...contentItems.map((i) => i.y))
        : 0;

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

    const modeAResult = this.tryBuildV3ModeAGrid(contentItems, tableRects, lineItems, blockW, contentSpanY);
    let logicalRows: V3LogicalRowBucket[];
    let atomicBoundaries: number[];
    let isDataTable: boolean;

    if (modeAResult) {
      logicalRows = modeAResult.logicalRows;
      atomicBoundaries = modeAResult.atomicBoundaries;
      isDataTable = true;
    } else {
      const expandedContent = this.expandV3MultilineItems(contentItems);
      const rawRows = this.clusterV3ItemsIntoRows(expandedContent, tableRects);
      const markedRows = this.splitV3ClauseTitleRows(rawRows);
      const paraRows = this.reconstructV3ParagraphBlocks(markedRows, tableRects, lineItems, blockW);
      logicalRows = this.compactV3EmbeddedSubTableZones(paraRows, tableRects, lineItems, blockW, contentSpanY);
      atomicBoundaries = this.buildV3AtomicColumnGrid(logicalRows, tableRects, lineItems, blockW);
      isDataTable = this.detectV3StructuredDataTable(logicalRows, tableRects, Math.max(1, atomicBoundaries.length - 1));
    }

    const numCols = Math.max(1, atomicBoundaries.length - 1);
    const columnWidthsIn: number[] = [];
    for (let c = 0; c < numCols; c++) {
      columnWidthsIn.push(roundIn(Math.max(ptToIn(8), atomicBoundaries[c + 1] - atomicBoundaries[c])));
    }
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

    if (block.banner) {
      const bannerCell = this.buildV3BannerCell(block.banner, 0, 0, numCols, nextUniqueName);
      const bannerStyle = bannerCell.content.kind === 'Textbox' ? bannerCell.content.style : defaultTextStyle(9.5);
      const bannerH = roundIn(
        Math.max(
          ptToIn(18),
          block.banner.height,
          ptToIn(
            estimateWrappedRowHeightPt(
              [{ text: block.banner.titleText, style: bannerStyle, coveredWidthPt: inToPt(blockW) }],
              14
            )
          )
        )
      );
      const bannerCells: TablixCell[] = [];
      for (let c = 0; c < numCols; c++) {
        if (c === 0) {
          bannerCells.push(bannerCell);
        } else {
          bannerCells.push({
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
        pageBreakBefore: block.pageBreakBefore ? true : undefined,
        cells: bannerCells,
      });
    }

    const orderedLogicalRows = [...logicalRows].sort((a, b) => a.yTop - b.yTop);
    const emittedLogicalRows: V3LogicalRowBucket[] = [];

    for (let rIdx = 0; rIdx < orderedLogicalRows.length; rIdx++) {
      const lr = orderedLogicalRows[rIdx];
      const pendingSlices: BodyItemBox[][] = [[...lr.items].sort((a, b) => a.x - b.x)];

      while (pendingSlices.length > 0) {
        const sliceItems = pendingSlices.shift()!;
        if (sliceItems.length === 0) continue;

        const outRowIndex = tablixRows.length;
        const rowSlots: Array<{
          startCol: number;
          endCol: number;
          items: BodyItemBox[];
          rect?: BodyItemBox;
        }> = [];
        const overflowItems: BodyItemBox[] = [];

        for (const it of sliceItems) {
          const { startCol, endCol } = this.mapV3ItemToAtomicSpan(
            it,
            atomicBoundaries,
            numCols,
            sliceItems,
            isDataTable || Boolean(lr.isSubTableRow),
            lr.rects
          );
          const itemMidX = it.x + it.width / 2;
          const matchingRect =
            lr.rects.find((rc) => itemMidX >= rc.x - ptToIn(4) && itemMidX <= rc.x + rc.width + ptToIn(4)) ??
            lr.rects.find((rc) => it.x >= rc.x - ptToIn(5) && it.x < rc.x + rc.width - ptToIn(2));
          const exactCollision = rowSlots.find((s) => s.startCol === startCol);
          if (exactCollision) {
            overflowItems.push(it);
            continue;
          }
          rowSlots.push({
            startCol,
            endCol,
            items: [it],
            rect: matchingRect,
          });
        }

        rowSlots.sort((a, b) => a.startCol - b.startCol);

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

        const rowHasRects = lr.rects.length > 0;
        const rowAppliesTableGrid = (isDataTable && rowHasRects) || Boolean(lr.isSubTableRow);
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
            const emptyStyle = this.buildV3CellStyle(undefined, undefined, rowAppliesTableGrid, false);
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
            rowHeightInputs.push({ text: '', style: emptyStyle, coveredWidthPt: inToPt(colW) });
            col++;
          }

          const colSpan = sl.endCol - sl.startCol + 1;
          let coveredWidthIn = 0;
          for (let cc = sl.startCol; cc <= sl.endCol; cc++) coveredWidthIn += columnWidthsIn[cc];

          const textParts = sl.items
            .filter((i) => i.kind === 'text' && i.region)
            .sort((a, b) => a.y - b.y || a.x - b.x);
          const mergedText = textParts.reduce((acc, tp, idx) => {
            const part = (tp.region!.text ?? '').trim();
            if (!part) return acc;
            if (!acc) return part;
            const prev = textParts[idx - 1];
            const sameLine = prev && Math.abs(tp.y - prev.y) <= ptToIn(3.5);
            return `${acc}${sameLine ? ' ' : '\n'}${part}`;
          }, '');

          const primary = textParts[0]?.region;
          const applyGridBorder = Boolean(sl.rect?.region?.style.borderColor) || rowAppliesTableGrid;
          const baseStyle = this.buildV3CellStyle(
            primary?.style,
            sl.rect?.region?.style,
            applyGridBorder,
            Boolean(lr.isHeaderRow)
          );

          if (sl.rect && textParts.length > 0 && sl.rect.width < blockW * 0.90) {
            const rectMidX = sl.rect.x + sl.rect.width / 2;
            const minTX = Math.min(...textParts.map((t) => t.x));
            const maxTX = Math.max(...textParts.map((t) => t.x + t.width));
            const textMidX = (minTX + maxTX) / 2;
            if (Math.abs(textMidX - rectMidX) <= ptToIn(8) && maxTX - minTX < sl.rect.width * 0.82) {
              baseStyle.textAlign = 'Center';
            }
          }

          if (
            (isDataTable || Boolean(lr.isSubTableRow)) &&
            !lr.isHeaderRow &&
            baseStyle.textAlign !== 'Center' &&
            sl.startCol > 0 &&
            /^(\(?\s*-?[0-9][0-9.,]*\s*\)?|Rp\s*[0-9.,-]+|-)$/i.test(mergedText)
          ) {
            baseStyle.textAlign = 'Right';
          }

          const rawRuns: VisualTextRun[] = [];
          textParts.forEach((tp, idx) => {
            if (idx > 0 && rawRuns.length > 0) {
              const prev = textParts[idx - 1];
              const sameLine = prev && Math.abs(tp.y - prev.y) <= ptToIn(3.5);
              rawRuns.push({ ...rawRuns[rawRuns.length - 1], text: sameLine ? ' ' : '\n' });
            }
            if (tp.region!.runs && tp.region!.runs.length > 0) {
              for (const r of tp.region!.runs) rawRuns.push({ ...r });
            } else if (tp.region!.text) {
              rawRuns.push({
                text: tp.region!.text,
                fontFamily: baseStyle.fontFamily,
                fontSizePt: baseStyle.fontSizePt,
                bold: baseStyle.bold,
                italic: baseStyle.italic,
                underline: baseStyle.underline,
                color: baseStyle.color,
              });
            }
          });

          const runs = parameterizeTextRuns(paramCtx, rawRuns, block.pageNumber);
          const isExpr = runs.some((r) => Boolean(r.parameterName));

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
              isExpression: isExpr,
              style: baseStyle,
              canGrow: true,
            },
          });

          rowHeightInputs.push({
            text: mergedText,
            runs,
            style: baseStyle,
            coveredWidthPt: inToPt(coveredWidthIn),
          });

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
          const emptyStyle = this.buildV3CellStyle(undefined, undefined, rowAppliesTableGrid, false);
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
          rowHeightInputs.push({ text: '', style: emptyStyle, coveredWidthPt: inToPt(colW) });
          col++;
        }

        const rowHeightPt = estimateWrappedRowHeightPt(rowHeightInputs, 13.5);
        tablixRows.push({
          heightIn: roundIn(ptToIn(rowHeightPt)),
          isDetailRow: false,
          pageBreakBefore: outRowIndex === 0 && block.pageBreakBefore ? true : undefined,
          cells,
        });
        emittedLogicalRows.push({
          ...lr,
          items: cleanSlots.flatMap((s) => s.items),
        });
      }
    }

    this.applyV3VerticalMergeBorderSuppression(
      tablixRows,
      tableRects,
      lineItems,
      emittedLogicalRows,
      atomicBoundaries,
      isDataTable
    );

    if (!isDataTable && outerFrameRects.length > 0 && tablixRows.length > 0) {
      const frameColor = outerFrameRects[0].region?.style.borderColor;
      const frameWidthPt = outerFrameRects[0].region?.style.borderWidthPt ?? 0.5;
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

    const hasClauses = logicalRows.some((r) =>
      r.items.length >= 2 && STANDALONE_MARKER_RE.test((r.items[0].region?.text ?? '').trim())
    );
    const layoutType: LayoutSectionSummary['layoutType'] = isDataTable
      ? 'Tablix'
      : hasClauses
        ? 'Clause-List'
        : block.track === 'full'
          ? 'Single-Column'
          : 'Dual-Column';

    const tablix: TablixRegion = {
      id: tablixName,
      name: tablixName,
      pageNumber: block.pageNumber,
      bandKind: block.isFootnote ? 'Notes' : 'Detail',
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

    return {
      tablix,
      layoutType,
      columnCount: columnWidthsIn.length,
      childItemCount: tablixRows.length,
    };
  }

  private buildV3BannerCell(
    banner: V3BannerElement,
    colIndex: number,
    rowIndex: number,
    colSpan: number,
    nextUniqueName: (prefix: string) => string
  ): TablixCell {
    const bg = banner.rect.region?.style.backgroundColor ?? '#334155';
    const bgRgb = parseHexRgb(bg);
    const fallbackTextCol = bgRgb && relativeLuminance(bgRgb) < 0.45 ? '#FFFFFF' : '#0F172A';
    const extractedCol = banner.textItems[0]?.region?.style.color;
    const textColor =
      extractedCol && contrastRatio(extractedCol, bg) >= 2.6 ? extractedCol : fallbackTextCol;
    const primaryStyle = banner.textItems[0]?.region?.style;
    const fontSizePt = primaryStyle?.fontSizePt ?? 9.5;
    const fontFamily = primaryStyle?.fontFamily ?? 'Arial';
    const bannerCenterX = banner.x + banner.width / 2;
    const minTextX = banner.textItems.length > 0 ? Math.min(...banner.textItems.map((t) => t.x)) : banner.x;
    const maxTextX = banner.textItems.length > 0 ? Math.max(...banner.textItems.map((t) => t.x + t.width)) : banner.x;
    const textCenterX = (minTextX + maxTextX) / 2;
    const isCentered = banner.textItems.length > 0 && Math.abs(textCenterX - bannerCenterX) <= ptToIn(10);
    const style: RegionStyle = {
      fontFamily,
      fontSizePt,
      bold: primaryStyle?.bold ?? true,
      italic: primaryStyle?.italic ?? false,
      color: textColor,
      backgroundColor: bg,
      textAlign: isCentered ? 'Center' : (primaryStyle?.textAlign ?? 'Left'),
      verticalAlign: 'Middle',
      paddingPt: { top: 3, right: 5, bottom: 3, left: 5 },
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

  private expandV3MultilineItems(items: BodyItemBox[]): BodyItemBox[] {
    const out: BodyItemBox[] = [];
    for (const it of items) {
      if (it.kind !== 'text' || !it.region || !(it.region.text ?? '').includes('\n')) {
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
        out.push({
          ...it,
          y: it.y + idx * lineStep,
          height: lineStep,
          region: {
            ...it.region!,
            id: `${it.region!.id}-ln${idx}`,
            y: it.region!.y + idx * lineStep,
            height: lineStep,
            text: ln,
            runs: [
              {
                text: ln,
                fontFamily: it.region!.style.fontFamily,
                fontSizePt: it.region!.style.fontSizePt,
                bold: idx === 0 ? it.region!.style.bold : false,
                italic: it.region!.style.italic,
                color: it.region!.style.color,
              },
            ],
          },
        });
      });
    }
    return out;
  }

  private clusterV3ItemsIntoRows(
    contentItems: BodyItemBox[],
    rectItems: BodyItemBox[]
  ): V3LogicalRowBucket[] {
    const sorted = [...contentItems].sort((a, b) => a.y - b.y || a.x - b.x);
    const buckets: V3LogicalRowBucket[] = [];

    for (const it of sorted) {
      const last = buckets[buckets.length - 1];
      if (last) {
        const minFs = Math.min(
          it.region?.style.fontSizePt || 8.5,
          ...last.items.map((pi) => pi.region?.style.fontSizePt || 8.5)
        );
        const sameBaselineTolIn = Math.min(ptToIn(3.5), ptToIn(minFs * 0.45));
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

    for (const b of buckets) {
      b.items.sort((a, c) => a.x - c.x);
      const midY = (b.yTop + b.yBottom) / 2;
      b.rects = rectItems.filter(
        (rc) => midY >= rc.y - ptToIn(2) && midY <= rc.y + rc.height + ptToIn(2)
      );
      b.isHeaderRow =
        b.items.length >= 2 &&
        b.items.every((it) => Boolean(it.region?.style.bold) || Boolean(b.rects.find((rc) => rc.region?.style.backgroundColor)));
    }

    buckets.sort((a, b) => a.yTop - b.yTop);
    return buckets;
  }

  private splitV3ClauseTitleRows(rows: V3LogicalRowBucket[]): V3LogicalRowBucket[] {
    const out: V3LogicalRowBucket[] = [];
    for (const row of rows) {
      if (row.items.length === 1 && row.items[0].kind === 'text' && row.items[0].region) {
        const it = row.items[0];
        const reg = it.region!;
        const txt = (reg.text ?? '').trim();
        const m = txt.match(CLAUSE_PREFIX_RE);
        if (m) {
          const marker = m[1];
          const rest = m[2];
          const fs = reg.style.fontSizePt || 8.5;
          const markerWidth = clamp(
            ptToIn((marker.length + 0.8) * fs * 0.56),
            ptToIn(8),
            Math.max(ptToIn(8), it.width * 0.4)
          );
          const markerRegion: LayoutRegion = {
            ...reg,
            id: `${reg.id}-mark`,
            text: marker,
            width: markerWidth,
            runs: [
              {
                text: marker,
                fontFamily: reg.style.fontFamily,
                fontSizePt: reg.style.fontSizePt,
                bold: reg.style.bold,
                italic: reg.style.italic,
                color: reg.style.color,
              },
            ],
          };
          const contentRegion: LayoutRegion = {
            ...reg,
            id: `${reg.id}-body`,
            x: reg.x + markerWidth,
            width: Math.max(ptToIn(20), reg.width - markerWidth),
            text: rest,
            runs: [
              {
                text: rest,
                fontFamily: reg.style.fontFamily,
                fontSizePt: reg.style.fontSizePt,
                bold: reg.style.bold,
                italic: reg.style.italic,
                color: reg.style.color,
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
            isClauseTitleRow: reg.style.bold && rest.length <= 90,
          });
          continue;
        }
      }
      out.push(row);
    }
    return out;
  }

  private reconstructV3ParagraphBlocks(
    rows: V3LogicalRowBucket[],
    rectItems: BodyItemBox[],
    lineItems: BodyItemBox[],
    blockW: number
  ): V3LogicalRowBucket[] {
    if (rows.length <= 1) return rows;

    const horizLines = lineItems.filter(
      (ln) => ln.height <= ptToIn(3) && ln.width >= ptToIn(8)
    );

    const findEnclosingRect = (it: BodyItemBox): BodyItemBox | undefined => {
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
      const hasLine = horizLines.some(
        (ln) =>
          ln.y >= y1 - ptToIn(2) &&
          ln.y <= y2 + ptToIn(2) &&
          ln.x <= x2 - ptToIn(4) &&
          ln.x + ln.width >= x1 + ptToIn(4)
      );
      if (hasLine) return true;

      return rectItems.some((rc) => {
        if (sharedRectId && rc.region?.id === sharedRectId) return false;
        const overlapsX = rc.x <= x2 - ptToIn(4) && rc.x + rc.width >= x1 + ptToIn(4);
        if (!overlapsX) return false;
        const topCross = rc.y >= y1 - ptToIn(1.5) && rc.y <= y2 + ptToIn(1.5);
        const botCross =
          rc.y + rc.height >= y1 - ptToIn(1.5) && rc.y + rc.height <= y2 + ptToIn(1.5);
        return topCross || botCross;
      });
    };

    const isAllBold = (it: BodyItemBox): boolean => {
      const nonEmptyRuns = it.region?.runs?.filter((r) => r.text.trim().length > 0);
      if (nonEmptyRuns && nonEmptyRuns.length > 0) {
        return nonEmptyRuns.every((r) => r.bold);
      }
      return Boolean(it.region?.style.bold);
    };

    const getLocalRightBound = (baseX: number, yRef: number, boldFlag: boolean): number => {
      let localMax = 0;
      for (const r of rows) {
        if (Math.abs(r.yTop - yRef) > 2.5) continue;
        if (r.items.length === 1) {
          const it = r.items[0];
          if (
            it.kind === 'text' &&
            Math.abs(it.x - baseX) <= ptToIn(4) &&
            isAllBold(it) === boldFlag
          ) {
            localMax = Math.max(localMax, it.x + it.width);
          }
        } else if (
          r.items.length === 2 &&
          STANDALONE_MARKER_RE.test((r.items[0].region?.text ?? '').trim())
        ) {
          const it = r.items[1];
          if (
            it.kind === 'text' &&
            Math.abs(it.x - baseX) <= ptToIn(4) &&
            isAllBold(it) === boldFlag
          ) {
            localMax = Math.max(localMax, it.x + it.width);
          }
        }
      }
      return localMax > 0 ? localMax : Math.max(blockW * 0.72, baseX + ptToIn(60));
    };

    const out: V3LogicalRowBucket[] = [];
    let lastState:
      | {
          row: V3LogicalRowBucket;
          targetBaseX: number;
          lastLineX: number;
          lastLineRight: number;
          lastLineY: number;
          lastLineBottom: number;
          lastLineText: string;
          lastRectId?: string;
        }
      | undefined;

    for (const curRow of rows) {
      let merged = false;

      if (
        lastState &&
        !lastState.row.isHeaderRow &&
        curRow.items.length === 1 &&
        curRow.items[0].kind === 'text' &&
        curRow.items[0].region
      ) {
        const accRow = lastState.row;
        const targetItem = accRow.items[accRow.items.length - 1];
        const curItem = curRow.items[0];
        const curText = (curItem.region!.text ?? '').trim();

        const targetRect = findEnclosingRect(targetItem);
        const curRect = findEnclosingRect(curItem);
        const sameRect = (targetRect?.region?.id ?? undefined) === (curRect?.region?.id ?? undefined);

        const curStartsNewMarker =
          CLAUSE_PREFIX_RE.test(curText) || STANDALONE_MARKER_RE.test(curText);

        const isSingleOrMarkerPair =
          accRow.items.length === 1 ||
          (accRow.items.length === 2 &&
            STANDALONE_MARKER_RE.test((accRow.items[0].region?.text ?? '').trim()));

        if (
          targetItem.kind === 'text' &&
          targetItem.region &&
          curText.length > 0 &&
          !curStartsNewMarker &&
          sameRect &&
          (isSingleOrMarkerPair || Boolean(curRect))
        ) {
          const targetAllBold = isAllBold(targetItem);
          const curAllBold = isAllBold(curItem);
          const targetFs = Math.max(6.5, targetItem.region.style.fontSizePt || 8.5);
          const curFs = Math.max(6.5, curItem.region!.style.fontSizePt || 8.5);
          const targetCol = (targetItem.region.style.color ?? '#0F172A').toUpperCase();
          const curCol = (curItem.region!.style.color ?? '#0F172A').toUpperCase();

          const compatibleFont =
            targetAllBold === curAllBold &&
            targetItem.region.style.italic === curItem.region!.style.italic &&
            Math.abs(targetFs - curFs) <= 1.2 &&
            targetCol === curCol;

          const dyBaseline = curItem.y - lastState.lastLineY;
          const dyGap = curItem.y - lastState.lastLineBottom;
          const validLeading =
            dyBaseline > 0 &&
            dyBaseline <= ptToIn(targetFs * 1.65) &&
            dyGap <= ptToIn(targetFs * 0.95);

          const isCenteredPair =
            targetItem.region.style.textAlign === 'Center' &&
            curItem.region!.style.textAlign === 'Center' &&
            Math.abs(
              lastState.lastLineX +
                (lastState.lastLineRight - lastState.lastLineX) / 2 -
                (curItem.x + curItem.width / 2)
            ) <= ptToIn(10);

          const alignedLeft = Math.abs(curItem.x - lastState.targetBaseX) <= ptToIn(4);

          const colRightBound = curRect
            ? curRect.x + curRect.width - ptToIn(2)
            : Math.max(
                lastState.lastLineRight,
                getLocalRightBound(lastState.targetBaseX, curItem.y, targetAllBold)
              );
          const firstWord = curText.split(/\s+/)[0] ?? '';
          const estFirstWordW = ptToIn(firstWord.length * targetFs * 0.48);
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
            (!couldFitOnPrevLine ||
              lastLineFilledW >= availSpan * 0.65 ||
              lastState.lastLineRight >= colRightBound - ptToIn(24) ||
              (isCenteredPair && lastLineFilledW >= availSpan * 0.55));

          const clearBetween = !hasSeparatorBetween(
            lastState.lastLineBottom,
            curItem.y,
            Math.min(lastState.lastLineX, curItem.x),
            Math.max(lastState.lastLineRight, curItem.x + curItem.width),
            targetRect?.region?.id
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
              curItem.region!.runs && curItem.region!.runs.length > 0
                ? curItem.region!.runs.map((r) => ({ ...r }))
                : [
                    {
                      text: curText,
                      fontFamily: curItem.region!.style.fontFamily,
                      fontSizePt: curItem.region!.style.fontSizePt,
                      bold: curItem.region!.style.bold,
                      italic: curItem.region!.style.italic,
                      underline: curItem.region!.style.underline,
                      color: curItem.region!.style.color,
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
              x: Math.min(targetItem.region.x, curItem.region!.x),
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
            merged = true;
          }
        }
      }

      if (!merged) {
        const clonedRow: V3LogicalRowBucket = {
          ...curRow,
          items: curRow.items.map((it) => ({
            ...it,
            region: it.region
              ? {
                  ...it.region,
                  style: { ...it.region.style },
                  runs: it.region.runs?.map((r) => ({ ...r })),
                }
              : undefined,
          })),
        };
        out.push(clonedRow);

        const tail = clonedRow.items[clonedRow.items.length - 1];
        if (tail && tail.kind === 'text' && tail.region) {
          const tailRect = findEnclosingRect(tail);
          lastState = {
            row: clonedRow,
            targetBaseX: tail.x,
            lastLineX: tail.x,
            lastLineRight: tail.x + tail.width,
            lastLineY: tail.y,
            lastLineBottom: tail.y + tail.height,
            lastLineText: (tail.region.text ?? '').trim(),
            lastRectId: tailRect?.region?.id,
          };
        } else {
          lastState = undefined;
        }
      }
    }

    return out;
  }

  private mergeV3CellBucketItems(cellItems: BodyItemBox[]): BodyItemBox {
    const sorted = [...cellItems].sort((a, b) => a.y - b.y || a.x - b.x);
    if (sorted.length === 1) return sorted[0];
    const textParts = sorted.filter((i) => i.kind === 'text' && i.region);
    if (textParts.length === 0) return sorted[0];
    if (textParts.length === 1) return textParts[0];

    let mergedText = '';
    const mergedRuns: VisualTextRun[] = [];
    for (let idx = 0; idx < textParts.length; idx++) {
      const tp = textParts[idx];
      const reg = tp.region!;
      const part = (reg.text ?? '').trim();
      if (!part) continue;
      let sep = '';
      if (mergedText.length > 0) {
        const prev = textParts[idx - 1];
        const dyBase = tp.y - prev.y;
        const fs = Math.max(6.5, prev.region?.style.fontSizePt || 8.5);
        const sameLine = Math.abs(dyBase) <= ptToIn(3.5);
        const isWrapCont =
          !sameLine &&
          dyBase > 0 &&
          dyBase <= ptToIn(fs * 1.65) &&
          !/[:.?!]$/.test((prev.region?.text ?? '').trim());
        sep = sameLine || isWrapCont ? ' ' : '\n';
      }
      mergedText = `${mergedText}${sep}${part}`;
      if (sep && mergedRuns.length > 0) {
        mergedRuns.push({ ...mergedRuns[mergedRuns.length - 1], text: sep });
      }
      if (reg.runs && reg.runs.length > 0) {
        for (const r of reg.runs) mergedRuns.push({ ...r });
      } else {
        mergedRuns.push({
          text: part,
          fontFamily: reg.style.fontFamily,
          fontSizePt: reg.style.fontSizePt,
          bold: reg.style.bold,
          italic: reg.style.italic,
          underline: reg.style.underline,
          color: reg.style.color,
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
      region: first.region
        ? {
            ...first.region,
            x: minX,
            y: minY,
            width: maxR - minX,
            height: maxB - minY,
            text: mergedText,
            runs: mergedRuns,
          }
        : undefined,
    };
  }

  private tryBuildV3ModeAGrid(
    contentItems: BodyItemBox[],
    tableRects: BodyItemBox[],
    lineItems: BodyItemBox[],
    blockW: number,
    contentSpanY: number
  ): { atomicBoundaries: number[]; logicalRows: V3LogicalRowBucket[] } | null {
    if (contentItems.length < 4) return null;

    const vLines = lineItems.filter((ln) => ln.width <= ptToIn(3) && ln.height >= ptToIn(18));
    const hLines = lineItems.filter((ln) => ln.height <= ptToIn(3) && ln.width >= blockW * 0.55);

    const rawGridXs: number[] = [
      0,
      blockW,
      ...vLines.map((ln) => clamp(ln.x, 0, blockW)),
      ...tableRects.flatMap((rc) => [clamp(rc.x, 0, blockW), clamp(rc.x + rc.width, 0, blockW)]),
    ];
    const clusteredXs = clusterValues(rawGridXs, ptToIn(4));
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
      ...tableRects.flatMap((rc) => [rc.y, rc.y + rc.height]),
    ];
    const gridYs = clusterValues(rawGridYs, ptToIn(4));

    if (gridXs.length < 4 || gridYs.length < 3) return null;
    const gridSpanY = gridYs[gridYs.length - 1] - gridYs[0];
    if (gridSpanY < Math.max(ptToIn(40), contentSpanY * 0.60)) return null;

    const expanded = this.expandV3MultilineItems(contentItems);
    const intervals: Array<[number, number]> = [];
    const above = expanded.filter((it) => it.y + it.height / 2 < gridYs[0] - ptToIn(3));
    if (above.length > 0) {
      intervals.push([Math.min(...above.map((i) => i.y)) - ptToIn(1), gridYs[0]]);
    }
    for (let k = 0; k < gridYs.length - 1; k++) {
      const yA = gridYs[k];
      const yB = gridYs[k + 1];
      if (yB - yA < ptToIn(4)) continue;
      if (yB - yA > ptToIn(160)) {
        const inside = expanded.filter((it) => {
          const cy = it.y + it.height / 2;
          return cy >= yA - ptToIn(2) && cy <= yB + ptToIn(2);
        });
        const yClusters = clusterValues(inside.map((i) => i.y), ptToIn(3.5));
        if (yClusters.length >= 3) {
          const subRows = this.clusterV3ItemsIntoRows(inside, tableRects);
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
    const logicalRows: V3LogicalRowBucket[] = [];
    for (let iIdx = 0; iIdx < intervals.length; iIdx++) {
      const [yA, yB] = intervals[iIdx];
      const rowItems = expanded.filter((it) => {
        const cy = it.y + it.height / 2;
        return cy >= yA - ptToIn(2) && cy <= yB + ptToIn(2);
      });
      if (rowItems.length === 0) continue;

      const byCol = new Map<number, BodyItemBox[]>();
      for (const it of rowItems) {
        const cx = clamp(it.x + Math.min(it.width / 2, ptToIn(12)), 0, blockW - 0.001);
        let col = 0;
        for (let c = 0; c < numCols; c++) {
          if (cx >= gridXs[c] - ptToIn(2) && cx <= gridXs[c + 1] + ptToIn(2)) {
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
        .map(([, list]) => this.mergeV3CellBucketItems(list));
      const midY = (yA + yB) / 2;
      const rowRects = tableRects.filter(
        (rc) => midY >= rc.y - ptToIn(2) && midY <= rc.y + rc.height + ptToIn(2)
      );
      const isHdr =
        iIdx === 0 &&
        (mergedCells.every((it) => Boolean(it.region?.style.bold)) ||
          rowRects.some((rc) => Boolean(rc.region?.style.backgroundColor)));

      logicalRows.push({
        yTop: yA,
        yBottom: yB,
        items: mergedCells,
        rects: rowRects,
        isHeaderRow: isHdr,
      });
    }

    if (logicalRows.length < 2) return null;
    return { atomicBoundaries: gridXs, logicalRows };
  }

  private compactV3EmbeddedSubTableZones(
    rows: V3LogicalRowBucket[],
    tableRects: BodyItemBox[],
    lineItems: BodyItemBox[],
    blockW: number,
    contentSpanY: number
  ): V3LogicalRowBucket[] {
    if (rows.length < 2 || tableRects.length < 2) return rows;

    const sortedRects = [...tableRects].sort((a, b) => a.y - b.y);
    const zones: Array<{ yTop: number; yBottom: number; rects: BodyItemBox[] }> = [];
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
        ptToIn(4)
      );
      const ys = clusterValues(z.rects.flatMap((r) => [r.y, r.y + r.height]), ptToIn(4));
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
        ptToIn(4)
      );
      const subGridYs = clusterValues(
        [...zone.rects.flatMap((r) => [r.y, r.y + r.height]), ...zHLines.map((l) => l.y)],
        ptToIn(4)
      );
      if (subGridXs.length < 3 || subGridYs.length < 2) continue;

      const before: V3LogicalRowBucket[] = [];
      const insideItems: BodyItemBox[] = [];
      const after: V3LogicalRowBucket[] = [];

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
      const expandedInside = this.expandV3MultilineItems(insideItems);
      const subRows: V3LogicalRowBucket[] = [];
      for (let k = 0; k < subGridYs.length - 1; k++) {
        const yA = subGridYs[k];
        const yB = subGridYs[k + 1];
        if (yB - yA < ptToIn(4)) continue;
        const rowItems = expandedInside.filter((it) => {
          const cy = it.y + it.height / 2;
          return cy >= yA - ptToIn(2) && cy <= yB + ptToIn(2);
        });
        if (rowItems.length === 0) continue;

        const byCol = new Map<number, BodyItemBox[]>();
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
          .map(([, list]) => this.mergeV3CellBucketItems(list));
        const midY = (yA + yB) / 2;
        const rowRects = zone.rects.filter(
          (rc) => midY >= rc.y - ptToIn(2) && midY <= rc.y + rc.height + ptToIn(2)
        );
        subRows.push({
          yTop: yA,
          yBottom: yB,
          items: mergedCells,
          rects: rowRects,
          isHeaderRow: k === 0 && (mergedCells.every((it) => Boolean(it.region?.style.bold)) || rowRects.some((rc) => Boolean(rc.region?.style.backgroundColor))),
          isSubTableRow: true,
        });
      }

      if (subRows.length > 0) {
        currentRows = [...before, ...subRows, ...after];
      }
    }

    return currentRows;
  }

  private buildV3AtomicColumnGrid(
    rows: V3LogicalRowBucket[],
    rectItems: BodyItemBox[],
    lineItems: BodyItemBox[],
    blockW: number
  ): number[] {
    const tolIn = ptToIn(4);
    const rawEdges: number[] = [0, blockW];

    for (const rc of rectItems) {
      if (rc.width < blockW * 0.94 && rc.height <= ptToIn(120)) {
        rawEdges.push(clamp(rc.x, 0, blockW));
        rawEdges.push(clamp(rc.x + rc.width, 0, blockW));
      }
    }

    for (const ln of lineItems) {
      if (ln.width <= ptToIn(3) && ln.height >= ptToIn(8)) {
        rawEdges.push(clamp(ln.x, 0, blockW));
      }
    }

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      if (row.items.length === 0 || row.isSubTableRow) continue;
      const firstText = (row.items[0].region?.text ?? '').trim();
      if (STANDALONE_MARKER_RE.test(firstText)) {
        const xMarker = clamp(row.items[0].x, 0, blockW);
        if (row.items.length >= 2) {
          const xBody = clamp(row.items[1].x, 0, blockW);
          rawEdges.push(xMarker);
          if (xBody - xMarker >= ptToIn(8)) {
            rawEdges.push(xBody);
          }
        } else if (rIdx + 1 < rows.length && rows[rIdx + 1].items.length >= 1) {
          const nextItem = rows[rIdx + 1].items[0];
          const xBody = clamp(nextItem.x, 0, blockW);
          if (nextItem.y - row.yTop <= ptToIn(18) && xBody - xMarker >= ptToIn(8)) {
            rawEdges.push(xMarker);
            rawEdges.push(xBody);
          }
        }
      }
      if (row.items.length >= 2) {
        for (const it of row.items) {
          rawEdges.push(clamp(it.x, 0, blockW));
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

  private mapV3ItemToAtomicSpan(
    item: BodyItemBox,
    boundaries: number[],
    numCols: number,
    rowItems: BodyItemBox[],
    isDataTable: boolean,
    rowRects: BodyItemBox[]
  ): { startCol: number; endCol: number } {
    const tol = ptToIn(5);
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
        if (anchorX >= boundaries[c]) startCol = c;
      }
    }

    const txt = (item.region?.text ?? '').trim();
    const isMarkerFollowedByTrailing =
      rowItems.length === 2 &&
      itemIdx === 1 &&
      STANDALONE_MARKER_RE.test((rowItems[0].region?.text ?? '').trim());
    const isSingleFullTrackNarrative =
      rowItems.length === 1 &&
      rowRects.length === 0 &&
      (Boolean(item.region?.style.bold) ||
        item.width > (boundaries[Math.min(numCols, startCol + 1)] - item.x) + ptToIn(4) ||
        CLAUSE_PREFIX_RE.test(txt) ||
        txt.length > 35 ||
        !isDataTable ||
        item.x + item.width > boundaries[startCol + 1] - ptToIn(6));

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

  private detectV3StructuredDataTable(
    rows: V3LogicalRowBucket[],
    rectItems: BodyItemBox[],
    numCols: number
  ): boolean {
    if (numCols >= 4 && rows.length >= 4) return true;
    const borderedRects = rectItems.filter(
      (r) => Boolean(r.region?.style.borderColor) || Boolean(r.region?.style.backgroundColor)
    );
    if (borderedRects.length >= 4 && numCols >= 3) return true;
    const numericRows = rows.filter(
      (r) =>
        r.items.length >= 3 &&
        r.items.slice(1).some((it) => /[0-9]/.test(it.region?.text ?? ''))
    );
    return numericRows.length >= 3;
  }

  private buildV3CellStyle(
    textStyle: RegionStyle | undefined,
    rectStyle: RegionStyle | undefined,
    applyGridBorder: boolean,
    isHeaderRow: boolean
  ): RegionStyle {
    return {
      fontFamily: textStyle?.fontFamily ?? 'Arial',
      fontSizePt: textStyle?.fontSizePt ?? 8.5,
      bold: textStyle?.bold ?? isHeaderRow,
      italic: textStyle?.italic ?? false,
      underline: textStyle?.underline,
      color: textStyle?.color ?? '#0F172A',
      backgroundColor: rectStyle?.backgroundColor ?? textStyle?.backgroundColor,
      borderColor: applyGridBorder ? (rectStyle?.borderColor ?? '#D0D7DE') : rectStyle?.borderColor,
      borderWidthPt: applyGridBorder ? (rectStyle?.borderWidthPt ?? 0.5) : rectStyle?.borderWidthPt,
      textAlign: textStyle?.textAlign ?? (isHeaderRow ? 'Center' : 'Left'),
      verticalAlign: isHeaderRow ? 'Middle' : 'Top',
      paddingPt: { top: 2, right: 3, bottom: 2, left: 3 },
    };
  }

  private applyV3VerticalMergeBorderSuppression(
    tablixRows: TablixRow[],
    rectItems: BodyItemBox[],
    lineItems: BodyItemBox[],
    logicalRows: V3LogicalRowBucket[],
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

    for (const rc of rectItems) {
      if (!rc.region?.style.borderColor && !rc.region?.style.backgroundColor) continue;
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

    if (!isDataTable || numCols < 3) return;
    const horizLines = lineItems.filter((ln) => ln.height <= ptToIn(3) && ln.width >= ptToIn(10));
    const hasHorizSeparatorBetween = (colIdx: number, y1: number, y2: number): boolean => {
      const colMid = (atomicBoundaries[colIdx] + atomicBoundaries[colIdx + 1]) / 2;
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
          const hasRightData = tablixRows[nextOutIdx].cells
            .slice(c + 1)
            .some((rc) => !rc.skipBecauseMerged && rc.content.kind === 'Textbox' && rc.content.value.trim().length > 0);
          if (!hasRightData) break;

          const prevLr = logicalRows[nextLrIdx - 1];
          if (hasHorizSeparatorBetween(c, prevLr.yBottom, nextLr.yTop)) break;

          group.push(nextOutIdx);
          nextLrIdx++;
        }

        if (group.length >= 2) suppressVerticalGroup(group, c);
        lrIdx = Math.max(lrIdx + 1, nextLrIdx);
      }
    }
  }

  private emitItemsIntoFlatBoxLayer(
    items: BodyItemBox[],
    containerW: number,
    containerH: number,
    pageNumber: number,
    paramCtx: ParameterDetectionContext,
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string,
    nextUniqueName: (prefix: string) => string,
    bodyMedianFontPt: number,
    opts: { allowMultiLineGrouping: boolean; normalizeFooterExpressions?: boolean }
  ): {
    rectangles: VisualRectItem[];
    images: VisualImageItem[];
    textboxes: VisualTextboxItem[];
    tablixes: TablixRegion[];
  } {
    const orderedItems = [...items].sort((a, b) => a.rawIndex - b.rawIndex);
    const orderedRects: VisualRectItem[] = [];
    const images: VisualImageItem[] = [];
    const tablixes: TablixRegion[] = [];
    const textItems: BodyItemBox[] = [];

    for (const it of orderedItems) {
      if (it.kind === 'tablix' && it.tablix) {
        tablixes.push({ ...it.tablix, zIndex: 1 });
        continue;
      }
      if ((it.kind === 'rect' || it.kind === 'line') && it.region) {
        const r = it.region;
        const minDim = it.kind === 'line' ? 0.005 : 0.015;
        const x1 = clamp(it.x, 0, Math.max(0, containerW - minDim));
        const y1 = clamp(it.y, 0, Math.max(0, containerH - minDim));
        let w = roundIn(clamp(it.width, minDim, containerW - x1));
        let h = roundIn(clamp(it.height, minDim, containerH - y1));

        if (it.kind === 'line') {
          const horizontal = r.width >= r.height;
          if (horizontal) {
            if (w < 0.04) continue;
            h = Math.max(0.005, h);
          } else {
            if (h < 0.04) continue;
            w = Math.max(0.005, w);
          }
          const lineColor = r.style.borderColor ?? r.style.backgroundColor ?? '#CBD5E1';
          orderedRects.push({
            kind: 'Rectangle',
            name: nextUniqueName('LineRect'),
            leftIn: roundIn(x1),
            topIn: roundIn(y1),
            widthIn: roundIn(Math.min(w, containerW - x1)),
            heightIn: roundIn(Math.min(h, containerH - y1)),
            backgroundColor: lineColor,
            borderWidthPt: r.style.borderWidthPt ?? 0.5,
            zIndex: 0,
            role: 'line',
          });
          continue;
        }

        const bg = r.style.backgroundColor;
        const bc = r.style.borderColor;
        if (!bg && !bc) continue;
        orderedRects.push({
          kind: 'Rectangle',
          name: nextUniqueName('Rect'),
          leftIn: roundIn(x1),
          topIn: roundIn(y1),
          widthIn: w,
          heightIn: h,
          backgroundColor: bg,
          borderColor: bc,
          borderWidthPt: bc ? Math.max(0.4, r.style.borderWidthPt ?? 0.75) : undefined,
          zIndex: 0,
          role: 'fill',
        });
        continue;
      }

      if (it.kind === 'image' && it.region?.imageAssetBase64) {
        const x1 = clamp(it.x, 0, Math.max(0, containerW - 0.04));
        const y1 = clamp(it.y, 0, Math.max(0, containerH - 0.04));
        const w = roundIn(clamp(it.width, 0.06, containerW - x1));
        const h = roundIn(clamp(it.height, 0.06, containerH - y1));
        const isGlyphCrop = it.region.sourceObjectRefs.some((ref) => ref.includes('-glyph-'));
        const isVectorCrop = it.region.type === 'vector_complex';
        const overlapsText = items.some(
          (other) =>
            other.kind === 'text' &&
            other.x < x1 + w &&
            other.x + other.width > x1 &&
            other.y < y1 + h &&
            other.y + other.height > y1
        );
        const embName = registerEmbeddedImage(
          it.region.imageAssetBase64,
          it.region.imageAssetName ?? `Graphic_P${pageNumber}_${nextUniqueName('Asset')}`
        );
        images.push({
          kind: 'Image',
          name: nextUniqueName(isGlyphCrop ? 'ImgGlyph' : 'Img'),
          embeddedImageName: embName,
          leftIn: roundIn(x1),
          topIn: roundIn(y1),
          widthIn: w,
          heightIn: h,
          sizing: isGlyphCrop || (isVectorCrop && overlapsText) ? 'Fit' : 'FitProportional',
          zIndex: overlapsText ? 0 : isGlyphCrop ? 2 : 1,
        });
        continue;
      }

      if (it.kind === 'text' && it.region?.text && it.region.text.trim().length > 0) {
        textItems.push(it);
      }
    }

    // Deduplicate only consecutive identical rects so PDF z-order is never reordered
    const rectangles: VisualRectItem[] = [];
    for (const rect of orderedRects) {
      const prev = rectangles[rectangles.length - 1];
      if (
        prev &&
        prev.role === rect.role &&
        Math.abs(prev.leftIn - rect.leftIn) <= 0.01 &&
        Math.abs(prev.topIn - rect.topIn) <= 0.01 &&
        Math.abs(prev.widthIn - rect.widthIn) <= 0.015 &&
        Math.abs(prev.heightIn - rect.heightIn) <= 0.015 &&
        (!rect.backgroundColor || !prev.backgroundColor || prev.backgroundColor === rect.backgroundColor)
      ) {
        rectangles[rectangles.length - 1] = {
          ...prev,
          backgroundColor: rect.backgroundColor ?? prev.backgroundColor,
          borderColor: rect.borderColor ?? prev.borderColor,
          borderWidthPt: rect.borderWidthPt ?? prev.borderWidthPt,
        };
      } else {
        rectangles.push(rect);
      }
    }

    textItems.sort((a, b) => (Math.abs(a.y - b.y) <= 0.045 ? a.x - b.x : a.y - b.y));
    const singleLineBoxes: Array<{
      tb: VisualTextboxItem;
      region: LayoutRegion;
      hasRightSibling: boolean;
      hasLeftSibling: boolean;
      isDynamicExpr: boolean;
    }> = [];

    for (let i = 0; i < textItems.length; i++) {
      const it = textItems[i];
      const r = it.region!;
      let relX = clamp(it.x, 0, Math.max(0, containerW - 0.08));
      const relY = clamp(it.y, 0, Math.max(0, containerH - 0.08));

      let nextLeft = containerW;
      let hasRightSibling = false;
      const curTextH = Math.min(it.height, (r.style.fontSizePt / PT_PER_INCH) * 1.08);
      const idealH = Math.max(it.height, (r.style.fontSizePt / PT_PER_INCH) * 1.15);
      for (let j = 0; j < textItems.length; j++) {
        if (j === i) continue;
        const sib = textItems[j];
        const sibFontPt = sib.region?.style.fontSizePt ?? r.style.fontSizePt;
        const sibTextH = Math.min(sib.height, (sibFontPt / PT_PER_INCH) * 1.08);
        const vertOverlap = Math.min(relY + curTextH, sib.y + sibTextH) - Math.max(relY, sib.y);
        if (sib.x >= relX + it.width * 0.45 && vertOverlap > 0.015) {
          nextLeft = Math.min(nextLeft, sib.x - 0.01);
          if (Math.abs(sib.y - it.y) <= 0.045) hasRightSibling = true;
        }
      }

      let precedingLabel: string | undefined;
      let hasLeftSibling = false;
      if (i > 0) {
        const prev = textItems[i - 1];
        if (Math.abs(prev.y - it.y) <= 0.045 && prev.x < it.x) {
          hasLeftSibling = true;
          if (
            prev.region?.text &&
            prev.region.text.trim().endsWith(':') &&
            prev.region.text.trim().length <= 32
          ) {
            precedingLabel = prev.region.text.trim();
          }
        }
      }

      const align = r.style.textAlign ?? 'Left';
      if (align === 'Left') {
        relX = Math.max(0, relX - 1 / PT_PER_INCH);
      } else if (align === 'Center') {
        relX = Math.max(0, relX - Math.min(0.04, relX));
      } else if (align === 'Right') {
        relX = Math.max(0, relX - Math.min(0.06, relX));
      }
      const colRemaining = Math.max(0.06, nextLeft - relX);
      const paddedW = it.width * 1.06 + 0.08;
      const boxW = clamp(paddedW, 0.06, colRemaining);

      // Compute non-overlapping vertical clearance below this box
      let nextBelowTop = containerH;
      for (let j = i + 1; j < textItems.length; j++) {
        const below = textItems[j];
        if (below.y <= relY + 0.025) continue;
        if (below.x < relX + boxW && below.x + below.width > relX) {
          nextBelowTop = Math.min(nextBelowTop, below.y - 0.004);
          break;
        }
      }

      const maxNoOverlapH =
        nextBelowTop < containerH
          ? Math.max(0.06, nextBelowTop - relY)
          : Math.max((r.style.fontSizePt / PT_PER_INCH) * 1.02, containerH - relY);
      const boxH = clamp(Math.min(idealH, maxNoOverlapH), 0.06, Math.max(0.06, containerH - relY));

      const baseRuns: VisualTextRun[] =
        r.runs && r.runs.length > 0
          ? r.runs.map((run) => ({ ...run }))
          : [
              {
                text: r.text ?? '',
                fontFamily: r.style.fontFamily,
                fontSizePt: r.style.fontSizePt,
                bold: r.style.bold,
                italic: r.style.italic,
                underline: r.style.underline,
                color: r.style.color,
              },
            ];

      let finalRuns = baseRuns;
      let isDynamicExpr = false;

      if (opts.normalizeFooterExpressions && r.text) {
        const expr = buildDynamicPageFooterExpr(r.text);
        if (expr) {
          finalRuns = [{ ...baseRuns[0], text: expr }];
          isDynamicExpr = true;
        }
      } else {
        finalRuns = parameterizeTextRuns(paramCtx, baseRuns, pageNumber, precedingLabel);
        isDynamicExpr = finalRuns.some((rn) => Boolean(rn.parameterName));
      }

      const cleanStyle: RegionStyle = {
        ...r.style,
        backgroundColor: undefined,
        borderColor: undefined,
        borderWidthPt: undefined,
        verticalAlign: 'Top',
        paddingPt: { top: 0, right: 1, bottom: 0, left: 1 },
      };

      singleLineBoxes.push({
        tb: {
          kind: 'Textbox',
          name: nextUniqueName('Txt'),
          leftIn: roundIn(relX),
          topIn: roundIn(relY),
          widthIn: roundIn(boxW),
          heightIn: roundIn(boxH),
          text: r.text ?? '',
          runs: finalRuns,
          style: cleanStyle,
          canGrow: true,
          zIndex: 1,
        },
        region: r,
        hasRightSibling,
        hasLeftSibling,
        isDynamicExpr,
      });
    }

    if (!opts.allowMultiLineGrouping || singleLineBoxes.length <= 1) {
      return {
        rectangles,
        images,
        textboxes: singleLineBoxes.map((s) => s.tb),
        tablixes,
      };
    }

    // Group consecutive wrapped paragraph lines into multi-Paragraph Textboxes with 96% calibrated LineHeight
    const groupedTextboxes: VisualTextboxItem[] = [];
    const consumed = new Set<number>();

    for (let i = 0; i < singleLineBoxes.length; i++) {
      if (consumed.has(i)) continue;
      consumed.add(i);
      const anchor = singleLineBoxes[i];
      const chain = [anchor];

      if (
        !anchor.isDynamicExpr &&
        !anchor.hasRightSibling &&
        !isLikelyHeadingRegion(anchor.region, bodyMedianFontPt) &&
        anchor.region.semanticRole !== 'fieldLabel'
      ) {
        let basePitch: number | undefined;
        let lastIdx = i;

        for (let j = i + 1; j < singleLineBoxes.length; j++) {
          if (consumed.has(j)) continue;
          const prevEntry = chain[chain.length - 1];
          const cand = singleLineBoxes[j];
          const dy = cand.tb.topIn - prevEntry.tb.topIn;

          const maxPitch = Math.max(0.22, (prevEntry.tb.style.fontSizePt / PT_PER_INCH) * 1.85);
          if (dy > maxPitch + 0.04) break;
          if (dy < 0.065) continue;

          if (cand.isDynamicExpr || cand.hasLeftSibling || cand.hasRightSibling) continue;
          if (Math.abs(cand.tb.leftIn - anchor.tb.leftIn) > 0.045) continue;
          if (cand.tb.style.fontFamily !== anchor.tb.style.fontFamily) continue;
          if (Math.abs(cand.tb.style.fontSizePt - anchor.tb.style.fontSizePt) > 0.5) continue;
          if (cand.tb.style.textAlign !== anchor.tb.style.textAlign) continue;
          if (isLikelyHeadingRegion(cand.region, bodyMedianFontPt)) continue;
          if (CLAUSE_PREFIX_RE.test(cand.tb.text.trim())) continue;

          const hasIntervening = singleLineBoxes.some((other, k) => {
            if (k === lastIdx || k === j || consumed.has(k)) return false;
            return (
              other.tb.topIn > prevEntry.tb.topIn + 0.01 &&
              other.tb.topIn < cand.tb.topIn - 0.01 &&
              other.tb.leftIn < Math.max(prevEntry.tb.leftIn + prevEntry.tb.widthIn, cand.tb.leftIn + cand.tb.widthIn) &&
              other.tb.leftIn + other.tb.widthIn > anchor.tb.leftIn
            );
          });
          if (hasIntervening) continue;

          if (basePitch === undefined) {
            basePitch = dy;
          } else if (Math.abs(dy - basePitch) > 0.025) {
            continue;
          }

          chain.push(cand);
          consumed.add(j);
          lastIdx = j;
        }
      }

      if (chain.length === 1) {
        groupedTextboxes.push(anchor.tb);
      } else {
        const first = chain[0].tb;
        const last = chain[chain.length - 1].tb;
        const avgPitchIn = (last.topIn - first.topIn) / (chain.length - 1);
        const rawPitchPt = avgPitchIn * PT_PER_INCH;
        const calibratedLhPt = Math.round(rawPitchPt * 10) / 10;
        const leftIn = Math.min(...chain.map((c) => c.tb.leftIn));
        const rightIn = Math.max(...chain.map((c) => c.tb.leftIn + c.tb.widthIn));
        const maxWidth = clamp(rightIn - leftIn, 0.1, containerW - leftIn);

        let nextBelowTop = containerH;
        for (let j = 0; j < singleLineBoxes.length; j++) {
          if (consumed.has(j)) continue;
          const other = singleLineBoxes[j].tb;
          if (other.topIn > last.topIn + 0.01 && other.leftIn < leftIn + maxWidth && other.leftIn + other.widthIn > leftIn) {
            nextBelowTop = Math.min(nextBelowTop, other.topIn - 0.004);
            break;
          }
        }
        const totalH = clamp(
          Math.min(last.topIn - first.topIn + last.heightIn + 0.01, nextBelowTop - first.topIn),
          first.heightIn,
          Math.max(first.heightIn, containerH - first.topIn)
        );

        const paragraphLines: VisualParagraphSpec[] = chain.map((c) => ({
          runs: c.tb.runs ?? [],
          lineHeightPt: calibratedLhPt,
          textAlign: c.tb.style.textAlign,
        }));

        groupedTextboxes.push({
          kind: 'Textbox',
          name: first.name,
          leftIn: roundIn(leftIn),
          topIn: roundIn(first.topIn),
          widthIn: roundIn(maxWidth),
          heightIn: roundIn(totalH),
          text: chain.map((c) => c.tb.text).join('\n'),
          runs: first.runs,
          paragraphLines,
          style: {
            ...first.style,
            lineHeightPt: calibratedLhPt,
          },
          canGrow: true,
          zIndex: 1,
        });
      }
    }

    // Deterministic non-overlap guarantee across all grouped textboxes
    const sortedOut = [...groupedTextboxes].sort((a, b) => a.topIn - b.topIn || a.leftIn - b.leftIn);
    for (let i = 0; i < sortedOut.length; i++) {
      const a = sortedOut[i];
      for (let j = i + 1; j < sortedOut.length; j++) {
        const b = sortedOut[j];
        if (b.topIn >= a.topIn + a.heightIn - 0.015) break;
        const ox = Math.min(a.leftIn + a.widthIn, b.leftIn + b.widthIn) - Math.max(a.leftIn, b.leftIn);
        const oy = Math.min(a.topIn + a.heightIn, b.topIn + b.heightIn) - Math.max(a.topIn, b.topIn);
        if (ox > 0.015 && oy > 0.015) {
          if (b.leftIn > a.leftIn + 0.05 && a.leftIn + a.widthIn > b.leftIn) {
            a.widthIn = roundIn(Math.max(0.06, b.leftIn - a.leftIn - 0.008));
          } else if (a.leftIn > b.leftIn + 0.05 && b.leftIn + b.widthIn > a.leftIn) {
            b.widthIn = roundIn(Math.max(0.06, a.leftIn - b.leftIn - 0.008));
          } else if (b.topIn > a.topIn + 0.02) {
            a.heightIn = roundIn(Math.max(0.05, b.topIn - a.topIn - 0.006));
          }
        }
      }
    }

    return {
      rectangles,
      images,
      textboxes: sortedOut,
      tablixes,
    };
  }
}
