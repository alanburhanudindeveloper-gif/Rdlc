import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type GateStage =
  | 'GATE_1_EXTRACTION'
  | 'GATE_2_SEGMENTATION'
  | 'GATE_3_SOLVER'
  | 'GATE_4_RDLC_XSD'
  | 'GATE_5_VALUE_FILL'
  | 'GATE_6_PARITY_RENDER';

export interface ScanContainerSnapshot {
  containerKey: string;
  strategy: string;
  topPt: number;
  leftPt: number;
  widthPt: number;
  heightPt: number;
  colCount: number;
  rowCount: number;
  columnWidthsPt: number[];
}

export interface GeometricFeatureInput {
  normX0?: number;
  normY0?: number;
  normWidth?: number;
  normHeight?: number;
  spanCount?: number;
  hLineCount?: number;
  vLineCount?: number;
  fillBannerCount?: number;
  rowFillCount?: number;
  operatorColCount?: number;
  hasDualTrackStream?: boolean;
  hasNestedTablix?: boolean;
  hasStaircaseIndent?: boolean;
  xsdValidationPassed?: boolean;
  sourcePageCount?: number;
  renderedPageCount?: number;
  contentDensity?: number;
}

export interface VectorArtifactMetadata {
  documentTemplate: string;
  pageIndex: number;
  gateStage: GateStage;
  appliedRules: string[];
  hasDualTrackStream: boolean;
  hasNestedTablix: boolean;
  hasStaircaseIndent: boolean;
  xsdValidationPassed: boolean;
  renderedPageCount: number;
  sourcePageCount: number;
}

export interface VectorArtifactRecord extends VectorArtifactMetadata {
  id: string;
  embedding: number[];
  rawFeatures: number[];
  containers: ScanContainerSnapshot[];
  diagnostics: string[];
  createdAtIso: string;
}

export interface VectorSearchResult {
  artifact: VectorArtifactRecord;
  similarity: number;
}

export interface RegressionDiffReport {
  baselineId: string;
  candidateId: string;
  pageParityDelta: number;
  tablixCountDelta: number;
  xsdRegressed: boolean;
  structuralFlagChanges: {
    hasDualTrackStream?: [boolean, boolean];
    hasNestedTablix?: [boolean, boolean];
    hasStaircaseIndent?: [boolean, boolean];
  };
  addedRules: string[];
  removedRules: string[];
  containerDiffs: Array<{
    index: number;
    baselineStrategy?: string;
    candidateStrategy?: string;
    colCountDelta: number;
    rowCountDelta: number;
    maxTopDriftPt: number;
    maxWidthDriftPt: number;
  }>;
  embeddingCosineSimilarity: number;
}

const VECTOR_DIM = 16;
const MAX_ARTIFACTS_STORED = 1000;

function sanitizeShortText(value: unknown, fallback: string, maxLen = 128): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\r\n\t\0]/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, maxLen) : fallback;
}

function clampFinite(value: unknown, min: number, max: number, fallback = 0): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function resolveConfinedStorePath(customPath?: string): string {
  const allowedRoot = path.resolve(process.cwd(), 'output');
  const candidate = customPath
    ? path.resolve(customPath)
    : path.resolve(allowedRoot, 'vector-store', 'artifacts.json');
  if (candidate !== allowedRoot && !candidate.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error('Vector store path must stay confined inside the output directory.');
  }
  return candidate;
}

