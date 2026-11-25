import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import zlib from 'zlib';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
} from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  BandKind,
  CompilerWeights,
  DEFAULT_COMPILER_WEIGHTS,
  ExtractedVectorPrimitive,
  IntermediateLayoutModel,
  LayoutPage,
  LayoutRegion,
  RegionStyle,
  ReportGenError,
  ReportGenErrorCode,
  StructuredLogger,
  VectorPrimitiveKind,
  VisualTextRun,
} from '../core/types.ts';

const execFileAsync = promisify(execFile);

interface PdfTextItem {
  str: string;
  dir?: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL?: boolean;
}

interface RawVectorRect {
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor?: string;
  fillColor?: string;
  lineWidthPt: number;
}

interface TextColorEvent {
  x: number;
  y: number;
  color: string;
}

interface NormalizedSpan {
  text: string;
  x: number;
  y: number;
  baselineY: number;
  width: number;
  height: number;
  fontSizePt: number;
  fontName: string;
  fontLoadedName?: string;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  brokenGlyph: boolean;
}

interface MergedTextLine {
  text: string;
  runs: VisualTextRun[];
  x: number;
  y: number;
  width: number;
  height: number;
  fontSizePt: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
}

const PT_PER_INCH = 72;

function roundIn(val: number): number {
  return Math.round(val * 1000) / 1000;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n <= 1 ? n * 255 : n)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgb255ToHex(r: number, g: number, b: number): string {
  const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const toHex = (n: number) => clamp255(n).toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function normalizeColorArgs(args: unknown[]): string | undefined {
  if (args.length === 0) return undefined;
  const a0 = args[0];
  if (typeof a0 === 'string') {
    const trimmed = a0.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
    if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
      const h = trimmed.slice(1);
      return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toUpperCase();
    }
    if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) return trimmed.slice(0, 7).toUpperCase();
  }
  if (
    a0 &&
    typeof a0 === 'object' &&
    'length' in a0 &&
    typeof (a0 as ArrayLike<number>).length === 'number' &&
    (a0 as ArrayLike<number>).length >= 3
  ) {
    const arr = a0 as ArrayLike<number>;
    const r = Number(arr[0]);
    const g = Number(arr[1]);
    const b = Number(arr[2]);
    if (arr instanceof Uint8ClampedArray || arr instanceof Uint8Array || r > 1 || g > 1 || b > 1) {
      return rgb255ToHex(r, g, b);
    }
    return rgbToHex(r, g, b);
  }
  if (args.length >= 3 && typeof args[0] === 'number') {
    const r = Number(args[0]);
    const g = Number(args[1]);
    const b = Number(args[2]);
    if (r > 1 || g > 1 || b > 1) {
      return rgb255ToHex(r, g, b);
    }
    return rgbToHex(r, g, b);
  }
  return undefined;
}

function grayToHex(gray: number): string {
  const v = Math.max(0, Math.min(1, gray));
  return rgbToHex(v, v, v);
}

function cmykToHex(c: number, m: number, y: number, k: number): string {
  const r = (1 - Math.min(1, Math.max(0, c))) * (1 - Math.min(1, Math.max(0, k)));
  const g = (1 - Math.min(1, Math.max(0, m))) * (1 - Math.min(1, Math.max(0, k)));
  const b = (1 - Math.min(1, Math.max(0, y))) * (1 - Math.min(1, Math.max(0, k)));
  return rgbToHex(r, g, b);
}

