export enum ReportGenErrorCode {
  PDF_ANALYSIS_FAILED = 'PDF_ANALYSIS_FAILED',
  LAYOUT_RECONSTRUCTION_FAILED = 'LAYOUT_RECONSTRUCTION_FAILED',
  RDLC_GENERATION_FAILED = 'RDLC_GENERATION_FAILED',
  VB_GENERATION_FAILED = 'VB_GENERATION_FAILED',
  LOGIC_TEST_FAILED = 'LOGIC_TEST_FAILED',
  RDLC_RENDER_FAILED = 'RDLC_RENDER_FAILED',
  VISUAL_VALIDATION_FAILED = 'VISUAL_VALIDATION_FAILED',
  PROJECT_INTEGRATION_FAILED = 'PROJECT_INTEGRATION_FAILED',
  SECURITY_VIOLATION = 'SECURITY_VIOLATION',
  TECHNOLOGY_DETECTION_FAILED = 'TECHNOLOGY_DETECTION_FAILED',
  VB_PARSE_FAILED = 'VB_PARSE_FAILED',
  BENCHMARK_NOT_FOUND = 'BENCHMARK_NOT_FOUND',
  RDLC_REFERENCE_UNRESOLVED = 'RDLC_REFERENCE_UNRESOLVED',
  INSERT_COLLISION = 'INSERT_COLLISION',
  APPROVAL_REQUIRED = 'APPROVAL_REQUIRED',
}

export class ReportGenError extends Error {
  public readonly code: ReportGenErrorCode;
  public readonly details?: unknown;

  constructor(code: ReportGenErrorCode, message: string, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'ReportGenError';
    this.code = code;
    this.details = details;
  }
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

export class StructuredLogger {
  private readonly entries: LogEntry[] = [];
  private readonly echoToConsole: boolean;

  constructor(echoToConsole = true) {
    this.echoToConsole = echoToConsole;
  }

  public log(level: LogLevel, stage: string, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      stage,
      message,
      data,
    };
    this.entries.push(entry);
    if (this.echoToConsole) {
      const suffix = data ? ` ${JSON.stringify(data)}` : '';
      console.log(`[${level}] ${message}${suffix}`);
    }
  }

  public info(stage: string, message: string, data?: Record<string, unknown>): void {
    this.log('INFO', stage, message, data);
  }

  public warn(stage: string, message: string, data?: Record<string, unknown>): void {
    this.log('WARN', stage, message, data);
  }

  public error(stage: string, message: string, data?: Record<string, unknown>): void {
    this.log('ERROR', stage, message, data);
  }

  public getEntries(): LogEntry[] {
    return [...this.entries];
  }
}

export type RegionType =
  | 'text'
  | 'image'
  | 'vector_line'
  | 'vector_rect'
  | 'vector_complex'
  | 'table';

export type SemanticRole =
  | 'reportTitle'
  | 'sectionHeading'
  | 'fieldLabel'
  | 'fieldValue'
  | 'tableHeader'
  | 'tableCell'
  | 'cardContainer'
  | 'timelineStep'
  | 'numberedListItem'
  | 'paragraph'
  | 'headerText'
  | 'footerText'
  | 'logoOrGraphic'
  | 'calculationField'
  | 'unknown';

export type BandKind =
  | 'Header'
  | 'Information'
  | 'Detail'
  | 'Cards'
  | 'Timeline'
  | 'Notes'
  | 'Footer';

export interface CellBorderEdge {
  color?: string;
  style: 'Solid' | 'None';
  widthPt?: number;
}

