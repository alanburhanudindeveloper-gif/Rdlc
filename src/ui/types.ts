export interface FrontendLogEntry {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

export type VectorPrimitiveKind = 'HLine' | 'VLine' | 'FillBanner' | 'RowFillBand';

export interface FrontendVectorPrimitive {
  id: string;
  kind: VectorPrimitiveKind;
  x: number;
  y: number;
  width: number;
  height: number;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  colorHex?: string;
  source: 'rle' | 'vector' | 'merged';
}

export type SolverStrategy =
  | 'PLANAR_GRID_SOLVER'
  | 'KEY_VALUE_SUBGRID_FLATTENER'
  | 'DUAL_TRACK_STREAM_SOLVER'
  | 'INDENTATION_CLAUSE_SOLVER'
  | 'HLINE_OPERATOR_EQUATION_SOLVER'
  | 'DENSITY_TRANSITION_SPLITTER';

export interface ContainerGeometricSignature {
  internalVLineCount: number;
  shadedRowBandCount: number;
  hasEmbeddedSubGrid: boolean;
  indentationLevels: number;
  operatorColumnCount: number;
  columnDensityDrop: boolean;
}

export interface FrontendLayoutRegion {
  id: string;
  pageNumber: number;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  semanticRole: string;
  confidence: number;
  bandKind: string;
  isAmbiguous: boolean;
  ambiguityReason?: string;
  preferImageFallback?: boolean;
  linkedField?: string;
}

export interface FrontendBand {
  id: string;
  pageNumber: number;
  name: string;
  bandKind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  columnWidths: number[];
  rowHeights: number[];
  isRepeatingDetail: boolean;
  cells: Array<{
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
    primaryRegionId?: string;
    isMerged: boolean;
  }>;
}

export interface FrontendLayoutPage {
  pageNumber: number;
  width: number;
  height: number;
  rawObjectCount: number;
  regions: FrontendLayoutRegion[];
  bands: FrontendBand[];
  vectorPrimitives?: FrontendVectorPrimitive[];
  rasterPreviewBase64?: string;
}

export interface FrontendTablixRegion {
  id: string;
  name: string;
  pageNumber: number;
  sourcePageIndex?: number;
  bandKind: string;
  containerKey?: string;
  solverStrategy?: SolverStrategy;
  geometricSignature?: ContainerGeometricSignature;
  topIn: number;
  leftIn: number;
  widthIn: number;
  heightIn: number;
  isRepeatingDetail: boolean;
  columnWidthsIn: number[];
  rows: Array<{
    heightIn: number;
    isDetailRow: boolean;
    pageBreakBefore?: boolean;
    cells: Array<{
      colIndex: number;
      rowIndex: number;
      colSpan: number;
      rowSpan: number;
      skipBecauseMerged: boolean;
      content: {
        kind: string;
        name: string;
        value?: string;
        isExpression?: boolean;
        tablix?: FrontendTablixRegion;
        textboxes?: Array<{ name: string; text?: string }>;
        images?: Array<{ name: string }>;
      };
    }>;
  }>;
}

export interface CompilerWeights {
  baselineYTolPt: number;
  justifyGapRatio: number;
  markerGapRatio: number;
  spaceGapRatio: number;
  bannerLuminanceMax: number;
  fullWidthBannerRatio: number;
  minCenterGutterPt: number;
  hDividerMinWidthRatio: number;
  xClusterTolPt: number;
  yRowClusterTolPt: number;
  paragraphLeadingRatio: number;
  leftAnchorTolPt: number;
  charWidthFactor: number;
  lineHeightMultiplier: number;
  cellPadVerticalPt: number;
  cellPadHorizontalPt: number;
  sectionGapPt: number;
}

export const DEFAULT_FRONTEND_WEIGHTS: CompilerWeights = {
  baselineYTolPt: 1.5,
  justifyGapRatio: 1.8,
  markerGapRatio: 0.35,
  spaceGapRatio: 0.18,
  bannerLuminanceMax: 242,
  fullWidthBannerRatio: 0.7,
  minCenterGutterPt: 6,
  hDividerMinWidthRatio: 0.85,
  xClusterTolPt: 4,
  yRowClusterTolPt: 3.5,
  paragraphLeadingRatio: 1.65,
  leftAnchorTolPt: 5,
  charWidthFactor: 0.5,
  lineHeightMultiplier: 1.4,
  cellPadVerticalPt: 4,
  cellPadHorizontalPt: 4,
  sectionGapPt: 6,
};

export interface ContainerStrategyOverride {
  containerKey: string;
  pageNumber: number;
  strategy: SolverStrategy;
  xRangePt?: [number, number];
  yRangePt?: [number, number];
  reason?: string;
}

export type PageSpilloverCause =
  | 'NARROW_COLUMN_WRAP'
  | 'OVER_SPLIT_ROWS'
  | 'EXCESS_ROW_HEIGHT';

export interface PageParityDiagnostic {
  pageNumber: number;
  tablixName: string;
  containerKey?: string;
  cause: PageSpilloverCause;
  detail: string;
  renderedPageSpan?: number;
  compiledHeightPt?: number;
  availableBodyHeightPt?: number;
  repaired?: boolean;
}

export interface PageDensityOverride {
  pageNumber: number;
  cellPadVerticalPt?: number;
  lineHeightMultiplier?: number;
  minRowHeightPt?: number;
  sectionGapPt?: number;
  mergeOverSplitRows?: boolean;
  extendTrailingColSpan?: boolean;
}

export interface CalibrationConstraints {
  forbidColumnSplits: Array<{
    pageNumber: number;
    xMinPt: number;
    xMaxPt: number;
    yMinPt: number;
    yMaxPt: number;
  }>;
  forceTablixSplitsY: Array<{ pageNumber: number; yPt: number }>;
  forceRowSplitsY: Array<{ pageNumber: number; yPt: number }>;
  strategyOverrides?: ContainerStrategyOverride[];
  pageOverrides?: PageDensityOverride[];
  splitTwinSubTables?: Array<{
    pageNumber: number;
    yMinPt: number;
    yMaxPt: number;
    gutterXPt: number;
  }>;
  forceUnifiedTableBands?: Array<{
    pageNumber: number;
    yMinPt: number;
    yMaxPt: number;
  }>;
}

export interface CalibrationLossBreakdown {
  totalLoss: number;
  overlapCount: number;
  clippedRowCount: number;
  slicedTextCount: number;
  columnBleedCount: number;
  rowOverlapCount: number;
  pageSpilloverCount?: number;
  meanDeltaY: number;
  meanLineCountDelta: number;
  pixelDiffRatio: number;
  validationErrorsCount: number;
  pageParityDiagnostics?: PageParityDiagnostic[];
}

export interface CalibrationRoundTrace {
  round: number;
  totalLoss: number;
  jointLoss: number;
  deltaLoss: number;
  overlapCount: number;
  clippedRowCount: number;
  slicedTextCount: number;
  meanDeltaY: number;
  meanLineCountDelta: number;
  pixelDiffRatio: number;
  switchedStrategies?: ContainerStrategyOverride[];
  actionSummary: string;
}

export interface CalibrationRunSummary {
  converged: boolean;
  iterationsRun: number;
  initialLoss: number;
  finalLoss: number;
  initialJointLoss: number;
  finalJointLoss: number;
  weights: CompilerWeights;
  constraints: CalibrationConstraints;
  lossBreakdown: CalibrationLossBreakdown;
  rounds: CalibrationRoundTrace[];
}

export interface PinnedCalibrationDoc {
  id: string;
  documentName: string;
  pinnedAt: string;
  pageCount: number;
  lastLoss: number;
  layoutModel: FrontendPipelineResult['layoutModel'];
}

export interface CalibrationCheckpoint {
  version: number;
  updatedAt: string;
  weights: CompilerWeights;
  constraints: CalibrationConstraints;
  pinnedCorpus: Array<{
    id: string;
    documentName: string;
    pinnedAt: string;
    pageCount: number;
    lastLoss: number;
  }>;
}

export interface FrontendPipelineResult {
  runId: string;
  documentName: string;
  layoutModel: {
    document: {
      name: string;
      pageCount: number;
      pageWidth: number;
      pageHeight: number;
      unit: string;
      extractedAt: string;
    };
    pages: FrontendLayoutPage[];
  };
  existingPattern?: {
    sourceFiles: string[];
    dataSourceName: string;
    dataSetName: string;
    fields: string[];
    parameters: string[];
    vbClassName?: string;
    vbNamespace?: string;
    vbFunctions: Array<{ name: string; signature: string; bodyPreview: string }>;
    conventions: string[];
  };
  rdlcSha256?: string;
  rdlcSchemaVersion?: '2008' | '2016';
  conversionMetrics?: {
    textboxes: number;
    tablixes: number;
    nestedTablixes?: number;
    layer0Pages: number;
    glyphFallbacks: number;
    deduplicatedFakeBold: number;
    parameters: number;
    sectionsCount?: number;
    dualColumnSections?: number;
    printOnFirstPage?: boolean;
    nativeHeaderPresent?: boolean;
    nativeFooterPresent?: boolean;
    collisionsCount?: number;
    clippedRowsCount?: number;
    renderedPageCount?: number;
    sourcePageCount?: number;
    pageSpilloverCount?: number;
    pageParityDiagnostics?: PageParityDiagnostic[];
  };
  reportDefinition: {
    reportName: string;
    dataSourceName: string;
    dataSetName: string;
    pageWidthIn: number;
    pageHeightIn: number;
    marginsIn?: { top: number; right: number; bottom: number; left: number };
    fields: Array<{ name: string; dataType: string; sampleValue: string | number; isCalculated: boolean }>;
    parameters: Array<{ name: string; dataType: string; prompt: string; defaultValue?: string; matchedPattern?: string; pageNumber?: number }>;
    calculations: Array<{ functionName: string; targetField: string; expressionSummary: string }>;
    tablixRegions: FrontendTablixRegion[];
    bodyTablixes?: FrontendTablixRegion[];
    hierarchy?: {
      mode: 'v3-full-tablix-single-rdlc' | 'v2-hierarchical-single-rdlc';
      pageHeader?: {
        heightIn: number;
        printOnFirstPage: boolean;
        printOnLastPage: boolean;
        assetCount: number;
        textLabels: string[];
      };
      pageFooter?: {
        heightIn: number;
        printOnFirstPage: boolean;
        printOnLastPage: boolean;
        assetCount: number;
        textLabels: string[];
      };
      sections: Array<{
        name: string;
        slug: string;
        pageNumber: number;
        pageBreakStart: boolean;
        topIn: number;
        leftIn: number;
        widthIn: number;
        heightIn: number;
        layoutType:
          | 'Single-Column'
          | 'Dual-Column'
          | 'Multi-Column'
          | 'Tablix'
          | 'Clause-List'
          | 'Hybrid-Callout';
        containerKey?: string;
        solverStrategy?: SolverStrategy;
        geometricSignature?: ContainerGeometricSignature;
        rowCount?: number;
        colCount?: number;
        hasNestedTablixes?: boolean;
        columnCount?: number;
        hasHeaderBand: boolean;
        hasLeftColumn: boolean;
        hasRightColumn: boolean;
        hasFooterBand: boolean;
        childItemCount: number;
      }>;
    };
    bodySections?: Array<{
      name: string;
      leftIn: number;
      topIn: number;
      widthIn: number;
      heightIn: number;
      pageNumber?: number;
      role?: string;
      children?: {
        rectangles: Array<{
          name: string;
          leftIn: number;
          topIn: number;
          widthIn: number;
          heightIn: number;
          role?: string;
        }>;
      };
    }>;
  };
  rdlcXml: string;
  vbCode: string;
  dummyJson: Record<string, unknown>;
  rdlcValidation: {
    valid: boolean;
    checkedRules: number;
    errors: Array<{ ruleId: string; severity: string; message: string; location?: string }>;
    warnings: Array<{ ruleId: string; severity: string; message: string; location?: string }>;
  };
  logicTests: {
    status: 'PASS' | 'FAIL' | 'SKIPPED';
    total: number;
    passed: number;
    failed: number;
    ambiguousOracleWarnings: string[];
    cases: Array<{
      scenario: string;
      functionName: string;
      inputs: Record<string, number | string>;
      expected: number;
      actual: number;
      tolerance: number;
      passed: boolean;
      error?: string;
    }>;
  };
  renderStatus: {
    executed: boolean;
    engine: string;
    status: string;
    message: string;
  };
  visualDiff?: {
    available: boolean;
    targetSimilarity: number;
    overallSimilarity: number;
    overallParityPercent?: number;
    meanAbsoluteError?: number;
    note: string;
    pages: Array<{
      page: number;
      similarity: number;
      parityPercent?: number;
      meanAbsoluteError?: number;
      mismatchPixels: number;
      totalPixels: number;
      diffImageBase64?: string;
      originalImageBase64?: string;
      comparedImageBase64?: string;
    }>;
  };
  logs: FrontendLogEntry[];
  finalized: boolean;
  agentIterations: number;
  calibrationSummary?: CalibrationRunSummary;
}

export interface MlTrainingEpoch {
  epoch: number;
  ssimParityPercent: number;
  boxIouPercent: number;
  sourcePageCount: number;
  renderedPageCount: number;
  overlapCount: number;
  clippedRowCount: number;
  loss: number;
  action: string;
}

export interface MlEngineStatus {
  available: boolean;
  installedPackages: Record<string, boolean>;
  missingPackages: string[];
  checkpointPath?: string;
  checkpointExists: boolean;
  historyCount?: number;
  recentHistory?: MlTrainingEpoch[];
  error?: string;
}

export interface MlRunSummary {
  mode: string;
  converged: boolean;
  continualAdapted?: boolean;
  checkpointLoaded?: boolean;
  targetSsim: number;
  bestSsim: number;
  bestLoss: number;
  epochsRun: number;
  epochs: MlTrainingEpoch[];
  ocrEngine?: string;
  pipelineResult?: FrontendPipelineResult;
}