export function extractGeometricFeatureVector(input: GeometricFeatureInput): {
  rawFeatures: number[];
  embedding: number[];
} {
  const srcPages = Math.max(1, clampFinite(input.sourcePageCount, 1, 500, 1));
  const rndPages = Math.max(0, clampFinite(input.renderedPageCount, 0, 500, srcPages));

  const rawFeatures = [
    clampFinite(input.normX0, 0, 1, 0),
    clampFinite(input.normY0, 0, 1, 0),
    clampFinite(input.normWidth, 0, 1, 1),
    clampFinite(input.normHeight, 0, 1, 1),
    Math.min(1, clampFinite(input.spanCount, 0, 5000, 0) / 200),
    Math.min(1, clampFinite(input.hLineCount, 0, 1000, 0) / 60),
    Math.min(1, clampFinite(input.vLineCount, 0, 1000, 0) / 30),
    Math.min(1, clampFinite(input.fillBannerCount, 0, 100, 0) / 10),
    Math.min(1, clampFinite(input.rowFillCount, 0, 500, 0) / 40),
    Math.min(1, clampFinite(input.operatorColCount, 0, 50, 0) / 4),
    input.hasDualTrackStream ? 1 : 0,
    input.hasNestedTablix ? 1 : 0,
    input.hasStaircaseIndent ? 1 : 0,
    input.xsdValidationPassed ? 1 : 0,
    Math.min(2, rndPages / srcPages),
    clampFinite(input.contentDensity, 0, 1, 0.5),
  ];

  return {
    rawFeatures,
    embedding: normalizeL2(rawFeatures),
  };
}

export function normalizeL2(values: number[]): number[] {
  const padded = new Array<number>(VECTOR_DIM).fill(0);
  for (let i = 0; i < Math.min(VECTOR_DIM, values.length); i++) {
    padded[i] = Number.isFinite(values[i]) ? values[i] : 0;
  }
  const norm = Math.sqrt(padded.reduce((acc, v) => acc + v * v, 0));
  if (norm <= 1e-12) return padded;
  return padded.map((v) => Math.round((v / norm) * 1e6) / 1e6);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length, VECTOR_DIM);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom <= 1e-12) return 0;
  return Math.round((dot / denom) * 1e6) / 1e6;
}

/**
 * Assistive Vector Database for test artifacts and scan-coordinate snapshots ([R-ARCH-01]).
 * Strictly read-only/assistive for similar-layout lookup, regression inspection, and diagnostic
 * diffing — never overwrites active coordinates or bypasses deterministic compiler rules.
 */
export class VectorArtifactStore {
  private readonly storeFilePath: string;
  private records: VectorArtifactRecord[] = [];
  private loaded = false;