export interface RegionStyle {
  fontFamily: string;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  underline?: boolean;
  color: string;
  backgroundColor?: string;
  borderColor?: string;
  borderWidthPt?: number;
  borderEdges?: {
    top?: CellBorderEdge;
    bottom?: CellBorderEdge;
    left?: CellBorderEdge;
    right?: CellBorderEdge;
  };
  textAlign: 'Left' | 'Center' | 'Right';
  verticalAlign: 'Top' | 'Middle' | 'Bottom';
  lineHeightPt?: number;
  paddingPt: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

export interface VisualTextRun {
  text: string;
  fontFamily: string;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  underline?: boolean;
  color: string;
  parameterName?: string;
}

export interface LayoutRegion {
  id: string;
  pageNumber: number;
  type: RegionType;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  runs?: VisualTextRun[];
  style: RegionStyle;
  semanticRole: SemanticRole;
  confidence: number;
  bandKind: BandKind;
  isAmbiguous: boolean;
  ambiguityReason?: string;
  preferImageFallback?: boolean;
  imageAssetBase64?: string;
  imageAssetName?: string;
  sourceObjectRefs: string[];
  linkedField?: string;
  expression?: string;
}

export interface GridCellAssignment {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  regionIds: string[];
  primaryRegionId?: string;
  isMerged: boolean;
  isOverlapping: boolean;
}

export interface ReconstructedBand {
  id: string;
  pageNumber: number;
  name: string;
  bandKind: BandKind;
  x: number;
  y: number;
  width: number;
  height: number;
  columnBoundaries: number[];
  rowBoundaries: number[];
  columnWidths: number[];
  rowHeights: number[];
  cells: GridCellAssignment[];
  isRepeatingDetail: boolean;
  sourceRegionIds: string[];
}

export type VectorPrimitiveKind = 'HLine' | 'VLine' | 'FillBanner' | 'RowFillBand';

export interface ExtractedVectorPrimitive {
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

export interface PerceivedGeometricContainer {
  containerKey: string;
  pageNumber: number;
  x0Pt: number;
  y0Pt: number;
  x1Pt: number;
  y1Pt: number;
  features: number[];
  featureNames?: string[];
  geometricSignature?: ContainerGeometricSignature;
  spanCount: number;
  vLineCount: number;
  hLineCount: number;
}

export interface LayoutPage {
  pageNumber: number;
  width: number;
  height: number;
  rawObjectCount: number;
  regions: LayoutRegion[];
  bands: ReconstructedBand[];
  vectorPrimitives?: ExtractedVectorPrimitive[];
  geometricContainers?: PerceivedGeometricContainer[];
  rasterPreviewBase64?: string;
  layer0BackgroundBase64?: string;
  layer0ImageName?: string;
  brokenGlyphRegions?: number;
  deduplicatedSpans?: number;
}

export interface IntermediateLayoutModel {
  document: {
    name: string;
    pageCount: number;
    pageWidth: number;
    pageHeight: number;
    unit: 'inch';
    extractedAt: string;
    extractionMode?: 'digital-vector' | 'raster-fallback';
  };
  pages: LayoutPage[];
}

export interface TablixTextboxContent {
  kind: 'Textbox';
  name: string;
  value: string;
  runs?: VisualTextRun[];
  paragraphLines?: VisualParagraphSpec[];
  isExpression: boolean;
  style: RegionStyle;
  canGrow: boolean;
  sourceLineCount?: number;
  sourceX0In?: number;
  sourceWidthIn?: number;
  sourceYMinPt?: number;
  sourceYMaxPt?: number;
}

export interface TablixImageContent {
  kind: 'Image';
  name: string;
  mimeType: string;
  base64Data: string;
  sizing: 'FitProportional' | 'Fit' | 'Clip';
}

export interface TablixEmptyContent {
  kind: 'Empty';
  name: string;
  style?: Partial<RegionStyle>;
}

export interface TablixNestedContent {
  kind: 'Tablix';
  name: string;
  tablix: TablixRegion;
  style?: Partial<RegionStyle>;
}

export interface TablixRectangleContent {
  kind: 'Rectangle';
  name: string;
  style?: Partial<RegionStyle>;
  rectangles: VisualRectItem[];
  images: VisualImageItem[];
  textboxes: VisualTextboxItem[];
  tablixes: TablixRegion[];
}

export type TablixCellContent =
  | TablixTextboxContent
  | TablixImageContent
  | TablixEmptyContent
  | TablixNestedContent
  | TablixRectangleContent;

export interface TablixCell {
  colIndex: number;
  rowIndex: number;
  colSpan: number;
  rowSpan: number;
  skipBecauseMerged: boolean;
  content: TablixCellContent;
}

export interface TablixRow {
  heightIn: number;
  isDetailRow: boolean;
  pageBreakBefore?: boolean;
  cells: TablixCell[];
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

export interface TablixRegion {
  id: string;
  name: string;
  pageNumber: number;
  sourcePageIndex?: number;
  bandKind: BandKind;
  slug?: string;
  containerKey?: string;
  solverStrategy?: SolverStrategy;
  geometricSignature?: ContainerGeometricSignature;
  pageBreakBefore?: boolean;
  keepTogether?: boolean;
  topIn: number;
  leftIn: number;
  widthIn: number;
  heightIn: number;
  dataSetName?: string;
  isRepeatingDetail: boolean;
  columnWidthsIn: number[];
  rows: TablixRow[];
  zIndex?: number;
}

export interface ReportFieldDef {
  name: string;
  dataType: 'System.String' | 'System.Decimal' | 'System.Int32' | 'System.DateTime';
  sampleValue: string | number;
  isCalculated: boolean;
  formulaDescription?: string;
}

export interface ReportParameterDef {
  name: string;
  dataType: 'String' | 'Integer' | 'Float' | 'DateTime' | 'Boolean';
  prompt: string;
  defaultValue?: string;
  matchedPattern?: string;
  pageNumber?: number;
}

export interface CalculationRuleDef {
  functionName: string;
  targetField: string;
  inputs: string[];
  operation: 'multiply' | 'subtract_percent' | 'sum' | 'tax' | 'custom_linear';
  expressionSummary: string;
  vbImplementation: string;
}

export interface VisualRectItem {
  kind: 'Rectangle';
  name: string;
  leftIn: number;
  topIn: number;
  widthIn: number;
  heightIn: number;
  backgroundColor?: string;
  borderColor?: string;
  borderWidthPt?: number;
  zIndex?: number;
  role?: 'section' | 'leftColumn' | 'rightColumn' | 'headerBand' | 'footerBand' | 'fill' | 'line' | 'pageContainer';
  pageNumber?: number;
  pageBreakLocation?: 'Start' | 'End';
  keepTogether?: boolean;
  children?: {
    rectangles: VisualRectItem[];
    images: VisualImageItem[];
    textboxes: VisualTextboxItem[];
    tablixes: TablixRegion[];
  };
}

export interface VisualImageItem {
  kind: 'Image';
  name: string;
  embeddedImageName: string;
  leftIn: number;
  topIn: number;
  widthIn: number;
  heightIn: number;
  sizing: 'FitProportional' | 'Fit' | 'Clip';
  zIndex?: number;
}

export interface VisualParagraphSpec {
  runs: VisualTextRun[];
  lineHeightPt?: number;
  textAlign?: 'Left' | 'Center' | 'Right';
}

export interface VisualTextboxItem {
  kind: 'Textbox';
  name: string;
  leftIn: number;
  topIn: number;
  widthIn: number;
  heightIn: number;
  text: string;
  runs?: VisualTextRun[];
  paragraphLines?: VisualParagraphSpec[];
  style: RegionStyle;
  canGrow?: boolean;
  zIndex?: number;
}

export interface VisualPageLayer {
  pageNumber: number;
  widthIn: number;
  heightIn: number;
  rectangles: VisualRectItem[];
  images: VisualImageItem[];
  textboxes: VisualTextboxItem[];
  tablixes: TablixRegion[];
}

export interface RdlcBandContainerSpec {
  kind: 'PageHeader' | 'PageFooter';
  heightIn: number;
  printOnFirstPage?: boolean;
  printOnLastPage?: boolean;
  rectangles: VisualRectItem[];
  images: VisualImageItem[];
  textboxes: VisualTextboxItem[];
  tablixes: TablixRegion[];
}

export interface LayoutSectionSummary {
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
  rowCount?: number;
  colCount?: number;
  hasNestedTablixes?: boolean;
  columnCount?: number;
  hasHeaderBand: boolean;
  hasLeftColumn: boolean;
  hasRightColumn: boolean;
  hasFooterBand: boolean;
  childItemCount: number;
  containerKey?: string;
  solverStrategy?: SolverStrategy;
  geometricSignature?: ContainerGeometricSignature;
}

export interface RdlcDocumentHierarchy {
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
  sections: LayoutSectionSummary[];
}

export interface ReportDefinition {
  reportName: string;
  dataSourceName: string;
  dataSetName: string;
  pageWidthIn: number;
  pageHeightIn: number;
  marginsIn: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  fields: ReportFieldDef[];
  parameters: ReportParameterDef[];
  calculations: CalculationRuleDef[];
  tablixRegions: TablixRegion[];
  embeddedImages: Array<{ name: string; mimeType: string; base64Data: string }>;
  existingPatternUsed?: string;
  visualPages?: VisualPageLayer[];
  pageHeaderSpec?: RdlcBandContainerSpec;
  pageFooterSpec?: RdlcBandContainerSpec;
  bodyTablixes?: TablixRegion[];
  bodySections?: VisualRectItem[];
  hierarchy?: RdlcDocumentHierarchy;
  sampleDetailRows?: Array<Record<string, string | number>>;
}

export interface ExistingProjectPattern {
  sourceFiles: string[];
  dataSourceName: string;
  dataSetName: string;
  fields: string[];
  parameters: string[];
  vbClassName?: string;
  vbNamespace?: string;
  vbFunctions: Array<{ name: string; signature: string; bodyPreview: string }>;
  expressions: string[];
  conventions: string[];
}

export interface RdlcValidationDiagnostic {
  ruleId: string;
  severity: 'ERROR' | 'WARN';
  message: string;
  location?: string;
}

export interface RdlcValidationResult {
  valid: boolean;
  checkedRules: number;
  errors: RdlcValidationDiagnostic[];
  warnings: RdlcValidationDiagnostic[];
}

export interface LogicTestCase {
  scenario: string;
  inputs: Record<string, number | string>;
  expectedField: string;
  expectedValue: number;
  tolerance: number;
  source: 'excel' | 'json' | 'generated';
}

export interface LogicTestCaseResult {
  scenario: string;
  functionName: string;
  inputs: Record<string, number | string>;
  expected: number;
  actual: number;
  tolerance: number;
  passed: boolean;
  error?: string;
}

export interface LogicTestSummary {
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  total: number;
  passed: number;
  failed: number;
  cases: LogicTestCaseResult[];
  ambiguousOracleWarnings: string[];
}

export interface VisualDiffPageResult {
  page: number;
  similarity: number;
  parityPercent: number;
  meanAbsoluteError: number;
  mismatchPixels: number;
  totalPixels: number;
  diffImageBase64?: string;
  originalImageBase64?: string;
  comparedImageBase64?: string;
}

export interface VisualDiffReport {
  available: boolean;
  targetSimilarity: number;
  overallSimilarity: number;
  overallParityPercent: number;
  meanAbsoluteError: number;
  note: string;
  pages: VisualDiffPageResult[];
}

export interface RenderStatus {
  executed: boolean;
  engine: 'ReportViewer' | 'Unavailable';
  status: 'RENDERED' | 'NOT_VERIFIED_IN_ENVIRONMENT';
  message: string;
  renderedPdfPath?: string;
}

export interface ConversionMetrics {
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

export const DEFAULT_COMPILER_WEIGHTS: CompilerWeights = {
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

export interface ForbidColumnSplitConstraint {
  pageNumber: number;
  xMinPt: number;
  xMaxPt: number;
  yMinPt: number;
  yMaxPt: number;
}

export interface ForceSplitYConstraint {
  pageNumber: number;
  yPt: number;
}

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

export interface SplitTwinSubTableConstraint {
  pageNumber: number;
  yMinPt: number;
  yMaxPt: number;
  gutterXPt: number;
}

export interface ForceUnifiedTableBandConstraint {
  pageNumber: number;
  yMinPt: number;
  yMaxPt: number;
}

export interface CalibrationConstraints {
  forbidColumnSplits: ForbidColumnSplitConstraint[];
  forceTablixSplitsY: ForceSplitYConstraint[];
  forceRowSplitsY: ForceSplitYConstraint[];
  strategyOverrides?: ContainerStrategyOverride[];
  pageOverrides?: PageDensityOverride[];
  splitTwinSubTables?: SplitTwinSubTableConstraint[];
  forceUnifiedTableBands?: ForceUnifiedTableBandConstraint[];
}

export interface OffendingContainerHint {
  containerKey: string;
  tablixName: string;
  pageNumber: number;
  issue: 'TEXT_SLICED' | 'COLUMN_BLEED' | 'ROW_OVERLAP';
  currentStrategy?: SolverStrategy;
}

export interface CalibrationLossBreakdown {
  totalLoss: number;
  overlapCount: number;
  clippedRowCount: number;
  slicedTextCount: number;
  columnBleedCount: number;
  rowOverlapCount: number;
  pageSpilloverCount: number;
  meanDeltaY: number;
  meanLineCountDelta: number;
  pixelDiffRatio: number;
  validationErrorsCount: number;
  pageParityDiagnostics?: PageParityDiagnostic[];
  diagnosticHints: {
    slicedBoxes: ForbidColumnSplitConstraint[];
    bleedSplitsY: ForceSplitYConstraint[];
    collisionSplitsY: ForceSplitYConstraint[];
    offendingContainers: OffendingContainerHint[];
    twinSubTableSplits?: SplitTwinSubTableConstraint[];
    unifiedTableBands?: ForceUnifiedTableBandConstraint[];
  };
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

export interface PinnedCalibrationDoc {
  id: string;
  documentName: string;
  pinnedAt: string;
  pageCount: number;
  lastLoss: number;
  layoutModel: IntermediateLayoutModel;
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

export interface PipelineRunResult {
  runId: string;
  documentName: string;
  layoutModel: IntermediateLayoutModel;
  existingPattern?: ExistingProjectPattern;
  reportDefinition: ReportDefinition;
  rdlcXml: string;
  rdlcSha256: string;
  rdlcSchemaVersion: '2008' | '2016';
  vbCode: string;
  dummyJson: Record<string, unknown>;
  rdlcValidation: RdlcValidationResult;
  logicTests: LogicTestSummary;
  renderStatus: RenderStatus;
  visualDiff?: VisualDiffReport;
  conversionMetrics: ConversionMetrics;
  logs: LogEntry[];
  finalized: boolean;
  agentIterations: number;
  calibrationSummary?: CalibrationRunSummary;
}
