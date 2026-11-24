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
  minRowHeightPt = 14
): number {
  let maxH = minRowHeightPt;
  for (const c of cells) {
    const padL = c.style.paddingPt?.left ?? 2;
    const padR = c.style.paddingPt?.right ?? 2;
    const padT = c.style.paddingPt?.top ?? 2;
    const padB = c.style.paddingPt?.bottom ?? 2;
    const innerWidthPt = Math.max(20, c.coveredWidthPt - (padL + padR));
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
      totalLines * (fontSizePt * 1.36) + padT + padB + (totalLines > 1 ? 1.5 : 0)
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
}

export interface Flat2008CompileOutput {
  pageHeaderSpec?: RdlcBandContainerSpec;
  pageFooterSpec?: RdlcBandContainerSpec;
  bodyTablixes: TablixRegion[];
  hierarchy: RdlcDocumentHierarchy;
}

const CLAUSE_TITLE_WITH_MARKER_RE = /^(\d+(?:\.\d+)*\.|\(\d+\)|\([a-z]{1,2}\)|[a-z]\.|[•\u2022\-–])\s+(.+)$/i;
const STANDALONE_MARKER_RE = /^(\d+(?:\.\d+)*\.|\(\d+\)|\([a-z]{1,2}\)|[a-z]\.|[•\u2022\-–])$/i;

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
    for (const page of pages) {
      const pNum = page.pageNumber;
      const excludedIds = excludedIdsByPage.get(pNum) ?? new Set<string>();
      const pageItems: PositionedItem[] = [];

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
      printableWidthIn
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

    const gapIn = roundIn(ptToIn(6));
    const sectionGapIn = roundIn(ptToIn(10));
    let fullCursorTopIn = 0;
    let leftTrackBottomIn = 0;
    let rightTrackBottomIn = 0;
    let prevWasSideBySide = false;

    for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
      const blk = blocks[bIdx];
      const tablixName = allocateTablixName(blk.semanticName);

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
          // Entering SIDE_BY_SIDE_MODE: start both tracks at identical Top Y
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

      const tablix = this.compileFlatMasterGridTablix(
        tablixName,
        blk,
        assignedTopIn,
        dataSetName,
        registerEmbeddedImage,
        nextUniqueName
      );

      if (tablix.rows.length === 0) continue;

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
        archetype: 'A',
        rowCount: tablix.rows.length,
        colCount: tablix.columnWidthsIn.length,
        hasNestedTablixes: false,
        columnCount: tablix.columnWidthsIn.length,
        hasHeaderBand: Boolean(blk.banner),
        hasLeftColumn: blk.track === 'left',
        hasRightColumn: blk.track === 'right',
        hasFooterBand: Boolean(blk.isFootnote),
        childItemCount: tablix.rows.length,
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
    printableWidthIn: number
  ): { banners: BannerElement[]; consumedRegionIds: Set<string> } {
    const consumedRegionIds = new Set<string>();
    const bannerRects = items
      .filter((it) => isBannerCandidateRect(it.region, printableWidthIn))
      .sort((a, b) => a.y - b.y || a.x - b.x);

    const banners: BannerElement[] = [];
    for (const br of bannerRects) {
      const bgHex = br.region.style.backgroundColor;
      const bgRgb = parseHexRgb(bgHex);
      if (!bgRgb) continue;
      const bgLum = relativeLuminance(bgRgb);

      const enclosed = items
        .filter((it) => {
          if (it.kind !== 'text') return false;
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
        isFullWidth: br.width >= printableWidthIn * 0.7,
      });
    }

    return { banners, consumedRegionIds };
  }

  private segmentDocumentBlocks(
    pages: LayoutPage[],
    bodyItemsByPage: Map<number, PositionedItem[]>,
    printableWidthIn: number
  ): LogicalSegmentBlock[] {
    const blocks: LogicalSegmentBlock[] = [];

    const maxBudgetWidthIn = roundIn(Math.min(printableWidthIn, cmToIn(19.5)));
    const trackGapIn = roundIn(ptToIn(6));
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
      const { banners, consumedRegionIds } = this.extractPageBanners(
        items,
        maxBudgetWidthIn
      );
      const nonBannerItems = items
        .filter((it) => !consumedRegionIds.has(it.region.id))
        .sort((a, b) => a.y - b.y || a.x - b.x);

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
          // Two-tier split header: full-width banner <= 3.5pt above two touching half-width banners
          const subCandidates: Array<{ idx: number; b: BannerElement }> = [];
          for (let j = i + 1; j < banners.length; j++) {
            const nb = banners[j];
            if (nb.isFullWidth) continue;
            const gapBelow = nb.y - (b.y + b.height);
            if (gapBelow >= -ptToIn(1) && gapBelow <= ptToIn(3.5)) {
              subCandidates.push({ idx: j, b: nb });
            }
          }
          if (subCandidates.length >= 2) {
            const sortedSubs = subCandidates.slice(0, 2).sort((a, c) => a.b.x - c.b.x);
            if (Math.abs(sortedSubs[0].b.y - sortedSubs[1].b.y) <= ptToIn(4)) {
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
          // Side-by-side banners (|dy| <= 4pt, each width < 0.65 * printableWidth)
          const partnerIdx = banners.findIndex(
            (other, j) =>
              j > i &&
              !pairedBannerIndices.has(j) &&
              !other.isFullWidth &&
              other.width < maxBudgetWidthIn * 0.65 &&
              b.width < maxBudgetWidthIn * 0.65 &&
              Math.abs(other.y - b.y) <= ptToIn(4)
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

      // Segment non-banner items between consecutive banner Y-ranges into Y-rows for structural splitting
      bannerEvents.sort((a, b) => a.y - b.y);

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
          if (gutterW < minGutterW || center < maxBudgetWidthIn * 0.25 || center > maxBudgetWidthIn * 0.75) {
            continue;
          }
          const crossing = segmentItems.some(
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
          if (leftCount >= 3 && rightCount >= 3 && (!bestGutter || gutterW > bestGutter.width)) {
            bestGutter = { center: roundIn(center), width: gutterW };
          }
        }
        return bestGutter?.center;
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
                it.kind === 'text' &&
                it.x < gutterXIn - ptToIn(10) &&
                it.x + it.width > gutterXIn + ptToIn(10) &&
                it.width >= maxBudgetWidthIn * 0.68
            );
            if (hasFullWidthCrossing) {
              flushAllSideBySide();
            }
          }

          if (sideBySide) {
            const leftRowItems = row.items.filter((it) => it.x < gutterXIn);
            const rightRowItems = row.items.filter((it) => it.x >= gutterXIn);
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
                      trackSide === 'left' ? it.x < gutterXIn : it.x >= gutterXIn
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
          const dividerLines = segmentItems.filter(
            (it) =>
              (it.kind === 'line' || it.kind === 'rect') &&
              it.height <= ptToIn(3.5) &&
              it.width >= maxBudgetWidthIn * 0.85
          );
          if (dividerLines.length > 0) {
            const dividerYs = clusterValues(
              dividerLines.map((d) => d.y),
              ptToIn(4)
            );
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
        const beforeItems: PositionedItem[] = [];
        while (cursorIdx < nonBannerItems.length && nonBannerItems[cursorIdx].y < ev.y) {
          beforeItems.push(nonBannerItems[cursorIdx++]);
        }
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
    nextUniqueName: (prefix: string) => string
  ): TablixRegion {
    const blockLeft = block.leftIn;
    const blockW = roundIn(Math.max(0.5, block.widthIn));

    // Normalize all items relative to blockLeft
    const relItems: PositionedItem[] = block.items.map((it) => ({
      ...it,
      x: Math.max(0, it.x - blockLeft),
      width: Math.min(blockW - Math.max(0, it.x - blockLeft), it.width),
    }));

    // Banner-only 1-row full-width header block (e.g. Two-tier top banner)
    if (block.isBannerOnly && block.banner && relItems.length === 0) {
      const bannerCell = this.buildBannerTextboxCell(
        block.banner,
        0,
        0,
        1,
        nextUniqueName
      );
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
      return {
        id: tablixName,
        name: tablixName,
        pageNumber: block.pageNumber,
        bandKind: 'Detail',
        archetype: 'A',
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

    // Footnote 2-column Tablix (MarkerColumn + ContentColumn) — Layer 2 Rule 5
    if (block.isFootnote) {
      return this.compileFootnoteTablix(
        tablixName,
        block,
        relItems,
        topIn,
        dataSetName,
        nextUniqueName
      );
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

    // Layer 3 Step 1 & 2: Try Full-Block Mode A Vector-Grid-First compilation; otherwise run Paragraph-First + Embedded Sub-Table compaction
    const modeAResult = this.tryBuildModeAGrid(contentItems, tableRects, lineItems, blockW, contentSpanY);
    let logicalRows: LogicalRowBucket[];
    let atomicColBoundaries: number[];
    let isDataTable: boolean;

    if (modeAResult) {
      logicalRows = modeAResult.logicalRows;
      atomicColBoundaries = modeAResult.atomicColBoundaries;
      isDataTable = true;
    } else {
      const expandedContentItems = this.expandMultilineItems(contentItems);
      const rawRows = this.clusterItemsIntoRows(expandedContentItems, tableRects);
      const markedRows = this.splitClauseTitleRows(rawRows);
      const paraRows = this.reconstructParagraphBlocks(markedRows, tableRects, lineItems, blockW);
      logicalRows = this.compactEmbeddedSubTableZones(paraRows, tableRects, lineItems, blockW, contentSpanY);
      atomicColBoundaries = this.buildAtomicMasterColumnGrid(
        logicalRows,
        tableRects,
        lineItems,
        blockW
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
      const bannerRowCell = this.buildBannerTextboxCell(block.banner, 0, 0, numCols, nextUniqueName);
      const bannerStyle = bannerRowCell.content.kind === 'Textbox' ? bannerRowCell.content.style : defaultTextStyle(9.5);
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
        }> = [];
        const overflowItems: PositionedItem[] = [];

        for (const it of sliceItems) {
          const { startCol, endCol } = this.mapItemToAtomicSpan(
            it,
            atomicColBoundaries,
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
            // Keep 1 block = 1 cell: emit colliding block as its own subsequent row
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

        const rowAppliesTableGrid = isDataTable || Boolean(lr.isSubTableRow);
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
            const emptyStyle = this.buildTableCellStyle(undefined, undefined, rowAppliesTableGrid, false);
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
              style: defaultTextStyle(),
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
              Boolean(lr.isHeaderRow)
            );

            // Preserve centered alignment for items centered inside their table cell rect
            if (sl.rect && textParts.length > 0 && sl.rect.width < blockW * 0.90) {
              const rectMidX = sl.rect.x + sl.rect.width / 2;
              const minTX = Math.min(...textParts.map((t) => t.x));
              const maxTX = Math.max(...textParts.map((t) => t.x + t.width));
              const textMidX = (minTX + maxTX) / 2;
              if (Math.abs(textMidX - rectMidX) <= ptToIn(8) && maxTX - minTX < sl.rect.width * 0.82) {
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
          const emptyStyle = this.buildTableCellStyle(undefined, undefined, rowAppliesTableGrid, false);
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

        const rowHeightPt = estimateWrappedRowHeightPt(rowHeightInputs, 13.5);
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
      bandKind: 'Detail',
      archetype: 'A',
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

  private compileFootnoteTablix(
    tablixName: string,
    block: LogicalSegmentBlock,
    relItems: PositionedItem[],
    topIn: number,
    dataSetName: string,
    nextUniqueName: (prefix: string) => string
  ): TablixRegion {
    const blockW = roundIn(Math.max(1.0, block.widthIn));
    const markerColW = roundIn(cmToIn(0.85));
    const contentColW = roundIn(Math.max(0.5, blockW - markerColW));
    const columnWidthsIn = [markerColW, contentColW];

    const textItems = relItems
      .filter((i) => i.kind === 'text' && (i.region.text ?? '').trim().length > 0)
      .sort((a, b) => a.y - b.y || a.x - b.x);

    const rawFootnoteRows = this.clusterItemsIntoRows(textItems, []);
    const mergedFootnoteRows: Array<{ marker: string; text: string; isTitle: boolean; style: RegionStyle; lastBottom: number; lastX: number; lastRight: number }> = [];

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
        rb.yTop - prev.lastBottom <= ptToIn(fsPt * 0.95)
      ) {
        prev.text = `${prev.text} ${lineText}`.replace(/\s+/g, ' ').trim();
        prev.lastBottom = rb.yBottom;
        prev.lastRight = Math.max(prev.lastRight, lastItem.x + lastItem.width);
        continue;
      }

      const baseStyle = defaultTextStyle(isTitle ? 8.5 : 8.0);
      baseStyle.bold = isTitle;
      baseStyle.paddingPt = { top: 1.5, right: 2, bottom: 1.5, left: 2 };
      mergedFootnoteRows.push({
        marker: markerMatch ? markerMatch[1] : '',
        text: markerMatch ? markerMatch[2] : lineText,
        isTitle,
        style: baseStyle,
        lastBottom: rb.yBottom,
        lastX: firstItem.x,
        lastRight: lastItem.x + lastItem.width,
      });
    }

    const rows: TablixRow[] = [];
    for (const fnRow of mergedFootnoteRows) {
      const markerText = fnRow.marker;
      const bodyText = fnRow.text;
      const baseStyle = fnRow.style;
      const outIdx = rows.length;
      if (fnRow.isTitle) {
        const hPt = estimateWrappedRowHeightPt(
          [{ text: bodyText, style: baseStyle, coveredWidthPt: inToPt(blockW) }],
          13
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
          12.5
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
      bandKind: 'Notes',
      archetype: 'A',
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
    nextUniqueName: (prefix: string) => string
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
    rectItems: PositionedItem[]
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
        // Distinct Y baselines (dy > min(3.5pt, fontSize * 0.45)) MUST stay on separate rows
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
    blockW: number
  ): LogicalRowBucket[] {
    if (rows.length <= 1) return rows;

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
            Math.abs(it.x - baseX) <= ptToIn(4) &&
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
            Math.abs(it.x - baseX) <= ptToIn(4) &&
            isAllBold(it) === boldFlag
          ) {
            localMax = Math.max(localMax, it.x + it.width);
          }
        }
      }
      return localMax > 0 ? localMax : Math.max(blockW * 0.72, baseX + ptToIn(60));
    };

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
            dyBaseline <= ptToIn(targetFs * 1.65) &&
            dyGap <= ptToIn(targetFs * 0.95);

          const isCenteredPair =
            targetItem.region.style.textAlign === 'Center' &&
            curItem.region.style.textAlign === 'Center' &&
            Math.abs(
              lastState.lastLineX +
                (lastState.lastLineRight - lastState.lastLineX) / 2 -
                (curItem.x + curItem.width / 2)
            ) <= ptToIn(10);

          // Strict left-edge match |Δx0| <= 4pt
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

  private mergeCellBucketItems(cellItems: PositionedItem[]): PositionedItem {
    const sorted = [...cellItems].sort((a, b) => a.y - b.y || a.x - b.x);
    if (sorted.length === 1) return sorted[0];
    const imageItem = sorted.find((i) => i.kind === 'image');
    if (imageItem && sorted.every((i) => i.kind === 'image')) return imageItem;

    const textParts = sorted.filter((i) => i.kind === 'text');
    if (textParts.length === 0) return sorted[0];
    if (textParts.length === 1) return textParts[0];

    let mergedText = '';
    const mergedRuns: VisualTextRun[] = [];
    for (let idx = 0; idx < textParts.length; idx++) {
      const tp = textParts[idx];
      const part = (tp.region.text ?? '').trim();
      if (!part) continue;
      let sep = '';
      if (mergedText.length > 0) {
        const prev = textParts[idx - 1];
        const dyBase = tp.y - prev.y;
        const fs = Math.max(6.5, prev.region.style.fontSizePt || 8.5);
        const sameLine = Math.abs(dyBase) <= ptToIn(3.5);
        const isWrapCont =
          !sameLine &&
          dyBase > 0 &&
          dyBase <= ptToIn(fs * 1.65) &&
          !/[:.?!]$/.test((prev.region.text ?? '').trim());
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
    blockW: number,
    contentSpanY: number
  ): { atomicColBoundaries: number[]; logicalRows: LogicalRowBucket[] } | null {
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

    const expanded = this.expandMultilineItems(contentItems);
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
          const subRows = this.clusterItemsIntoRows(inside, tableRects);
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

      const byCol = new Map<number, PositionedItem[]>();
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
        .map(([, list]) => this.mergeCellBucketItems(list));
      const midY = (yA + yB) / 2;
      const rowRects = tableRects.filter(
        (rc) => midY >= rc.y - ptToIn(2) && midY <= rc.y + rc.height + ptToIn(2)
      );
      const isHdr =
        iIdx === 0 &&
        (mergedCells.every((it) => it.region.style.bold) ||
          rowRects.some((rc) => Boolean(rc.region.style.backgroundColor)));

      logicalRows.push({
        yTop: yA,
        yBottom: yB,
        items: mergedCells,
        rects: rowRects,
        isHeaderRow: isHdr,
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
    contentSpanY: number
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
          .map(([, list]) => this.mergeCellBucketItems(list));
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
    blockW: number
  ): number[] {
    const tolIn = ptToIn(4); // Cluster column X edges within <= 4pt
    const rawEdges: number[] = [0, blockW];

    // Add edges from structural cell rects (excluding full-width outer background rects)
    for (const rc of rectItems) {
      if (rc.width < blockW * 0.94 && rc.height <= ptToIn(120)) {
        rawEdges.push(clamp(rc.x, 0, blockW));
        rawEdges.push(clamp(rc.x + rc.width, 0, blockW));
      }
    }

    // Add edges from vertical vector separator lines
    for (const ln of lineItems) {
      if (ln.width <= ptToIn(3) && ln.height >= ptToIn(8)) {
        rawEdges.push(clamp(ln.x, 0, blockW));
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

  private mapItemToAtomicSpan(
    item: PositionedItem,
    boundaries: number[],
    numCols: number,
    rowItems: PositionedItem[],
    isDataTable: boolean,
    rowRects: PositionedItem[]
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
    isHeaderRow: boolean
  ): RegionStyle {
    const base: RegionStyle = {
      fontFamily: textStyle?.fontFamily ?? 'Arial',
      fontSizePt: textStyle?.fontSizePt ?? 8.5,
      bold: textStyle?.bold ?? isHeaderRow,
      italic: textStyle?.italic ?? false,
      underline: textStyle?.underline,
      color: textStyle?.color ?? '#0F172A',
      backgroundColor: rectStyle?.backgroundColor ?? textStyle?.backgroundColor,
      borderColor: applyGridBorder ? '#D0D7DE' : rectStyle?.borderColor,
      borderWidthPt: applyGridBorder ? 0.5 : rectStyle?.borderWidthPt,
      textAlign: textStyle?.textAlign ?? (isHeaderRow ? 'Center' : 'Left'),
      verticalAlign: isHeaderRow ? 'Middle' : 'Top',
      paddingPt: { top: 2, right: 3, bottom: 2, left: 3 },
    };
    return base;
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