function defaultStyle(): RegionStyle {
  return {
    fontFamily: 'Arial',
    fontSizePt: 10,
    bold: false,
    italic: false,
    color: '#0F172A',
    textAlign: 'Left',
    verticalAlign: 'Top',
    paddingPt: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

function inferFontFlags(fontName: string, loadedFontName?: string): {
  family: string;
  bold: boolean;
  italic: boolean;
} {
  const combined = `${fontName} ${loadedFontName ?? ''}`.toLowerCase();
  const bold =
    combined.includes('bold') ||
    combined.includes('bd') ||
    combined.includes('black') ||
    combined.includes('semibold') ||
    combined.includes('demi') ||
    combined.includes('heavy') ||
    /(?:^|[-_+])(700|800|900)/.test(combined);
  const italic = combined.includes('italic') || combined.includes('oblique');
  const isExplicitSans =
    combined.includes('sans-serif') ||
    combined.includes('sans') ||
    combined.includes('helvetica') ||
    combined.includes('arial') ||
    combined.includes('calibri') ||
    combined.includes('segoe') ||
    combined.includes('montserrat') ||
    combined.includes('roboto') ||
    combined.includes('inter');

  let family = 'Arial';
  if (combined.includes('courier') || combined.includes('mono') || combined.includes('consolas')) {
    family = 'Courier New';
  } else if (
    !isExplicitSans &&
    (combined.includes('times') ||
      combined.includes('garamond') ||
      combined.includes('georgia') ||
      combined.includes('cambria') ||
      /(?:^|[^a-z])serif(?:$|[^a-z])/.test(combined))
  ) {
    family = 'Times New Roman';
  } else if (combined.includes('segoe')) {
    family = 'Segoe UI';
  } else if (combined.includes('calibri')) {
    family = 'Calibri';
  }
  return { family, bold, italic };
}

const TOP_HEADER_FRACTION = 0.13;
const BOTTOM_FOOTER_FRACTION = 0.11;
const GENERIC_PAGE_COUNTER_RE =
  /^(?:(?:.*?\s)?\b\d+\s*(?:\/|of|dari|from|sur|von)\s*\d+\b.*|(?:page|hal\.?|halaman|p\.?|pg\.?|seite)\s*\d+(?:\s*(?:\/|of|dari|from|sur|von)\s*\d+)?|\d{1,3})$/i;

function normalizeChromeSignature(text: string): string {
  return text
    .trim()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeLigatures(str: string): string {
  if (!str) return str;
  return str
    .replace(/\uFB00/g, 'ff')
    .replace(/\uFB01/g, 'fi')
    .replace(/\uFB02/g, 'fl')
    .replace(/\uFB03/g, 'ffi')
    .replace(/\uFB04/g, 'ffl')
    .replace(/\uFB05/g, 'st')
    .replace(/\uFB06/g, 'st');
}

function hasBrokenGlyphs(str: string): boolean {
  if (!str) return false;
  if (/[\uFFFD\uE000-\uF8FF\u0234\u0235\u025D\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(str)) {
    return true;
  }
  if (/\(cid:\d+\)/i.test(str)) {
    return true;
  }
  return false;
}

function isPdfDelimiter(byte: number): boolean {
  return (
    byte === 0x20 || // space
    byte === 0x0a || // LF
    byte === 0x0d || // CR
    byte === 0x09 || // TAB
    byte === 0x0c || // FF
    byte === 0x00 || // NUL
    byte === 0x28 || // (
    byte === 0x29 || // )
    byte === 0x3c || // <
    byte === 0x3e || // >
    byte === 0x5b || // [
    byte === 0x5d || // ]
    byte === 0x7b || // {
    byte === 0x7d || // }
    byte === 0x2f || // /
    byte === 0x25 // %
  );
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;
}

const TEXT_ONLY_OPS = new Set([
  'Tf',
  'Tm',
  'Td',
  'TD',
  'T*',
  'Tc',
  'Tw',
  'Tz',
  'TL',
  'Tr',
  'Ts',
  'Tj',
  'TJ',
  "'",
  '"',
]);

/**
 * Deterministic byte-level PDF content stream lexer that strips all text-positioning
 * and text-showing operators inside BT ... ET blocks while preserving color,
 * ExtGState, and graphics-state operators (rg, RG, k, K, g, G, cs, sc, gs, etc.)
 * that subsequent shapes or table backgrounds may inherit.
 */
export function stripBtEtFromContentStream(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  const len = bytes.length;
  let i = 0;
  let inTextObject = false;
  let pendingOperands: Uint8Array[] = [];

  const pushBytes = (chunk: Uint8Array) => {
    for (let k = 0; k < chunk.length; k++) out.push(chunk[k]);
  };

  const emitChunk = (chunk: Uint8Array) => {
    if (!inTextObject) {
      pushBytes(chunk);
    } else {
      pendingOperands.push(chunk);
    }
  };

  const readLiteralString = (): Uint8Array => {
    const start = i;
    let depth = 1;
    i++;
    while (i < len && depth > 0) {
      const c = bytes[i];
      if (c === 0x5c && i + 1 < len) {
        i += 2;
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29) depth--;
      i++;
    }
    return bytes.subarray(start, i);
  };

  const readAngleBracket = (): Uint8Array => {
    const start = i;
    if (i + 1 < len && bytes[i + 1] === 0x3c) {
      let dictDepth = 1;
      i += 2;
      while (i < len && dictDepth > 0) {
        if (bytes[i] === 0x28) {
          readLiteralString();
          continue;
        }
        if (bytes[i] === 0x3c && i + 1 < len && bytes[i + 1] === 0x3c) {
          dictDepth++;
          i += 2;
          continue;
        }
        if (bytes[i] === 0x3e && i + 1 < len && bytes[i + 1] === 0x3e) {
          dictDepth--;
          i += 2;
          continue;
        }
        i++;
      }
      return bytes.subarray(start, i);
    }
    i++;
    while (i < len && bytes[i] !== 0x3e) i++;
    if (i < len) i++;
    return bytes.subarray(start, i);
  };

  const readArray = (): Uint8Array => {
    const start = i;
    let arrDepth = 1;
    i++;
    while (i < len && arrDepth > 0) {
      const c = bytes[i];
      if (c === 0x28) {
        readLiteralString();
        continue;
      }
      if (c === 0x3c) {
        readAngleBracket();
        continue;
      }
      if (c === 0x5b) arrDepth++;
      else if (c === 0x5d) arrDepth--;
      i++;
    }
    return bytes.subarray(start, i);
  };

  while (i < len) {
    const b = bytes[i];

    // Whitespace
    if (isWhitespace(b)) {
      if (!inTextObject) out.push(b);
      i++;
      continue;
    }

    // Comment %...\n
    if (b === 0x25) {
      const start = i;
      while (i < len && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      if (!inTextObject) pushBytes(bytes.subarray(start, i));
      continue;
    }

    // Literal string (...)
    if (b === 0x28) {
      emitChunk(readLiteralString());
      continue;
    }

    // Dictionary <<...>> or hex string <...>
    if (b === 0x3c) {
      emitChunk(readAngleBracket());
      continue;
    }

    // Array [...]
    if (b === 0x5b) {
      emitChunk(readArray());
      continue;
    }

    // Name /...
    if (b === 0x2f) {
      const start = i;
      i++;
      while (i < len && !isPdfDelimiter(bytes[i])) i++;
      emitChunk(bytes.subarray(start, i));
      continue;
    }

    // Single-char delimiter operators (like ' or ") or unexpected delimiters
    if (isPdfDelimiter(b)) {
      if (inTextObject && (b === 0x27 || b === 0x22)) {
        pendingOperands = [];
        i++;
        continue;
      }
      if (!inTextObject) out.push(b);
      i++;
      continue;
    }

    // Collect regular token (number, boolean, keyword/operator)
    const start = i;
    while (i < len && !isPdfDelimiter(bytes[i])) i++;
    const chunk = bytes.subarray(start, i);
    const token = Buffer.from(chunk).toString('latin1');

    // Inline image BI ... ID ... EI when outside text objects
    if (!inTextObject && token === 'BI') {
      pushBytes(chunk);
      while (i < len) {
        if (
          bytes[i] === 0x49 &&
          bytes[i + 1] === 0x44 &&
          (i === 0 || isWhitespace(bytes[i - 1])) &&
          i + 2 < len &&
          isWhitespace(bytes[i + 2])
        ) {
          out.push(0x49, 0x44, bytes[i + 2]);
          i += 3;
          while (i < len) {
            if (
              i + 2 < len &&
              isWhitespace(bytes[i]) &&
              bytes[i + 1] === 0x45 &&
              bytes[i + 2] === 0x49 &&
              (i + 3 >= len || isPdfDelimiter(bytes[i + 3]))
            ) {
              out.push(bytes[i], 0x45, 0x49);
              i += 3;
              break;
            }
            out.push(bytes[i]);
            i++;
          }
          break;
        }
        out.push(bytes[i]);
        i++;
      }
      continue;
    }

    if (token === 'BT') {
      inTextObject = true;
      pendingOperands = [];
      out.push(0x20);
      continue;
    }

    if (token === 'ET') {
      inTextObject = false;
      pendingOperands = [];
      out.push(0x20);
      continue;
    }

    if (!inTextObject) {
      pushBytes(chunk);
      continue;
    }

    // Inside BT ... ET: classify numbers/booleans/null as operands; operators flush or drop
    const isOperand =
      token === 'true' ||
      token === 'false' ||
      token === 'null' ||
      /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token);

    if (isOperand) {
      pendingOperands.push(chunk);
    } else if (TEXT_ONLY_OPS.has(token)) {
      pendingOperands = [];
    } else {
      for (const op of pendingOperands) {
        pushBytes(op);
        out.push(0x20);
      }
      pushBytes(chunk);
      out.push(0x20);
      pendingOperands = [];
    }
  }

  return Uint8Array.from(out);
}

export class PdfAnalyzer {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public async stripTextOperatorsFromPdf(pdfBytes: Uint8Array): Promise<Uint8Array> {
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const visitedRefs = new Set<string>();

    const rewriteRawStream = (raw: PDFRawStream) => {
      try {
        const decoded = decodePDFRawStream(raw).decode();
        const stripped = stripBtEtFromContentStream(decoded);
        const compressed = zlib.deflateSync(Buffer.from(stripped));
        const mut = raw as unknown as { contents: Uint8Array; dict: PDFDict };
        mut.contents = new Uint8Array(compressed);
        mut.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
        mut.dict.delete(PDFName.of('DecodeParms'));
        mut.dict.set(PDFName.of('Length'), doc.context.obj(compressed.length));
      } catch {
        // Leave undecodable custom-filter streams untouched so Ghostscript does not fail
      }
    };

    const processXObjects = (resources: PDFDict | undefined) => {
      if (!resources) return;
      const xObjEntry = resources.lookup(PDFName.of('XObject'));
      if (!(xObjEntry instanceof PDFDict)) return;
      for (const [, val] of xObjEntry.entries()) {
        const refKey = val instanceof PDFRef ? val.toString() : undefined;
        if (refKey) {
          if (visitedRefs.has(refKey)) continue;
          visitedRefs.add(refKey);
        }
        const resolved = doc.context.lookup(val);
        if (resolved instanceof PDFRawStream) {
          const subtype = resolved.dict.get(PDFName.of('Subtype'));
          if (subtype === PDFName.of('Form')) {
            rewriteRawStream(resolved);
            const nestedRes = resolved.dict.lookup(PDFName.of('Resources'));
            if (nestedRes instanceof PDFDict) {
              processXObjects(nestedRes);
            }
          }
        }
      }
    };

    for (const page of doc.getPages()) {
      const contentsVal = page.node.get(PDFName.of('Contents'));
      const processContentObj = (obj: unknown) => {
        if (obj instanceof PDFRef) {
          const key = obj.toString();
          if (visitedRefs.has(key)) return;
          visitedRefs.add(key);
          const resolved = doc.context.lookup(obj);
          processContentObj(resolved);
          return;
        }
        if (obj instanceof PDFRawStream) {
          rewriteRawStream(obj);
          return;
        }
        if (obj instanceof PDFArray) {
          for (let i = 0; i < obj.size(); i++) {
            processContentObj(obj.get(i));
          }
        }
      };

      processContentObj(contentsVal);
      const pageResources = page.node.lookup(PDFName.of('Resources'));
      if (pageResources instanceof PDFDict) {
        processXObjects(pageResources);
      }
    }

    return doc.save({ useObjectStreams: false });
  }

  public async analyzeBuffer(
    pdfBytes: Uint8Array,
    documentName: string,
    dpi = 150,
    weightsOverride?: Partial<CompilerWeights>
  ): Promise<IntermediateLayoutModel> {
    const weights: CompilerWeights = { ...DEFAULT_COMPILER_WEIGHTS, ...(weightsOverride ?? {}) };
    this.logger.info('PdfAnalysis', `PDF analysis started for "${documentName}"`, { dpi });
    try {
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBytes),
        useSystemFonts: true,
        verbosity: 0,
      });
      const pdfDoc = await loadingTask.promise;
      const numPages = pdfDoc.numPages;

      if (numPages === 0) {
        throw new Error('PDF contains 0 pages');
      }

      // Layer 1: Extract native vector text & geometry first; never run OCR on digital PDFs
      let lazy300DpiPreviews: Buffer[] | null = null;
      const get300DpiPreviews = async (): Promise<Buffer[]> => {
        if (lazy300DpiPreviews === null) {
          lazy300DpiPreviews = await this.rasterizePagesWithGhostscript(pdfBytes, 300);
        }
        return lazy300DpiPreviews;
      };

      let lazyPagePreviews: Buffer[] | null = null;
      const getPagePreviews = async (): Promise<Buffer[]> => {
        if (lazyPagePreviews === null) {
          lazyPagePreviews =
            dpi === 300
              ? await get300DpiPreviews()
              : await this.rasterizePagesWithGhostscript(pdfBytes, dpi);
        }
        return lazyPagePreviews;
      };

      let lazyStrippedPreviews: Buffer[] | null = null;
      const getTextStrippedPagePng = async (pageIdxZeroBased: number): Promise<Buffer | undefined> => {
        if (lazyStrippedPreviews === null) {
          try {
            const strippedBytes = await this.stripTextOperatorsFromPdf(pdfBytes);
            lazyStrippedPreviews = await this.rasterizePagesWithGhostscript(strippedBytes, dpi);
          } catch (stripErr) {
            this.logger.warn(
              'PdfAnalysis',
              `Text-stripped crop fallback triggered: ${stripErr instanceof Error ? stripErr.message : String(stripErr)}`
            );
            lazyStrippedPreviews = [];
          }
        }
        if (lazyStrippedPreviews.length === numPages) {
          return lazyStrippedPreviews[pageIdxZeroBased];
        }
        const previews = await getPagePreviews();
        return previews[pageIdxZeroBased];
      };

      interface RawPageExtract {
        pageNumber: number;
        widthIn: number;
        heightIn: number;
        viewportHeightPt: number;
        rawObjectCount: number;
        isDigitalVectorPage: boolean;
        vectorRects: RawVectorRect[];
        vectorPrimitives: ExtractedVectorPrimitive[];
        imageBoxes: Array<{ x: number; y: number; width: number; height: number }>;
        complexClusterBoxes: Array<{ x: number; y: number; width: number; height: number; fallbackRect?: RawVectorRect }>;
        mergedLines: MergedTextLine[];
        brokenGlyphSpans: NormalizedSpan[];
        deduplicatedSpans: number;
      }

      const rawPages: RawPageExtract[] = [];
      let anyPageDigitalVector = false;

      // Pass 1: Extract pure native vector text and geometry per page (never rasterize/OCR digital vector pages)
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.0 });
        const widthIn = roundIn(viewport.width / PT_PER_INCH);
        const heightIn = roundIn(viewport.height / PT_PER_INCH);

        const textContent = await page.getTextContent();
        const opList = await page.getOperatorList();

        const rawItems = (textContent.items as PdfTextItem[]).filter(
          (item) => typeof item.str === 'string' && item.str.trim().length > 0
        );
        const isDigitalVectorPage = rawItems.length > 0;
        if (isDigitalVectorPage) {
          anyPageDigitalVector = true;
        } else {
          this.logger.warn('PdfAnalysis', `Page ${pageNum} has 0 vector text items; raster fallback active.`);
        }

        const { vectorRects, imageBoxes, complexClusterBoxes, textColorEvents } =
          this.extractVectorsAndImages(opList, viewport.height, widthIn, heightIn);

        const enrichedStyles: Record<string, { fontFamily?: string }> = {
          ...(textContent.styles ?? {}),
        };
        for (const item of rawItems) {
          if (!item.fontName) continue;
          try {
            if (page.commonObjs.has(item.fontName)) {
              const fontObj = page.commonObjs.get(item.fontName) as { name?: string } | undefined;
              if (fontObj?.name) {
                const prevFamily = enrichedStyles[item.fontName]?.fontFamily ?? '';
                enrichedStyles[item.fontName] = {
                  fontFamily: `${fontObj.name} ${prevFamily}`.trim(),
                };
              }
            }
          } catch {
            // Ignore unresolved pdfjs commonObjs font entries
          }
        }

        const rawSpanBoxesIn = rawItems.map((it) => {
          const tx = it.transform;
          const fontSizePt = Math.max(5.5, Math.hypot(tx[0], tx[1]) || Math.hypot(tx[2], tx[3]) || 10);
          const xPt = tx[4];
          const yTopPt = viewport.height - tx[5] - fontSizePt * 0.85;
          const wPt = Math.max(it.width || it.str.length * fontSizePt * weights.charWidthFactor, 4);
          const hPt = Math.max(it.height || fontSizePt * 1.2, fontSizePt * 1.15);
          return {
            x: xPt / PT_PER_INCH,
            y: Math.max(0, yTopPt / PT_PER_INCH),
            width: wPt / PT_PER_INCH,
            height: hPt / PT_PER_INCH,
          };
        });

        // 300 DPI Text-Masked 1D RLE Morphological Primitive Detection before horizontal text merging
        const hiResPages = await get300DpiPreviews();
        const hiResPng = hiResPages[pageNum - 1];
        const {
          primitives: vectorPrimitives,
          augmentedRects,
        } = await this.detectAndMergePrimitives(
          pageNum,
          hiResPng,
          rawSpanBoxesIn,
          widthIn,
          heightIn,
          vectorRects,
          weights
        );

        const {
          mergedLines,
          brokenGlyphSpans,
          deduplicatedSpans,
        } = this.extractNormalizedTextLines(
          rawItems,
          viewport.height,
          enrichedStyles,
          textColorEvents,
          augmentedRects,
          weights
        );

        rawPages.push({
          pageNumber: pageNum,
          widthIn,
          heightIn,
          viewportHeightPt: viewport.height,
          rawObjectCount: rawItems.length + augmentedRects.length + imageBoxes.length,
          isDigitalVectorPage,
          vectorRects: augmentedRects,
          vectorPrimitives,
          imageBoxes,
          complexClusterBoxes,
          mergedLines,
          brokenGlyphSpans,
          deduplicatedSpans,
        });
      }

      // Pass 2: Automatic Running Header & Footer Detection (Cross-Page Repetition + Generic Page-Counter Patterns)
      const posTolXIn = 6 / PT_PER_INCH;
      const posTolYIn = 4 / PT_PER_INCH;
      const minRepeatPages = Math.max(2, Math.ceil(numPages * 0.5));

      const isTopMarginZone = (yIn: number, hIn: number, pageHIn: number): boolean =>
        yIn < pageHIn * TOP_HEADER_FRACTION && yIn + hIn * 0.5 < pageHIn * TOP_HEADER_FRACTION;

      const isBottomMarginZone = (yIn: number, hIn: number, pageHIn: number): boolean =>
        yIn >= pageHIn * (1 - BOTTOM_FOOTER_FRACTION) ||
        (yIn >= pageHIn * (1 - BOTTOM_FOOTER_FRACTION - 0.03) && yIn + hIn > pageHIn * (1 - BOTTOM_FOOTER_FRACTION));

      const countBoxRepeatsAcrossPages = (
        x: number,
        y: number,
        w: number,
        h: number,
        zone: 'top' | 'bottom'
      ): number => {
        let count = 0;
        for (const p of rawPages) {
          const inZone = (bx: number, by: number, bw: number, bh: number) =>
            zone === 'top' ? isTopMarginZone(by, bh, p.heightIn) : isBottomMarginZone(by, bh, p.heightIn);
          const matched =
            p.vectorRects.some(
              (vr) =>
                inZone(vr.x, vr.y, vr.width, vr.height) &&
                Math.abs(vr.x - x) <= posTolXIn &&
                Math.abs(vr.y - y) <= posTolYIn &&
                Math.abs(vr.width - w) <= 0.12 &&
                Math.abs(vr.height - h) <= 0.12
            ) ||
            p.imageBoxes.some(
              (ib) =>
                inZone(ib.x, ib.y, ib.width, ib.height) &&
                Math.abs(ib.x - x) <= posTolXIn &&
                Math.abs(ib.y - y) <= posTolYIn
            ) ||
            p.complexClusterBoxes.some(
              (cb) =>
                inZone(cb.x, cb.y, cb.width, cb.height) &&
                Math.abs(cb.x - x) <= posTolXIn &&
                Math.abs(cb.y - y) <= posTolYIn
            );
          if (matched) count++;
        }
        return count;
      };

      const countTextRepeatsAcrossPages = (
        line: MergedTextLine,
        zone: 'top' | 'bottom'
      ): number => {
        const sig = normalizeChromeSignature(line.text);
        let count = 0;
        for (const p of rawPages) {
          const matched = p.mergedLines.some((ol) => {
            const inZone =
              zone === 'top'
                ? isTopMarginZone(ol.y, ol.height, p.heightIn)
                : isBottomMarginZone(ol.y, ol.height, p.heightIn);
            if (!inZone) return false;
            return (
              normalizeChromeSignature(ol.text) === sig &&
              Math.abs(ol.y - line.y) <= posTolYIn &&
              (Math.abs(ol.x - line.x) <= posTolXIn * 2.5 ||
                Math.abs(ol.x + ol.width - (line.x + line.width)) <= posTolXIn * 2.5)
            );
          });
          if (matched) count++;
        }
        return count;
      };

      let detectedHeaderBottomIn = 0;
      let detectedFooterTopIn = Infinity;

      if (numPages >= 2) {
        for (const p of rawPages) {
          for (const ln of p.mergedLines) {
            if (isTopMarginZone(ln.y, ln.height, p.heightIn) && countTextRepeatsAcrossPages(ln, 'top') >= minRepeatPages) {
              detectedHeaderBottomIn = Math.max(detectedHeaderBottomIn, ln.y + ln.height);
            }
            if (
              isBottomMarginZone(ln.y, ln.height, p.heightIn) &&
              (GENERIC_PAGE_COUNTER_RE.test(ln.text.trim()) ||
                countTextRepeatsAcrossPages(ln, 'bottom') >= minRepeatPages)
            ) {
              detectedFooterTopIn = Math.min(detectedFooterTopIn, ln.y);
            }
          }
          for (const vr of p.vectorRects) {
            if (
              isTopMarginZone(vr.y, vr.height, p.heightIn) &&
              countBoxRepeatsAcrossPages(vr.x, vr.y, vr.width, vr.height, 'top') >= minRepeatPages
            ) {
              detectedHeaderBottomIn = Math.max(detectedHeaderBottomIn, vr.y + vr.height);
            }
            if (
              isBottomMarginZone(vr.y, vr.height, p.heightIn) &&
              countBoxRepeatsAcrossPages(vr.x, vr.y, vr.width, vr.height, 'bottom') >= minRepeatPages
            ) {
              detectedFooterTopIn = Math.min(detectedFooterTopIn, vr.y);
            }
          }
          for (const ib of p.imageBoxes) {
            if (
              isTopMarginZone(ib.y, ib.height, p.heightIn) &&
              countBoxRepeatsAcrossPages(ib.x, ib.y, ib.width, ib.height, 'top') >= minRepeatPages
            ) {
              detectedHeaderBottomIn = Math.max(detectedHeaderBottomIn, ib.y + ib.height);
            }
            if (
              isBottomMarginZone(ib.y, ib.height, p.heightIn) &&
              countBoxRepeatsAcrossPages(ib.x, ib.y, ib.width, ib.height, 'bottom') >= minRepeatPages
            ) {
              detectedFooterTopIn = Math.min(detectedFooterTopIn, ib.y);
            }
          }
          for (const cb of p.complexClusterBoxes) {
            if (
              isTopMarginZone(cb.y, cb.height, p.heightIn) &&
              countBoxRepeatsAcrossPages(cb.x, cb.y, cb.width, cb.height, 'top') >= minRepeatPages
            ) {
              detectedHeaderBottomIn = Math.max(detectedHeaderBottomIn, cb.y + cb.height);
            }
          }
        }
      } else {
        // Single-page PDF: detect bottom page counter or a compact left-side top logo strip separated above body
        const p1Raw = rawPages[0];
        for (const ln of p1Raw.mergedLines) {
          if (isBottomMarginZone(ln.y, ln.height, p1Raw.heightIn) && GENERIC_PAGE_COUNTER_RE.test(ln.text.trim())) {
            detectedFooterTopIn = Math.min(detectedFooterTopIn, ln.y);
          }
        }
        const topLeftGraphics = [
          ...p1Raw.imageBoxes.filter(
            (b) => isTopMarginZone(b.y, b.height, p1Raw.heightIn) && b.x < p1Raw.widthIn * 0.45 && b.width < p1Raw.widthIn * 0.45
          ),
          ...p1Raw.complexClusterBoxes.filter(
            (b) => isTopMarginZone(b.y, b.height, p1Raw.heightIn) && b.x < p1Raw.widthIn * 0.45 && b.width < p1Raw.widthIn * 0.45
          ),
          ...p1Raw.vectorRects.filter(
            (vr) =>
              isTopMarginZone(vr.y, vr.height, p1Raw.heightIn) &&
              vr.x < p1Raw.widthIn * 0.45 &&
              vr.width < p1Raw.widthIn * 0.45 &&
              vr.height >= 0.04 &&
              Boolean(vr.fillColor && vr.fillColor.toUpperCase() !== '#FFFFFF')
          ),
        ];
        if (topLeftGraphics.length > 0) {
          detectedHeaderBottomIn = Math.max(...topLeftGraphics.map((g) => g.y + g.height));
        }
      }

      const maxAllowedHeaderBottomIn = rawPages[0].heightIn * TOP_HEADER_FRACTION;
      if (detectedHeaderBottomIn > maxAllowedHeaderBottomIn) {
        detectedHeaderBottomIn = maxAllowedHeaderBottomIn;
      }

      const classifyBandForBox = (
        xIn: number,
        yIn: number,
        wIn: number,
        hIn: number,
        pageHIn: number,
        text?: string
      ): BandKind => {
        if (
          detectedHeaderBottomIn > 0 &&
          yIn < maxAllowedHeaderBottomIn &&
          yIn + hIn <= detectedHeaderBottomIn + 6 / PT_PER_INCH
        ) {
          return 'Header';
        }
        if (
          isBottomMarginZone(yIn, hIn, pageHIn) &&
          ((text && GENERIC_PAGE_COUNTER_RE.test(text.trim())) || yIn >= detectedFooterTopIn - 4 / PT_PER_INCH)
        ) {
          return 'Footer';
        }
        void xIn;
        void wIn;
        return 'Detail';
      };

      // Pass 3: Dynamic HeaderLogo Bounding-Box Crop inside the first page's detected <PageHeader> band
      let headerLogoBoxIn: { x: number; y: number; width: number; height: number } | null = null;
      let headerLogoBase64: string | undefined;
      let logoTemplateIdx = 0;

      if (detectedHeaderBottomIn > 0) {
        for (let pageIdx = 0; pageIdx < rawPages.length; pageIdx++) {
          const candBundle = rawPages[pageIdx];
          const leftZoneLimitIn = candBundle.widthIn * 0.45;
          const logoCandidateBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];

          for (const ib of candBundle.imageBoxes) {
            if (
              classifyBandForBox(ib.x, ib.y, ib.width, ib.height, candBundle.heightIn) === 'Header' &&
              ib.x < leftZoneLimitIn &&
              ib.width < leftZoneLimitIn
            ) {
              logoCandidateBoxes.push({ x: ib.x, y: ib.y, width: ib.width, height: ib.height });
            }
          }
          for (const cb of candBundle.complexClusterBoxes) {
            if (
              classifyBandForBox(cb.x, cb.y, cb.width, cb.height, candBundle.heightIn) === 'Header' &&
              cb.x < leftZoneLimitIn &&
              cb.width < leftZoneLimitIn
            ) {
              logoCandidateBoxes.push({ x: cb.x, y: cb.y, width: cb.width, height: cb.height });
            }
          }
          for (const vr of candBundle.vectorRects) {
            const isThinFullRule = vr.width >= candBundle.widthIn * 0.65 && vr.height <= 0.05;
            const isFullWidthBar = vr.width >= candBundle.widthIn * 0.65;
            if (
              !isThinFullRule &&
              !isFullWidthBar &&
              classifyBandForBox(vr.x, vr.y, vr.width, vr.height, candBundle.heightIn) === 'Header' &&
              vr.x < leftZoneLimitIn &&
              vr.width < leftZoneLimitIn &&
              (Boolean(vr.fillColor && vr.fillColor.toUpperCase() !== '#FFFFFF') || vr.height >= 0.08)
            ) {
              logoCandidateBoxes.push({ x: vr.x, y: vr.y, width: vr.width, height: vr.height });
            }
          }

          if (logoCandidateBoxes.length === 0) continue;

          let gx1 = Math.min(...logoCandidateBoxes.map((b) => b.x));
          let gy1 = Math.min(...logoCandidateBoxes.map((b) => b.y));
          let gx2 = Math.max(...logoCandidateBoxes.map((b) => b.x + b.width));
          let gy2 = Math.max(...logoCandidateBoxes.map((b) => b.y + b.height));

          // Include adjacent left-side brand wordmark text within small geometric proximity
          const maxProxXIn = 36 / PT_PER_INCH;
          const maxProxYIn = 24 / PT_PER_INCH;
          for (const ln of candBundle.mergedLines) {
            if (classifyBandForBox(ln.x, ln.y, ln.width, ln.height, candBundle.heightIn, ln.text) !== 'Header') {
              continue;
            }
            if (ln.x + ln.width > candBundle.widthIn * 0.48) continue;
            const lx1 = ln.x;
            const ly1 = ln.y;
            const lx2 = ln.x + ln.width;
            const ly2 = ln.y + ln.height;
            const gapX = Math.max(0, Math.max(lx1 - gx2, gx1 - lx2));
            const gapY = Math.max(0, Math.max(ly1 - gy2, gy1 - ly2));
            if (gapX <= maxProxXIn && gapY <= maxProxYIn) {
              gx1 = Math.min(gx1, lx1);
              gy1 = Math.min(gy1, ly1);
              gx2 = Math.max(gx2, lx2);
              gy2 = Math.max(gy2, ly2);
            }
          }

          const padPt = 2 / PT_PER_INCH;
          const x = Math.max(0, gx1 - padPt);
          const y = Math.max(0, gy1 - padPt);
          const w = Math.min(candBundle.widthIn - x, gx2 - gx1 + padPt * 2);
          const h = Math.min(candBundle.heightIn - y, gy2 - gy1 + padPt * 2);

          if (w >= 0.15 && h >= 0.1) {
            logoTemplateIdx = pageIdx;
            headerLogoBoxIn = { x, y, width: w, height: h };
            const hiResList = await get300DpiPreviews();
            const highResPng =
              hiResList[pageIdx] ??
              (await this.rasterizeSinglePageWithGhostscript(pdfBytes, pageIdx + 1, 300));
            headerLogoBase64 = await this.cropPageRegionToBase64(
              highResPng ?? (await getPagePreviews())[pageIdx],
              headerLogoBoxIn,
              candBundle.widthIn,
              candBundle.heightIn
            );
            break;
          }
        }
      }

      const isInsideHeaderLogoBox = (
        xIn: number,
        yIn: number,
        wIn: number,
        hIn: number,
        bandKind: BandKind,
        allowCompactNearBoundary = true
      ): boolean => {
        if (!headerLogoBoxIn || !headerLogoBase64) return false;
        const tol = 6 / PT_PER_INCH;
        const cx = xIn + wIn / 2;
        const cy = yIn + hIn / 2;
        const centerInside =
          cx >= headerLogoBoxIn.x - tol &&
          cx <= headerLogoBoxIn.x + headerLogoBoxIn.width + tol &&
          cy >= headerLogoBoxIn.y - tol &&
          cy <= headerLogoBoxIn.y + headerLogoBoxIn.height + tol;
        if (!centerInside) return false;
        if (bandKind === 'Header') return true;
        if (!allowCompactNearBoundary) return false;
        // Also strip stray vector/font icon glyphs overlapping the logo bounding box on slight header-band jitter
        return (
          wIn <= headerLogoBoxIn.width * 1.2 + tol * 2 &&
          hIn <= headerLogoBoxIn.height * 1.2 + tol * 2
        );
      };

      const pages: LayoutPage[] = [];
      let regionSeq = 1;

      for (const bundle of rawPages) {
        const pageNum = bundle.pageNumber;
        const widthIn = bundle.widthIn;
        const heightIn = bundle.heightIn;
        const regions: LayoutRegion[] = [];

        const pageHasHeaderLogoItems =
          Boolean(headerLogoBoxIn && headerLogoBase64) &&
          (pageNum === logoTemplateIdx + 1 ||
            bundle.imageBoxes.some((b) =>
              isInsideHeaderLogoBox(b.x, b.y, b.width, b.height, classifyBandForBox(b.x, b.y, b.width, b.height, heightIn))
            ) ||
            bundle.complexClusterBoxes.some((b) =>
              isInsideHeaderLogoBox(b.x, b.y, b.width, b.height, classifyBandForBox(b.x, b.y, b.width, b.height, heightIn))
            ) ||
            bundle.vectorRects.some((vr) =>
              isInsideHeaderLogoBox(vr.x, vr.y, vr.width, vr.height, classifyBandForBox(vr.x, vr.y, vr.width, vr.height, heightIn))
            ) ||
            bundle.mergedLines.some((ln) =>
              isInsideHeaderLogoBox(ln.x, ln.y, ln.width, ln.height, classifyBandForBox(ln.x, ln.y, ln.width, ln.height, heightIn, ln.text))
            ));

        if (pageHasHeaderLogoItems && headerLogoBoxIn && headerLogoBase64) {
          regions.push({
            id: `region-${String(regionSeq++).padStart(4, '0')}`,
            pageNumber: pageNum,
            type: 'image',
            x: roundIn(headerLogoBoxIn.x),
            y: roundIn(headerLogoBoxIn.y),
            width: roundIn(headerLogoBoxIn.width),
            height: roundIn(headerLogoBoxIn.height),
            style: defaultStyle(),
            semanticRole: 'logoOrGraphic',
            confidence: 0.99,
            bandKind: 'Header',
            isAmbiguous: false,
            preferImageFallback: true,
            imageAssetBase64: headerLogoBase64,
            imageAssetName: 'HeaderLogo',
            sourceObjectRefs: [`p${pageNum}-header-logo`],
          });
        }

        for (let idx = 0; idx < bundle.vectorRects.length; idx++) {
          const vr = bundle.vectorRects[idx];
          const bandKind = classifyBandForBox(vr.x, vr.y, vr.width, vr.height, heightIn);
          if (isInsideHeaderLogoBox(vr.x, vr.y, vr.width, vr.height, bandKind)) continue;
          const isLine = vr.height <= 0.04 || vr.width <= 0.04;
          const minDim = isLine ? 0.006 : 0.015;
          const style: RegionStyle = {
            ...defaultStyle(),
            backgroundColor: vr.fillColor,
            borderColor: vr.strokeColor,
            borderWidthPt: vr.lineWidthPt,
          };
          regions.push({
            id: `region-${String(regionSeq++).padStart(4, '0')}`,
            pageNumber: pageNum,
            type: isLine ? 'vector_line' : 'vector_rect',
            x: roundIn(vr.x),
            y: roundIn(vr.y),
            width: roundIn(Math.max(minDim, vr.width)),
            height: roundIn(Math.max(minDim, vr.height)),
            style,
            semanticRole: 'unknown',
            confidence: 0.95,
            bandKind,
            isAmbiguous: false,
            sourceObjectRefs: [`p${pageNum}-vec-${idx}`],
          });
        }

        let cachedPagePreviews: Buffer[] | null = null;
        const getLazyPagePng = async (): Promise<Buffer | undefined> => {
          if (!cachedPagePreviews) {
            cachedPagePreviews = await getPagePreviews();
          }
          return cachedPagePreviews[pageNum - 1];
        };

        for (let idx = 0; idx < bundle.imageBoxes.length; idx++) {
          const box = bundle.imageBoxes[idx];
          const bandKind = classifyBandForBox(box.x, box.y, box.width, box.height, heightIn);
          if (isInsideHeaderLogoBox(box.x, box.y, box.width, box.height, bandKind)) continue;
          const srcPng = (await getTextStrippedPagePng(pageNum - 1)) ?? (await getLazyPagePng());
          const croppedBase64 = await this.cropPageRegionToBase64(
            srcPng,
            box,
            widthIn,
            heightIn
          );
          regions.push({
            id: `region-${String(regionSeq++).padStart(4, '0')}`,
            pageNumber: pageNum,
            type: 'image',
            x: roundIn(box.x),
            y: roundIn(box.y),
            width: roundIn(box.width),
            height: roundIn(box.height),
            style: defaultStyle(),
            semanticRole: 'logoOrGraphic',
            confidence: 0.96,
            bandKind,
            isAmbiguous: false,
            preferImageFallback: true,
            imageAssetBase64: croppedBase64,
            imageAssetName: `EmbeddedGraphic_P${pageNum}_${idx + 1}`,
            sourceObjectRefs: [`p${pageNum}-img-${idx}`],
          });
        }

        let brokenGlyphRegions = 0;
        for (let idx = 0; idx < bundle.brokenGlyphSpans.length; idx++) {
          const bSpan = bundle.brokenGlyphSpans[idx];
          const bandKind = classifyBandForBox(bSpan.x, bSpan.y, bSpan.width, bSpan.height, heightIn);
          if (isInsideHeaderLogoBox(bSpan.x, bSpan.y, bSpan.width, bSpan.height, bandKind)) continue;
          const padIn = 0.008;
          const cropBox = {
            x: Math.max(0, bSpan.x - padIn),
            y: Math.max(0, bSpan.y - padIn),
            width: Math.min(widthIn - Math.max(0, bSpan.x - padIn), bSpan.width + padIn * 2),
            height: Math.min(heightIn - Math.max(0, bSpan.y - padIn), bSpan.height + padIn * 2),
          };
          const croppedBase64 = await this.cropPageRegionToBase64(
            await getLazyPagePng(),
            cropBox,
            widthIn,
            heightIn
          );
          if (!croppedBase64) continue;
          brokenGlyphRegions++;
          regions.push({
            id: `region-${String(regionSeq++).padStart(4, '0')}`,
            pageNumber: pageNum,
            type: 'image',
            x: roundIn(cropBox.x),
            y: roundIn(cropBox.y),
            width: roundIn(cropBox.width),
            height: roundIn(cropBox.height),
            style: defaultStyle(),
            semanticRole: 'logoOrGraphic',
            confidence: 0.99,
            bandKind,
            isAmbiguous: false,
            preferImageFallback: true,
            imageAssetBase64: croppedBase64,
            imageAssetName: `GlyphCrop_P${pageNum}_${brokenGlyphRegions}`,
            sourceObjectRefs: [`p${pageNum}-glyph-${brokenGlyphRegions}`],
          });
        }

        const iconClusters: Array<{ x: number; y: number; width: number; height: number; fallbackRect?: RawVectorRect }> = [];
        for (const box of bundle.complexClusterBoxes) {
          const enclosedText = bundle.mergedLines.filter(
            (ln) =>
              ln.x >= box.x - 0.08 &&
              ln.x + ln.width <= box.x + box.width + 0.08 &&
              ln.y >= box.y - 0.08 &&
              ln.y + ln.height <= box.y + box.height + 0.08
          );
          const overlapsText = bundle.mergedLines.some(
            (ln) =>
              ln.x < box.x + box.width + 0.02 &&
              ln.x + ln.width > box.x - 0.02 &&
              ln.y < box.y + box.height + 0.02 &&
              ln.y + ln.height > box.y - 0.02
          );
          const isTopCoverBanner = box.y < 1.8 && box.width > 2.0 && box.height >= 0.4;
          if (!isTopCoverBanner && ((box.width > 2.2 && enclosedText.length >= 2) || enclosedText.length >= 4)) {
            if (box.fallbackRect) {
              const fb = box.fallbackRect;
              const isLine = fb.height <= 0.04 || fb.width <= 0.04;
              regions.push({
                id: `region-${String(regionSeq++).padStart(4, '0')}`,
                pageNumber: pageNum,
                type: isLine ? 'vector_line' : 'vector_rect',
                x: roundIn(fb.x),
                y: roundIn(fb.y),
                width: roundIn(Math.max(0.015, fb.width)),
                height: roundIn(Math.max(0.015, fb.height)),
                style: {
                  ...defaultStyle(),
                  backgroundColor: fb.fillColor,
                  borderColor: fb.strokeColor,
                  borderWidthPt: fb.lineWidthPt,
                },
                semanticRole: 'unknown',
                confidence: 0.9,
                bandKind: classifyBandForBox(fb.x, fb.y, fb.width, fb.height, heightIn),
                isAmbiguous: false,
                sourceObjectRefs: [`p${pageNum}-vc-rect`],
              });
            }
            continue;
          }
          if (overlapsText && box.width < 0.45 && box.height < 0.45 && enclosedText.length === 0) {
            const strictlyInsideLine = bundle.mergedLines.some(
              (ln) =>
                box.x >= ln.x - 0.01 &&
                box.x + box.width <= ln.x + ln.width + 0.01 &&
                box.y >= ln.y - 0.01 &&
                box.y + box.height <= ln.y + ln.height + 0.01
            );
            if (strictlyInsideLine) continue;
          }
          iconClusters.push(box);
        }

        for (let idx = 0; idx < iconClusters.length; idx++) {
          const box = iconClusters[idx];
          const bandKind = classifyBandForBox(box.x, box.y, box.width, box.height, heightIn);
          if (isInsideHeaderLogoBox(box.x, box.y, box.width, box.height, bandKind)) continue;
          const srcPng = (await getTextStrippedPagePng(pageNum - 1)) ?? (await getLazyPagePng());
          const croppedBase64 = await this.cropPageRegionToBase64(
            srcPng,
            box,
            widthIn,
            heightIn
          );
          if (!croppedBase64) continue;
          regions.push({
            id: `region-${String(regionSeq++).padStart(4, '0')}`,
            pageNumber: pageNum,
            type: 'vector_complex',
            x: roundIn(box.x),
            y: roundIn(box.y),
            width: roundIn(box.width),
            height: roundIn(box.height),
            style: defaultStyle(),
            semanticRole: 'logoOrGraphic',
            confidence: 0.88,
            bandKind,
            isAmbiguous: false,
            preferImageFallback: true,
            imageAssetBase64: croppedBase64,
            imageAssetName: `VectorCluster_P${pageNum}_${idx + 1}`,
            sourceObjectRefs: [`p${pageNum}-vc-${idx}`],
          });
        }

        for (let idx = 0; idx < bundle.mergedLines.length; idx++) {
          const line = bundle.mergedLines[idx];
          const bandKind = classifyBandForBox(line.x, line.y, line.width, line.height, heightIn, line.text);
          if (isInsideHeaderLogoBox(line.x, line.y, line.width, line.height, bandKind)) continue;
          const enclosingRect = bundle.vectorRects
            .filter(
              (r) =>
                line.x >= r.x - 0.08 &&
                line.x + line.width <= r.x + r.width + 0.08 &&
                line.y >= r.y - 0.08 &&
                line.y + line.height <= r.y + r.height + 0.08 &&
                r.width > 0.15 &&
                r.height > 0.12
            )
            .sort((a, b) => a.width * a.height - b.width * b.height)[0];

          const style: RegionStyle = {
            fontFamily: line.fontFamily,
            fontSizePt: Math.round(line.fontSizePt * 10) / 10,
            bold: line.bold,
            italic: line.italic,
            underline: line.underline,
            color: line.color,
            backgroundColor: enclosingRect?.fillColor,
            borderColor: enclosingRect?.strokeColor,
            borderWidthPt: enclosingRect?.lineWidthPt,
            textAlign: 'Left',
            verticalAlign: 'Top',
            paddingPt: { top: 0, right: 0, bottom: 0, left: 0 },
          };

          regions.push({
            id: `region-${String(regionSeq++).padStart(4, '0')}`,
            pageNumber: pageNum,
            type: 'text',
            x: roundIn(line.x),
            y: roundIn(line.y),
            width: roundIn(Math.max(0.08, line.width)),
            height: roundIn(Math.max(0.08, line.height)),
            text: line.text,
            runs: line.runs,
            style,
            semanticRole: 'unknown',
            confidence: 0.92,
            bandKind,
            isAmbiguous: false,
            sourceObjectRefs: [`p${pageNum}-txt-${idx}`],
          });
        }

        this.logger.info('PdfAnalysis', `Page ${pageNum} analyzed`, {
          rawObjects: bundle.rawObjectCount,
          normalizedRegions: regions.length,
          localizedGraphics: bundle.imageBoxes.length + iconClusters.length,
          brokenGlyphRegions,
          deduplicatedSpans: bundle.deduplicatedSpans,
        });

        let rasterPreviewBase64: string | undefined;
        if (!bundle.isDigitalVectorPage) {
          const fallbackPng = await getLazyPagePng();
          rasterPreviewBase64 = fallbackPng?.toString('base64');
        }

        pages.push({
          pageNumber: pageNum,
          width: widthIn,
          height: heightIn,
          rawObjectCount: bundle.rawObjectCount,
          regions,
          bands: [],
          vectorPrimitives: bundle.vectorPrimitives,
          rasterPreviewBase64,
          brokenGlyphRegions,
          deduplicatedSpans: bundle.deduplicatedSpans,
        });
      }

      const firstPage = pages[0];
      return {
        document: {
          name: documentName,
          pageCount: pages.length,
          pageWidth: firstPage.width,
          pageHeight: firstPage.height,
          unit: 'inch',
          extractedAt: 'deterministic',
          extractionMode: anyPageDigitalVector ? 'digital-vector' : 'raster-fallback',
        },
        pages,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('PdfAnalysis', `PDF analysis failed: ${msg}`);
      throw new ReportGenError(ReportGenErrorCode.PDF_ANALYSIS_FAILED, msg, err);
    }
  }

  private extractNormalizedTextLines(
    items: PdfTextItem[],
    pageHeightPt: number,
    styles: Record<string, { fontFamily?: string }>,
    textColorEvents: TextColorEvent[],
    vectorRects: RawVectorRect[],
    weights: CompilerWeights = DEFAULT_COMPILER_WEIGHTS
  ): {
    mergedLines: MergedTextLine[];
    brokenGlyphSpans: NormalizedSpan[];
    deduplicatedSpans: number;
    rawSpanBoxesIn: Array<{ x: number; y: number; width: number; height: number }>;
  } {
    const matchTextColor = (x: number, y: number): string => {
      let sameLineColor: string | undefined;
      let sameLineScore = Infinity;
      for (const ev of textColorEvents) {
        if (Math.abs(ev.y - y) <= 0.045) {
          const dx = Math.abs(ev.x - x);
          const score = ev.x <= x + 0.05 ? dx : dx + 0.4;
          if (score < sameLineScore) {
            sameLineScore = score;
            sameLineColor = ev.color;
          }
        }
      }
      if (sameLineColor && sameLineScore <= 7.8) {
        return sameLineColor;
      }
      let bestColor = '#0F172A';
      let bestDist = 0.35;
      for (const ev of textColorEvents) {
        const d = Math.hypot(ev.x - x, ev.y - y);
        if (d < bestDist) {
          bestDist = d;
          bestColor = ev.color;
        }
      }
      return bestColor;
    };

    const thinHorizLines = vectorRects.filter((r) => r.height <= 0.03 && r.width >= 0.1);
    const hasUnderlineBelow = (x: number, yBottom: number, width: number): boolean => {
      return thinHorizLines.some((ln) => {
        if (Math.abs(ln.y - yBottom) > 0.045) return false;
        const overlap = Math.min(x + width, ln.x + ln.width) - Math.max(x, ln.x);
        return overlap >= Math.min(width, ln.width) * 0.72;
      });
    };

    const rawSpans: NormalizedSpan[] = items.map((it) => {
      const tx = it.transform;
      const fontSizePt = Math.max(5.5, Math.hypot(tx[0], tx[1]) || Math.hypot(tx[2], tx[3]) || 10);
      const xPt = tx[4];
      const yBaselineIn = (pageHeightPt - tx[5]) / PT_PER_INCH;
      const yTopPt = pageHeightPt - tx[5] - fontSizePt * 0.85;
      const wPt = Math.max(it.width || it.str.length * fontSizePt * weights.charWidthFactor, 4);
      const hPt = Math.max(it.height || fontSizePt * 1.2, fontSizePt * 1.15);
      const xIn = xPt / PT_PER_INCH;
      const yIn = Math.max(0, yTopPt / PT_PER_INCH);
      const widthIn = wPt / PT_PER_INCH;
      const heightIn = hPt / PT_PER_INCH;
      const loadedName = styles[it.fontName]?.fontFamily;
      const flags = inferFontFlags(it.fontName, loadedName);
      const normText = normalizeLigatures(it.str);
      return {
        text: normText,
        x: xIn,
        y: yIn,
        baselineY: yBaselineIn,
        width: widthIn,
        height: heightIn,
        fontSizePt,
        fontName: it.fontName,
        fontLoadedName: loadedName,
        fontFamily: flags.family,
        bold: flags.bold,
        italic: flags.italic,
        underline: hasUnderlineBelow(xIn, yBaselineIn + 0.02, widthIn),
        color: matchTextColor(xIn, yBaselineIn),
        brokenGlyph: hasBrokenGlyphs(normText),
      };
    });

    const brokenGlyphSpans = rawSpans.filter((s) => s.brokenGlyph);
    const cleanSpans = rawSpans.filter((s) => !s.brokenGlyph);
    const rawSpanBoxesIn = rawSpans.map((s) => ({
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
    }));

    const baselineTolIn = weights.baselineYTolPt / PT_PER_INCH;
    // Transitive quantized visual baseline sorting: bucket by baselineY (<= baselineTolIn) then sort ascending X
    const sortedByY = [...cleanSpans].sort((a, b) => a.baselineY - b.baselineY || a.x - b.x);
    const baselineBuckets: NormalizedSpan[][] = [];
    for (const sp of sortedByY) {
      const lastBucket = baselineBuckets[baselineBuckets.length - 1];
      if (lastBucket && Math.abs(sp.baselineY - lastBucket[0].baselineY) <= baselineTolIn) {
        lastBucket.push(sp);
      } else {
        baselineBuckets.push([sp]);
      }
    }
    const visuallySortedSpans: NormalizedSpan[] = [];
    for (const bucket of baselineBuckets) {
      bucket.sort((a, b) => a.x - b.x || a.baselineY - b.baselineY);
      visuallySortedSpans.push(...bucket);
    }

    // Step A: Deduplicate fake-bold / double-stroked / stacked duplicate spans
    const dedupedSpans: NormalizedSpan[] = [];
    let deduplicatedSpans = 0;
    for (const cur of visuallySortedSpans) {
      const curTrim = cur.text.trim();
      const maxVertDup = Math.max(0.025, (cur.fontSizePt / PT_PER_INCH) * 0.72);
      const dup = dedupedSpans.find(
        (prev) =>
          prev.text.trim() === curTrim &&
          Math.abs(prev.x - cur.x) <= 0.025 &&
          Math.abs(prev.baselineY - cur.baselineY) <= maxVertDup &&
          Math.abs(prev.fontSizePt - cur.fontSizePt) <= 0.8 &&
          prev.color === cur.color
      );
      if (dup) {
        dup.bold = true;
        deduplicatedSpans++;
      } else {
        dedupedSpans.push({ ...cur });
      }
    }

    // Step B: Merge contiguous horizontal spans on the same baseline (<= 1.5pt) decoupled from column X-boundaries.
    // Do NOT split justified words unless gap > fontSize * 1.8 or a vertical vector border sits inside the gap.
    // Exception: if a line starts with a list marker (1., 2., a., b., (1)) followed by gap > fontSize * 0.35, split [markerSpan, bodySpan].
    const fixSingleSpanParenSpacing = (s: string): string => s.replace(/\)([A-Za-z0-9])/g, ') $1');
    const LIST_MARKER_START_RE = /^(\d+(?:\.\d+)*\.|\([a-z0-9]{1,3}\)|[a-z]\.|[•\u2022\-–])$/i;

    const vertBorderTolIn = 1 / PT_PER_INCH;
    const hasVerticalBorderInGap = (
      xLeftIn: number,
      xRightIn: number,
      yTopIn: number,
      yBottomIn: number
    ): boolean => {
      if (xRightIn < xLeftIn - vertBorderTolIn) return false;
      const gapMinX = xLeftIn - vertBorderTolIn;
      const gapMaxX = xRightIn + vertBorderTolIn;
      return vectorRects.some((r) => {
        if (r.height < 0.08) return false;
        const overlapsY = r.y <= yBottomIn + 2 / PT_PER_INCH && r.y + r.height >= yTopIn - 2 / PT_PER_INCH;
        if (!overlapsY) return false;
        if (r.width <= 0.04) {
          const lineX = r.x + r.width / 2;
          return lineX >= gapMinX && lineX <= gapMaxX;
        }
        if (r.strokeColor || r.fillColor) {
          const leftEdgeInGap = r.x >= gapMinX && r.x <= gapMaxX;
          const rightEdgeInGap = r.x + r.width >= gapMinX && r.x + r.width <= gapMaxX;
          return leftEdgeInGap || rightEdgeInGap;
        }
        return false;
      });
    };

    const mergedLines: MergedTextLine[] = [];
    let prevBaselineYIn = 0;
    let prevSpanCount = 0;
    for (const cur of dedupedSpans) {
      const prev = mergedLines[mergedLines.length - 1];
      const gap = prev ? cur.x - (prev.x + prev.width) : Infinity;
      const gapPt = gap * PT_PER_INCH;

      const sameBaselineY = Boolean(prev && Math.abs(prevBaselineYIn - cur.baselineY) <= baselineTolIn);
      const prevTrimmed = prev ? prev.text.trim() : '';
      const isLeadingListMarker =
        Boolean(prev) &&
        prevSpanCount === 1 &&
        LIST_MARKER_START_RE.test(prevTrimmed) &&
        gapPt > prev!.fontSizePt * weights.markerGapRatio;

      const verticalBorderSplit =
        Boolean(prev) &&
        sameBaselineY &&
        gapPt >= -1.0 &&
        hasVerticalBorderInGap(
          prev!.x + prev!.width,
          cur.x,
          Math.min(prev!.y, cur.y),
          Math.max(prev!.y + prev!.height, cur.y + cur.height)
        );

      const maxMergeGapPt = prev ? prev.fontSizePt * weights.justifyGapRatio : 0;

      const sameBaseline =
        sameBaselineY &&
        !isLeadingListMarker &&
        !verticalBorderSplit &&
        gapPt >= -2.5 &&
        gapPt <= maxMergeGapPt &&
        Math.abs(prev!.fontSizePt - cur.fontSizePt) <= 2.2;

      const curTextFixed = fixSingleSpanParenSpacing(cur.text);

      if (sameBaseline && prev) {
        const lastRun = prev.runs[prev.runs.length - 1];
        const parenToAlnum =
          /\)$/.test(lastRun.text.trimEnd()) && /^[A-Za-z0-9]/.test(curTextFixed.trimStart());
        const insideParenEdge =
          /\($/.test(lastRun.text) || /^\)/.test(curTextFixed);
        const needsSpace =
          !lastRun.text.endsWith(' ') &&
          !curTextFixed.startsWith(' ') &&
          (parenToAlnum || (!insideParenEdge && gapPt > prev.fontSizePt * weights.spaceGapRatio));
        const spacer = needsSpace ? ' ' : '';

        const sameRunStyle =
          lastRun.fontFamily === cur.fontFamily &&
          Math.abs(lastRun.fontSizePt - cur.fontSizePt) <= 0.3 &&
          lastRun.bold === cur.bold &&
          lastRun.italic === cur.italic &&
          Boolean(lastRun.underline) === cur.underline &&
          lastRun.color === cur.color;

        if (sameRunStyle) {
          lastRun.text = `${lastRun.text}${spacer}${curTextFixed}`.replace(/ {2,}/g, ' ');
        } else {
          if (spacer && !lastRun.text.endsWith(' ')) {
            lastRun.text = `${lastRun.text} `;
          }
          prev.runs.push({
            text: curTextFixed.replace(/^ +/, needsSpace ? '' : ' '),
            fontFamily: cur.fontFamily,
            fontSizePt: Math.round(cur.fontSizePt * 10) / 10,
            bold: cur.bold,
            italic: cur.italic,
            underline: cur.underline || undefined,
            color: cur.color,
          });
        }

        prev.text = prev.runs.map((r) => r.text).join('').trim();
        prev.width = Math.max(prev.width, cur.x + cur.width - prev.x);
        prev.height = Math.max(prev.height, cur.height);
        prev.y = Math.min(prev.y, cur.y);
        prevSpanCount++;
      } else {
        const initialText = curTextFixed.trim();
        if (!initialText) continue;
        mergedLines.push({
          text: initialText,
          runs: [
            {
              text: initialText,
              fontFamily: cur.fontFamily,
              fontSizePt: Math.round(cur.fontSizePt * 10) / 10,
              bold: cur.bold,
              italic: cur.italic,
              underline: cur.underline || undefined,
              color: cur.color,
            },
          ],
          x: cur.x,
          y: cur.y,
          width: cur.width,
          height: cur.height,
          fontSizePt: cur.fontSizePt,
          fontFamily: cur.fontFamily,
          bold: cur.bold,
          italic: cur.italic,
          underline: cur.underline,
          color: cur.color,
        });
        prevBaselineYIn = cur.baselineY;
        prevSpanCount = 1;
      }
    }

    return { mergedLines, brokenGlyphSpans, deduplicatedSpans, rawSpanBoxesIn };
  }

  private async detectAndMergePrimitives(
    pageNum: number,
    png300Buffer: Buffer | undefined,
    rawSpanBoxesIn: Array<{ x: number; y: number; width: number; height: number }>,
    pageWidthIn: number,
    pageHeightIn: number,
    vectorRects: RawVectorRect[],
    weights: CompilerWeights
  ): Promise<{
    primitives: ExtractedVectorPrimitive[];
    augmentedRects: RawVectorRect[];
  }> {
    const primitives: ExtractedVectorPrimitive[] = [];
    const augmentedRects: RawVectorRect[] = [...vectorRects];
    let seq = 1;

    const addPrim = (
      kind: VectorPrimitiveKind,
      xIn: number,
      yIn: number,
      wIn: number,
      hIn: number,
      colorHex: string | undefined,
      source: 'rle' | 'vector' | 'merged'
    ) => {
      primitives.push({
        id: `p${pageNum}-prim-${seq++}`,
        kind,
        x: roundIn(xIn),
        y: roundIn(yIn),
        width: roundIn(wIn),
        height: roundIn(hIn),
        xPt: Math.round(xIn * PT_PER_INCH * 10) / 10,
        yPt: Math.round(yIn * PT_PER_INCH * 10) / 10,
        widthPt: Math.round(wIn * PT_PER_INCH * 10) / 10,
        heightPt: Math.round(hIn * PT_PER_INCH * 10) / 10,
        colorHex,
        source,
      });
    };

    const isLightFill = (hex?: string): boolean => {
      if (!hex || hex.toUpperCase() === '#FFFFFF') return false;
      const clean = hex.replace('#', '');
      if (clean.length !== 6) return true;
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      return lum > 150;
    };

    // Seed from native CTM vector rectangles/lines first
    for (const vr of vectorRects) {
      const wPt = vr.width * PT_PER_INCH;
      const hPt = vr.height * PT_PER_INCH;
      if (hPt <= 3.5 && wPt >= 10) {
        addPrim('HLine', vr.x, vr.y, vr.width, Math.max(vr.height, 0.008), vr.strokeColor ?? vr.fillColor, 'vector');
      } else if (wPt <= 3.5 && hPt >= 10) {
        addPrim('VLine', vr.x, vr.y, Math.max(vr.width, 0.008), vr.height, vr.strokeColor ?? vr.fillColor, 'vector');
      } else if (vr.fillColor && vr.fillColor.toUpperCase() !== '#FFFFFF' && wPt >= 36 && hPt >= 8 && hPt <= 70) {
        const kind: VectorPrimitiveKind = isLightFill(vr.fillColor) ? 'RowFillBand' : 'FillBanner';
        addPrim(kind, vr.x, vr.y, vr.width, vr.height, vr.fillColor, 'vector');
      }
    }

    if (!png300Buffer) {
      return { primitives, augmentedRects };
    }

    try {
      const { PNG } = await import('pngjs');
      const png = PNG.sync.read(png300Buffer);
      const W = png.width;
      const H = png.height;
      const data = png.data;
      const lumThresh = weights.bannerLuminanceMax;

      // 1. Build foreground binary mask (luminance < bannerLuminanceMax) & mask out vector text boxes +3px
      const fgMask = new Uint8Array(W * H);
      for (let idx = 0, p = 0; idx < data.length; idx += 4, p++) {
        const a = data[idx + 3];
        if (a < 20) continue;
        const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        if (lum < lumThresh) {
          fgMask[p] = 1;
        }
      }

      const textCleared = new Uint8Array(W * H);
      for (const tb of rawSpanBoxesIn) {
        const x0 = Math.max(0, Math.floor((tb.x / pageWidthIn) * W) - 3);
        const x1 = Math.min(W - 1, Math.ceil(((tb.x + tb.width) / pageWidthIn) * W) + 3);
        const y0 = Math.max(0, Math.floor((tb.y / pageHeightIn) * H) - 3);
        const y1 = Math.min(H - 1, Math.ceil(((tb.y + tb.height) / pageHeightIn) * H) + 3);
        for (let y = y0; y <= y1; y++) {
          const rowOff = y * W;
          for (let x = x0; x <= x1; x++) {
            fgMask[rowOff + x] = 0;
            textCleared[rowOff + x] = 1;
          }
        }
      }

      const sampleColor = (x0: number, y0: number, x1: number, y1: number): string => {
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let cnt = 0;
        const stepX = Math.max(1, Math.floor((x1 - x0) / 16));
        const stepY = Math.max(1, Math.floor((y1 - y0) / 8));
        for (let y = y0; y <= y1; y += stepY) {
          for (let x = x0; x <= x1; x += stepX) {
            const p = y * W + x;
            if (fgMask[p] === 1 && textCleared[p] === 0) {
              const off = p * 4;
              sumR += data[off];
              sumG += data[off + 1];
              sumB += data[off + 2];
              cnt++;
            }
          }
        }
        if (cnt === 0) return '#CBD5E1';
        return rgb255ToHex(sumR / cnt, sumG / cnt, sumB / cnt);
      };

      const mergeBox = (
        boxes: Array<{ x0: number; y0: number; x1: number; y1: number }>,
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        tolX: number,
        tolY: number
      ) => {
        for (const b of boxes) {
          if (x0 <= b.x1 + tolX && x1 >= b.x0 - tolX && y0 <= b.y1 + tolY && y1 >= b.y0 - tolY) {
            b.x0 = Math.min(b.x0, x0);
            b.y0 = Math.min(b.y0, y0);
            b.x1 = Math.max(b.x1, x1);
            b.y1 = Math.max(b.y1, y1);
            return;
          }
        }
        boxes.push({ x0, y0, x1, y1 });
      };

      // 2. Horizontal 1D RLE pass: detect thin HLines & filled horizontal spans (FillBanner / RowFillBand)
      const hLineBoxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
      const fillStripBoxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
      const minHRunPx = Math.round((10 / PT_PER_INCH) * (W / pageWidthIn));
      const minFillWidthPx = Math.round((48 / PT_PER_INCH) * (W / pageWidthIn));

      for (let y = 0; y < H; y++) {
        const rowOff = y * W;
        let x = 0;
        while (x < W) {
          if (fgMask[rowOff + x] === 1) {
            const startX = x;
            while (x < W) {
              if (fgMask[rowOff + x] === 1) {
                x++;
              } else if (textCleared[rowOff + x] === 1) {
                // Bridge across cleared text glyphs ONLY if solid ink resumes on the right
                let k = x;
                while (k < W && textCleared[rowOff + k] === 1 && k - x < minFillWidthPx * 2) k++;
                if (k < W && fgMask[rowOff + k] === 1 && x - startX >= 4) {
                  x = k;
                } else {
                  break;
                }
              } else {
                break;
              }
            }
            const runLen = x - startX;
            if (runLen >= minHRunPx) {
              // Check immediate vertical thickness around midpoint to distinguish 1..12px thin line vs taller banner strip
              mergeBox(hLineBoxes, startX, y, x - 1, y, 4, 2);
              if (runLen >= minFillWidthPx) {
                mergeBox(fillStripBoxes, startX, y, x - 1, y, 6, 3);
              }
            }
          } else {
            x++;
          }
        }
      }

      // 3. Vertical 1D RLE pass: detect thin VLines
      const vLineBoxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
      const minVRunPx = Math.round((10 / PT_PER_INCH) * (H / pageHeightIn));
      for (let x = 0; x < W; x++) {
        let y = 0;
        while (y < H) {
          if (fgMask[y * W + x] === 1) {
            const startY = y;
            while (y < H && fgMask[y * W + x] === 1) y++;
            if (y - startY >= minVRunPx) {
              mergeBox(vLineBoxes, x, startY, x, y - 1, 2, 4);
            }
          } else {
            y++;
          }
        }
      }

      const maxLineThickPx = Math.max(8, Math.round((3.2 / PT_PER_INCH) * (W / pageWidthIn)));
      const minBannerHeightPx = Math.round((10 / PT_PER_INCH) * (H / pageHeightIn));
      const maxBannerHeightPx = Math.round((68 / PT_PER_INCH) * (H / pageHeightIn));

      const hasMatchingVector = (xIn: number, yIn: number, wIn: number, hIn: number, kind: VectorPrimitiveKind): boolean => {
        const tol = 6 / PT_PER_INCH;
        return primitives.some(
          (p) =>
            p.kind === kind &&
            Math.abs(p.x - xIn) <= tol &&
            Math.abs(p.y - yIn) <= tol &&
            Math.abs(p.width - wIn) <= tol * 2 &&
            Math.abs(p.height - hIn) <= tol * 2
        );
      };

      const mergeOrAddRle = (
        kind: VectorPrimitiveKind,
        x0: number,
        y0: number,
        x1: number,
        y1: number
      ) => {
        const xIn = (x0 / W) * pageWidthIn;
        const yIn = (y0 / H) * pageHeightIn;
        const wIn = Math.max(0.008, ((x1 - x0 + 1) / W) * pageWidthIn);
        const hIn = Math.max(0.008, ((y1 - y0 + 1) / H) * pageHeightIn);
        const colorHex = sampleColor(x0, y0, x1, y1);

        if (hasMatchingVector(xIn, yIn, wIn, hIn, kind)) {
          return;
        }
        addPrim(kind, xIn, yIn, wIn, hIn, colorHex, 'rle');
        augmentedRects.push({
          x: xIn,
          y: yIn,
          width: wIn,
          height: hIn,
          strokeColor: kind === 'HLine' || kind === 'VLine' ? colorHex : undefined,
          fillColor: kind === 'FillBanner' || kind === 'RowFillBand' ? colorHex : undefined,
          lineWidthPt: kind === 'HLine' || kind === 'VLine' ? 0.75 : 0,
        });
      };

      for (const b of hLineBoxes) {
        const bh = b.y1 - b.y0 + 1;
        const bw = b.x1 - b.x0 + 1;
        if (bh <= maxLineThickPx && bw >= minHRunPx) {
          mergeOrAddRle('HLine', b.x0, b.y0, b.x1, b.y1);
        }
      }

      for (const b of vLineBoxes) {
        const bw = b.x1 - b.x0 + 1;
        const bh = b.y1 - b.y0 + 1;
        if (bw <= maxLineThickPx && bh >= minVRunPx) {
          mergeOrAddRle('VLine', b.x0, b.y0, b.x1, b.y1);
        }
      }

      for (const b of fillStripBoxes) {
        const bw = b.x1 - b.x0 + 1;
        const bh = b.y1 - b.y0 + 1;
        if (bw >= minFillWidthPx && bh >= minBannerHeightPx && bh <= maxBannerHeightPx) {
          const colorHex = sampleColor(b.x0, b.y0, b.x1, b.y1);
          const kind: VectorPrimitiveKind = isLightFill(colorHex) ? 'RowFillBand' : 'FillBanner';
          mergeOrAddRle(kind, b.x0, b.y0, b.x1, b.y1);
        }
      }
    } catch {
      // Non-fatal fallback: keep CTM vector primitives
    }

    return { primitives, augmentedRects };
  }

  private extractVectorsAndImages(
    opList: { fnArray: number[]; argsArray: unknown[][] },
    pageHeightPt: number,
    pageWidthIn: number,
    pageHeightIn: number
  ): {
    vectorRects: RawVectorRect[];
    imageBoxes: Array<{ x: number; y: number; width: number; height: number }>;
    complexClusterBoxes: Array<{ x: number; y: number; width: number; height: number; fallbackRect?: RawVectorRect }>;
    textColorEvents: TextColorEvent[];
  } {
    const OPS = pdfjsLib.OPS;
    const vectorRects: RawVectorRect[] = [];
    const imageBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    const curveBoxes: Array<{ x: number; y: number; width: number; height: number; fallbackRect?: RawVectorRect }> = [];
    const textColorEvents: TextColorEvent[] = [];

    interface GState {
      ctm: number[];
      strokeColor: string;
      fillColor?: string;
      lineWidthPt: number;
    }

    const gStack: GState[] = [
      {
        ctm: [1, 0, 0, 1, 0, 0],
        strokeColor: '#CBD5E1',
        fillColor: undefined,
        lineWidthPt: 0.75,
      },
    ];

    const applyCtm = (m: number[], x: number, y: number): [number, number] => [
      m[0] * x + m[2] * y + m[4],
      m[1] * x + m[3] * y + m[5],
    ];

    const mulMatrix = (a: number[], b: number[]): number[] => [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5],
    ];

    let pendingRects: Array<{ x: number; y: number; w: number; h: number }> = [];
    let pendingLines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    let curX = 0;
    let curY = 0;
    let tm = [1, 0, 0, 1, 0, 0];
    let tlm = [1, 0, 0, 1, 0, 0];
    let textLeading = 0;

    const emitPathShapes = (
      subpaths: Array<{ pts: Array<{ x: number; y: number }>; hasCurves: boolean }>,
      hasFill: boolean,
      hasStroke: boolean,
      fillCol: string | undefined,
      strokeCol: string,
      lw: number
    ) => {
      for (const sp of subpaths) {
        if (sp.pts.length < 2) continue;
        const xs = sp.pts.map((p) => p.x);
        const ys = sp.pts.map((p) => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const w = maxX - minX;
        const h = maxY - minY;

        if (w <= 0.008 && h <= 0.008) continue;

        if (
          w > pageWidthIn - 0.15 &&
          h > pageHeightIn - 0.15 &&
          (!fillCol || fillCol === '#FFFFFF')
        ) {
          continue;
        }

        if (sp.hasCurves) {
          if (w >= 0.04 && h >= 0.04 && w <= pageWidthIn + 0.1 && h <= 4.5 && (hasFill || hasStroke)) {
            curveBoxes.push({
              x: Math.max(0, minX),
              y: Math.max(0, minY),
              width: Math.min(pageWidthIn - Math.max(0, minX), w),
              height: h,
              fallbackRect:
                w > 0.2 && h > 0.12
                  ? {
                      x: Math.max(0, minX),
                      y: Math.max(0, minY),
                      width: Math.min(pageWidthIn - Math.max(0, minX), w),
                      height: h,
                      fillColor: hasFill ? fillCol : undefined,
                      strokeColor: hasStroke ? strokeCol : undefined,
                      lineWidthPt: lw,
                    }
                  : undefined,
            });
          } else if (w > 0.2 && h > 0.12 && (hasFill || hasStroke)) {
            vectorRects.push({
              x: Math.max(0, minX),
              y: Math.max(0, minY),
              width: w,
              height: h,
              fillColor: hasFill ? fillCol : undefined,
              strokeColor: hasStroke ? strokeCol : undefined,
              lineWidthPt: lw,
            });
          }
          continue;
        }

        const isThinLine = h <= 0.035 || w <= 0.035;
        if (isThinLine) {
          const lineThicknessIn = Math.max(0.005, lw / PT_PER_INCH);
          vectorRects.push({
            x: Math.max(0, minX),
            y: Math.max(0, minY),
            width: w <= 0.035 ? Math.max(lineThicknessIn, w) : w,
            height: h <= 0.035 ? Math.max(lineThicknessIn, h) : h,
            strokeColor: hasStroke ? strokeCol : fillCol,
            fillColor: hasFill ? fillCol : undefined,
            lineWidthPt: lw,
          });
        } else if (hasFill || hasStroke) {
          vectorRects.push({
            x: Math.max(0, minX),
            y: Math.max(0, minY),
            width: w,
            height: h,
            strokeColor: hasStroke ? strokeCol : undefined,
            fillColor: hasFill ? fillCol : undefined,
            lineWidthPt: lw,
          });
        }
      }
    };

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i] ?? [];
      const gs = gStack[gStack.length - 1];
      const ctm = gs.ctm;

      if (fn === OPS.save) {
        gStack.push({
          ctm: [...gs.ctm],
          strokeColor: gs.strokeColor,
          fillColor: gs.fillColor,
          lineWidthPt: gs.lineWidthPt,
        });
      } else if (fn === OPS.restore) {
        if (gStack.length > 1) gStack.pop();
      } else if (fn === OPS.transform && args.length >= 6) {
        gs.ctm = mulMatrix(ctm, args as number[]);
      } else if (fn === OPS.setLineWidth && typeof args[0] === 'number') {
        gs.lineWidthPt = Math.max(0.4, args[0]);
      } else if (fn === OPS.setStrokeRGBColor) {
        const c = normalizeColorArgs(args);
        if (c) gs.strokeColor = c;
      } else if (fn === OPS.setFillRGBColor) {
        const c = normalizeColorArgs(args);
        if (c) gs.fillColor = c;
      } else if (fn === OPS.setFillGray && typeof args[0] === 'number') {
        gs.fillColor = grayToHex(args[0]);
      } else if (fn === OPS.setStrokeGray && typeof args[0] === 'number') {
        gs.strokeColor = grayToHex(args[0]);
      } else if (fn === OPS.setFillCMYKColor && args.length >= 4) {
        gs.fillColor = cmykToHex(Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]));
      } else if (fn === OPS.setStrokeCMYKColor && args.length >= 4) {
        gs.strokeColor = cmykToHex(Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]));
      } else if (fn === OPS.beginText) {
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
      } else if (fn === OPS.setLeading && typeof args[0] === 'number') {
        textLeading = Number(args[0]);
      } else if (fn === OPS.setTextMatrix && args.length >= 1) {
        const rawMat =
          args.length >= 6
            ? args
            : args[0] && typeof (args[0] as Record<number, unknown>)[0] === 'number'
              ? Array.from({ length: 6 }, (_, idx) => Number((args[0] as Record<number, number>)[idx]))
              : null;
        if (rawMat && rawMat.length >= 6) {
          tm = [
            Number(rawMat[0]),
            Number(rawMat[1]),
            Number(rawMat[2]),
            Number(rawMat[3]),
            Number(rawMat[4]),
            Number(rawMat[5]),
          ];
          tlm = [...tm];
        }
      } else if ((fn === OPS.moveText || fn === OPS.setLeadingMoveText) && args.length >= 2) {
        if (fn === OPS.setLeadingMoveText) {
          textLeading = -Number(args[1]);
        }
        tlm = mulMatrix(tlm, [1, 0, 0, 1, Number(args[0]), Number(args[1])]);
        tm = [...tlm];
      } else if (fn === OPS.nextLine || fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
        tlm = mulMatrix(tlm, [1, 0, 0, 1, 0, -textLeading]);
        tm = [...tlm];
        if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
          const composed = mulMatrix(ctm, tm);
          textColorEvents.push({
            x: composed[4] / PT_PER_INCH,
            y: (pageHeightPt - composed[5]) / PT_PER_INCH,
            color: gs.fillColor ?? '#0F172A',
          });
        }
      } else if (fn === OPS.showText || fn === OPS.showSpacedText) {
        const composed = mulMatrix(ctm, tm);
        const pxIn = composed[4] / PT_PER_INCH;
        const pyIn = (pageHeightPt - composed[5]) / PT_PER_INCH;
        textColorEvents.push({
          x: pxIn,
          y: pyIn,
          color: gs.fillColor ?? '#0F172A',
        });
      } else if (fn === OPS.constructPath && typeof args[0] === 'number') {
        const paintOp = args[0] as number;
        const hasFill =
          paintOp === OPS.fill ||
          paintOp === OPS.eoFill ||
          paintOp === OPS.fillStroke ||
          paintOp === OPS.eoFillStroke;
        const hasStroke =
          paintOp === OPS.stroke ||
          paintOp === OPS.closeStroke ||
          paintOp === OPS.fillStroke ||
          paintOp === OPS.eoFillStroke;

        const rawBuf = Array.isArray(args[1]) ? (args[1][0] as ArrayLike<number> | undefined) : undefined;
        const subpaths: Array<{ pts: Array<{ x: number; y: number }>; hasCurves: boolean }> = [];
        let active: { pts: Array<{ x: number; y: number }>; hasCurves: boolean } | null = null;

        if (rawBuf && rawBuf.length > 0) {
          let k = 0;
          while (k < rawBuf.length) {
            const code = rawBuf[k++];
            if (code === 0 && k + 1 < rawBuf.length) {
              if (active && active.pts.length >= 2) subpaths.push(active);
              const [px, py] = applyCtm(ctm, Number(rawBuf[k]), Number(rawBuf[k + 1]));
              active = {
                pts: [{ x: px / PT_PER_INCH, y: (pageHeightPt - py) / PT_PER_INCH }],
                hasCurves: false,
              };
              k += 2;
            } else if (code === 1 && k + 1 < rawBuf.length) {
              const [px, py] = applyCtm(ctm, Number(rawBuf[k]), Number(rawBuf[k + 1]));
              if (!active) active = { pts: [], hasCurves: false };
              active.pts.push({ x: px / PT_PER_INCH, y: (pageHeightPt - py) / PT_PER_INCH });
              k += 2;
            } else if (code === 2 && k + 5 < rawBuf.length) {
              const [px, py] = applyCtm(ctm, Number(rawBuf[k + 4]), Number(rawBuf[k + 5]));
              if (!active) active = { pts: [], hasCurves: false };
              active.hasCurves = true;
              active.pts.push({ x: px / PT_PER_INCH, y: (pageHeightPt - py) / PT_PER_INCH });
              k += 6;
            } else if (code === 3 && k + 3 < rawBuf.length) {
              const [px, py] = applyCtm(ctm, Number(rawBuf[k + 2]), Number(rawBuf[k + 3]));
              if (!active) active = { pts: [], hasCurves: false };
              active.hasCurves = true;
              active.pts.push({ x: px / PT_PER_INCH, y: (pageHeightPt - py) / PT_PER_INCH });
              k += 4;
            } else if (code === 4) {
              if (active && active.pts.length >= 2) subpaths.push(active);
              active = null;
            } else {
              break;
            }
          }
          if (active && active.pts.length >= 2) subpaths.push(active);
        }
        emitPathShapes(subpaths, hasFill, hasStroke, gs.fillColor, gs.strokeColor, gs.lineWidthPt);
      } else if (fn === OPS.rectangle && args.length >= 4) {
        const [rx, ry, rw, rh] = args as number[];
        const [x1, y1] = applyCtm(ctm, rx, ry);
        const [x2, y2] = applyCtm(ctm, rx + rw, ry + rh);
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = pageHeightPt - Math.max(y1, y2);
        const maxY = pageHeightPt - Math.min(y1, y2);
        pendingRects.push({
          x: minX / PT_PER_INCH,
          y: minY / PT_PER_INCH,
          w: (maxX - minX) / PT_PER_INCH,
          h: (maxY - minY) / PT_PER_INCH,
        });
      } else if (fn === OPS.moveTo && args.length >= 2) {
        const [px, py] = applyCtm(ctm, Number(args[0]), Number(args[1]));
        curX = px;
        curY = pageHeightPt - py;
      } else if (fn === OPS.lineTo && args.length >= 2) {
        const [px, py] = applyCtm(ctm, Number(args[0]), Number(args[1]));
        const nextX = px;
        const nextY = pageHeightPt - py;
        pendingLines.push({
          x1: curX / PT_PER_INCH,
          y1: curY / PT_PER_INCH,
          x2: nextX / PT_PER_INCH,
          y2: nextY / PT_PER_INCH,
        });
        curX = nextX;
        curY = nextY;
      } else if (fn === OPS.constructPath && Array.isArray(args[0]) && Array.isArray(args[1])) {
        const subOps = args[0] as number[];
        const coords = args[1] as number[];
        let ci = 0;
        for (const sop of subOps) {
          if (sop === OPS.moveTo) {
            const [px, py] = applyCtm(ctm, coords[ci], coords[ci + 1]);
            curX = px;
            curY = pageHeightPt - py;
            ci += 2;
          } else if (sop === OPS.lineTo) {
            const [px, py] = applyCtm(ctm, coords[ci], coords[ci + 1]);
            const nextX = px;
            const nextY = pageHeightPt - py;
            pendingLines.push({
              x1: curX / PT_PER_INCH,
              y1: curY / PT_PER_INCH,
              x2: nextX / PT_PER_INCH,
              y2: nextY / PT_PER_INCH,
            });
            curX = nextX;
            curY = nextY;
            ci += 2;
          } else if (sop === OPS.curveTo) {
            ci += 6;
          } else if (sop === OPS.rectangle) {
            const [x1, y1] = applyCtm(ctm, coords[ci], coords[ci + 1]);
            const [x2, y2] = applyCtm(ctm, coords[ci] + coords[ci + 2], coords[ci + 1] + coords[ci + 3]);
            pendingRects.push({
              x: Math.min(x1, x2) / PT_PER_INCH,
              y: (pageHeightPt - Math.max(y1, y2)) / PT_PER_INCH,
              w: Math.abs(x2 - x1) / PT_PER_INCH,
              h: Math.abs(y2 - y1) / PT_PER_INCH,
            });
            ci += 4;
          }
        }
      } else if (
        fn === OPS.stroke ||
        fn === OPS.closeStroke ||
        fn === OPS.fill ||
        fn === OPS.eoFill ||
        fn === OPS.fillStroke ||
        fn === OPS.eoFillStroke
      ) {
        const hasFill =
          fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.eoFillStroke;
        const hasStroke =
          fn === OPS.stroke ||
          fn === OPS.closeStroke ||
          fn === OPS.fillStroke ||
          fn === OPS.eoFillStroke;

        for (const r of pendingRects) {
          if (r.w > 0.01 || r.h > 0.01) {
            vectorRects.push({
              x: Math.max(0, r.x),
              y: Math.max(0, r.y),
              width: r.w,
              height: r.h,
              strokeColor: hasStroke ? gs.strokeColor : undefined,
              fillColor: hasFill ? gs.fillColor : undefined,
              lineWidthPt: gs.lineWidthPt,
            });
          }
        }
        for (const ln of pendingLines) {
          const w = Math.abs(ln.x2 - ln.x1);
          const h = Math.abs(ln.y2 - ln.y1);
          if (w > 0.05 || h > 0.05) {
            const lineThicknessIn = Math.max(0.005, gs.lineWidthPt / PT_PER_INCH);
            vectorRects.push({
              x: Math.max(0, Math.min(ln.x1, ln.x2)),
              y: Math.max(0, Math.min(ln.y1, ln.y2)),
              width: w <= 0.035 ? Math.max(lineThicknessIn, w) : w,
              height: h <= 0.035 ? Math.max(lineThicknessIn, h) : h,
              strokeColor: hasStroke ? gs.strokeColor : gs.fillColor,
              lineWidthPt: gs.lineWidthPt,
            });
          }
        }
        pendingRects = [];
        pendingLines = [];
      } else if (fn === OPS.endPath) {
        pendingRects = [];
        pendingLines = [];
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        const [x1, y1] = applyCtm(ctm, 0, 0);
        const [x2, y2] = applyCtm(ctm, 1, 1);
        const minX = Math.min(x1, x2) / PT_PER_INCH;
        const maxX = Math.max(x1, x2) / PT_PER_INCH;
        const minY = (pageHeightPt - Math.max(y1, y2)) / PT_PER_INCH;
        const maxY = (pageHeightPt - Math.min(y1, y2)) / PT_PER_INCH;
        if (maxX - minX > 0.1 && maxY - minY > 0.1) {
          imageBoxes.push({
            x: Math.max(0, minX),
            y: Math.max(0, minY),
            width: maxX - minX,
            height: maxY - minY,
          });
        }
      }
    }

    const complexClusterBoxes: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      fallbackRect?: RawVectorRect;
    }> = [];
    const pad = 0.12;
    for (const cb of curveBoxes) {
      const merged = complexClusterBoxes.find(
        (existing) =>
          cb.x <= existing.x + existing.width + pad &&
          cb.x + cb.width >= existing.x - pad &&
          cb.y <= existing.y + existing.height + pad &&
          cb.y + cb.height >= existing.y - pad
      );
      if (merged) {
        const x1 = Math.min(merged.x, cb.x);
        const y1 = Math.min(merged.y, cb.y);
        const x2 = Math.max(merged.x + merged.width, cb.x + cb.width);
        const y2 = Math.max(merged.y + merged.height, cb.y + cb.height);
        merged.x = x1;
        merged.y = y1;
        merged.width = x2 - x1;
        merged.height = y2 - y1;
        if (!merged.fallbackRect && cb.fallbackRect) merged.fallbackRect = cb.fallbackRect;
      } else {
        complexClusterBoxes.push({ ...cb });
      }
    }

    return {
      vectorRects,
      imageBoxes,
      complexClusterBoxes: complexClusterBoxes.filter(
        (b) =>
          Math.max(b.width, b.height) >= 0.14 &&
          Math.min(b.width, b.height) >= 0.08 &&
          b.width <= pageWidthIn + 0.05 &&
          b.height <= 4.5
      ),
      textColorEvents,
    };
  }

  public async rasterizeSinglePageWithGhostscript(
    pdfBytes: Uint8Array,
    pageNumber: number,
    dpi = 300
  ): Promise<Buffer | undefined> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reportgen-gs-page-'));
    const inputPath = path.join(tmpDir, 'input.pdf');
    const outPath = path.join(tmpDir, 'page.png');
    try {
      fs.writeFileSync(inputPath, pdfBytes);
      await execFileAsync('gs', [
        '-dNOPAUSE',
        '-dBATCH',
        '-sDEVICE=png16m',
        `-r${dpi}`,
        `-dFirstPage=${pageNumber}`,
        `-dLastPage=${pageNumber}`,
        `-sOutputFile=${outPath}`,
        inputPath,
      ]);
      if (fs.existsSync(outPath)) {
        return fs.readFileSync(outPath);
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  public async rasterizePagesWithGhostscript(pdfBytes: Uint8Array, dpi = 150): Promise<Buffer[]> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reportgen-gs-'));
    const inputPath = path.join(tmpDir, 'input.pdf');
    const outPattern = path.join(tmpDir, 'page-%03d.png');
    try {
      fs.writeFileSync(inputPath, pdfBytes);
      await execFileAsync('gs', [
        '-dNOPAUSE',
        '-dBATCH',
        '-sDEVICE=png16m',
        `-r${dpi}`,
        `-sOutputFile=${outPattern}`,
        inputPath,
      ]);
      const files = fs
        .readdirSync(tmpDir)
        .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
        .sort();
      return files.map((f) => fs.readFileSync(path.join(tmpDir, f)));
    } catch {
      return [];
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private async cropPageRegionToBase64(
    pagePngBuffer: Buffer | undefined,
    box: { x: number; y: number; width: number; height: number },
    pageWidthIn: number,
    pageHeightIn: number
  ): Promise<string | undefined> {
    if (!pagePngBuffer) return undefined;
    try {
      const { PNG } = await import('pngjs');
      const src = PNG.sync.read(pagePngBuffer);
      const px = Math.max(0, Math.floor((box.x / pageWidthIn) * src.width));
      const py = Math.max(0, Math.floor((box.y / pageHeightIn) * src.height));
      const pw = Math.max(8, Math.min(src.width - px, Math.ceil((box.width / pageWidthIn) * src.width)));
      const ph = Math.max(8, Math.min(src.height - py, Math.ceil((box.height / pageHeightIn) * src.height)));

      const dst = new PNG({ width: pw, height: ph });
      PNG.bitblt(src, dst, px, py, pw, ph, 0, 0);
      return PNG.sync.write(dst).toString('base64');
    } catch {
      return undefined;
    }
  }
}