  constructor(customPath?: string) {
    this.storeFilePath = resolveConfinedStorePath(customPath);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.storeFilePath)) {
        this.records = [];
        return;
      }
      const raw = fs.readFileSync(this.storeFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        this.records = parsed.filter(
          (item): item is VectorArtifactRecord =>
            Boolean(item && typeof item === 'object' && typeof (item as VectorArtifactRecord).id === 'string')
        );
      }
    } catch {
      this.records = [];
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.storeFilePath), { recursive: true });
    fs.writeFileSync(this.storeFilePath, JSON.stringify(this.records, null, 2), 'utf-8');
  }

  public recordArtifact(input: {
    documentTemplate: string;
    pageIndex: number;
    gateStage: GateStage;
    appliedRules?: string[];
    hasDualTrackStream?: boolean;
    hasNestedTablix?: boolean;
    hasStaircaseIndent?: boolean;
    xsdValidationPassed?: boolean;
    renderedPageCount?: number;
    sourcePageCount?: number;
    features?: GeometricFeatureInput;
    customEmbedding?: number[];
    containers?: ScanContainerSnapshot[];
    diagnostics?: string[];
  }): VectorArtifactRecord {
    this.ensureLoaded();

    const documentTemplate = sanitizeShortText(input.documentTemplate, 'UnknownTemplate', 160);
    const pageIndex = Math.trunc(clampFinite(input.pageIndex, 0, 5000, 0));
    const validStages: Set<GateStage> = new Set([
      'GATE_1_EXTRACTION',
      'GATE_2_SEGMENTATION',
      'GATE_3_SOLVER',
      'GATE_4_RDLC_XSD',
      'GATE_5_VALUE_FILL',
      'GATE_6_PARITY_RENDER',
    ]);
    const gateStage: GateStage = validStages.has(input.gateStage)
      ? input.gateStage
      : 'GATE_4_RDLC_XSD';

    const appliedRules = Array.isArray(input.appliedRules)
      ? Array.from(
          new Set(
            input.appliedRules
              .slice(0, 64)
              .map((r) => sanitizeShortText(r, '', 64))
              .filter(Boolean)
          )
        )
      : [];

    const hasDualTrackStream = Boolean(input.hasDualTrackStream);
    const hasNestedTablix = Boolean(input.hasNestedTablix);
    const hasStaircaseIndent = Boolean(input.hasStaircaseIndent);
    const xsdValidationPassed = Boolean(input.xsdValidationPassed);
    const sourcePageCount = Math.trunc(clampFinite(input.sourcePageCount, 1, 500, 1));
    const renderedPageCount = Math.trunc(clampFinite(input.renderedPageCount, 0, 500, sourcePageCount));

    const containers: ScanContainerSnapshot[] = Array.isArray(input.containers)
      ? input.containers.slice(0, 100).map((c, idx) => ({
          containerKey: sanitizeShortText(c?.containerKey, `C_${idx}`, 96),
          strategy: sanitizeShortText(c?.strategy, 'UNKNOWN', 64),
          topPt: clampFinite(c?.topPt, 0, 20000, 0),
          leftPt: clampFinite(c?.leftPt, 0, 20000, 0),
          widthPt: clampFinite(c?.widthPt, 0, 20000, 0),
          heightPt: clampFinite(c?.heightPt, 0, 20000, 0),
          colCount: Math.trunc(clampFinite(c?.colCount, 0, 128, 0)),
          rowCount: Math.trunc(clampFinite(c?.rowCount, 0, 2000, 0)),
          columnWidthsPt: Array.isArray(c?.columnWidthsPt)
            ? c.columnWidthsPt.slice(0, 128).map((w) => clampFinite(w, 0, 5000, 0))
            : [],
        }))
      : [];

    const diagnostics = Array.isArray(input.diagnostics)
      ? input.diagnostics
          .slice(0, 50)
          .map((d) => sanitizeShortText(d, '', 240))
          .filter(Boolean)
      : [];

    const featureInput: GeometricFeatureInput = {
      ...(input.features ?? {}),
      hasDualTrackStream,
      hasNestedTablix,
      hasStaircaseIndent,
      xsdValidationPassed,
      sourcePageCount,
      renderedPageCount,
    };

    const { rawFeatures, embedding: computedEmbedding } = extractGeometricFeatureVector(featureInput);
    const embedding =
      Array.isArray(input.customEmbedding) && input.customEmbedding.length > 0
        ? normalizeL2(input.customEmbedding.slice(0, VECTOR_DIM).map((v) => clampFinite(v, -100, 100, 0)))
        : computedEmbedding;

    const id = `vec_${crypto.randomBytes(6).toString('hex')}`;
    const record: VectorArtifactRecord = {
      id,
      documentTemplate,
      pageIndex,
      gateStage,
      appliedRules,
      hasDualTrackStream,
      hasNestedTablix,
      hasStaircaseIndent,
      xsdValidationPassed,
      renderedPageCount,
      sourcePageCount,
      embedding,
      rawFeatures,
      containers,
      diagnostics,
      createdAtIso: new Date().toISOString(),
    };

    this.records.push(record);
    if (this.records.length > MAX_ARTIFACTS_STORED) {
      this.records = this.records.slice(-MAX_ARTIFACTS_STORED);
    }
    this.persist();
    return record;
  }

  public getArtifact(id: string): VectorArtifactRecord | undefined {
    this.ensureLoaded();
    const safeId = sanitizeShortText(id, '', 64);
    return this.records.find((r) => r.id === safeId);
  }

  public listArtifacts(options?: {
    limit?: number;
    documentTemplate?: string;
    gateStage?: GateStage;
    pageIndex?: number;
  }): VectorArtifactRecord[] {
    this.ensureLoaded();
    const limit = Math.trunc(clampFinite(options?.limit, 1, 200, 50));
    const filtered = this.records.filter((rec) => {
      if (options?.documentTemplate && rec.documentTemplate !== options.documentTemplate) return false;
      if (options?.gateStage && rec.gateStage !== options.gateStage) return false;
      if (options?.pageIndex !== undefined && rec.pageIndex !== options.pageIndex) return false;
      return true;
    });
    return filtered.slice(-limit).reverse();
  }

  public searchSimilar(input: {
    features?: GeometricFeatureInput;
    embedding?: number[];
    topK?: number;
    documentTemplate?: string;
    gateStage?: GateStage;
    pageIndex?: number;
  }): VectorSearchResult[] {
    this.ensureLoaded();
    const topK = Math.trunc(clampFinite(input.topK, 1, 50, 5));
    const queryVec =
      Array.isArray(input.embedding) && input.embedding.length > 0
        ? normalizeL2(input.embedding.slice(0, VECTOR_DIM).map((v) => clampFinite(v, -100, 100, 0)))
        : extractGeometricFeatureVector(input.features ?? {}).embedding;

    const candidates = this.records.filter((rec) => {
      if (input.documentTemplate && rec.documentTemplate !== input.documentTemplate) return false;
      if (input.gateStage && rec.gateStage !== input.gateStage) return false;
      if (input.pageIndex !== undefined && rec.pageIndex !== input.pageIndex) return false;
      return true;
    });

    return candidates
      .map((artifact) => ({
        artifact,
        similarity: cosineSimilarity(queryVec, artifact.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  public computeRegressionDiff(baselineId: string, candidateId: string): RegressionDiffReport {
    const baseline = this.getArtifact(baselineId);
    if (!baseline) {
      throw new Error(`Baseline vector artifact '${sanitizeShortText(baselineId, '', 64)}' not found.`);
    }
    const candidate = this.getArtifact(candidateId);
    if (!candidate) {
      throw new Error(`Candidate vector artifact '${sanitizeShortText(candidateId, '', 64)}' not found.`);
    }

    const baseRules = new Set(baseline.appliedRules);
    const candRules = new Set(candidate.appliedRules);
    const addedRules = candidate.appliedRules.filter((r) => !baseRules.has(r));
    const removedRules = baseline.appliedRules.filter((r) => !candRules.has(r));

    const structuralFlagChanges: RegressionDiffReport['structuralFlagChanges'] = {};
    if (baseline.hasDualTrackStream !== candidate.hasDualTrackStream) {
      structuralFlagChanges.hasDualTrackStream = [baseline.hasDualTrackStream, candidate.hasDualTrackStream];
    }
    if (baseline.hasNestedTablix !== candidate.hasNestedTablix) {
      structuralFlagChanges.hasNestedTablix = [baseline.hasNestedTablix, candidate.hasNestedTablix];
    }
    if (baseline.hasStaircaseIndent !== candidate.hasStaircaseIndent) {
      structuralFlagChanges.hasStaircaseIndent = [baseline.hasStaircaseIndent, candidate.hasStaircaseIndent];
    }

    const maxContainers = Math.max(baseline.containers.length, candidate.containers.length);
    const containerDiffs: RegressionDiffReport['containerDiffs'] = [];
    for (let i = 0; i < maxContainers; i++) {
      const bc = baseline.containers[i];
      const cc = candidate.containers[i];
      if (!bc || !cc || bc.strategy !== cc.strategy || bc.colCount !== cc.colCount || bc.rowCount !== cc.rowCount) {
        containerDiffs.push({
          index: i,
          baselineStrategy: bc?.strategy,
          candidateStrategy: cc?.strategy,
          colCountDelta: (cc?.colCount ?? 0) - (bc?.colCount ?? 0),
          rowCountDelta: (cc?.rowCount ?? 0) - (bc?.rowCount ?? 0),
          maxTopDriftPt: Math.round(Math.abs((cc?.topPt ?? 0) - (bc?.topPt ?? 0)) * 100) / 100,
          maxWidthDriftPt: Math.round(Math.abs((cc?.widthPt ?? 0) - (bc?.widthPt ?? 0)) * 100) / 100,
        });
      }
    }

    return {
      baselineId: baseline.id,
      candidateId: candidate.id,
      pageParityDelta:
        (candidate.renderedPageCount - candidate.sourcePageCount) -
        (baseline.renderedPageCount - baseline.sourcePageCount),
      tablixCountDelta: candidate.containers.length - baseline.containers.length,
      xsdRegressed: baseline.xsdValidationPassed && !candidate.xsdValidationPassed,
      structuralFlagChanges,
      addedRules,
      removedRules,
      containerDiffs,
      embeddingCosineSimilarity: cosineSimilarity(baseline.embedding, candidate.embedding),
    };
  }
}

export const defaultVectorArtifactStore = new VectorArtifactStore();
