import crypto from 'crypto';
import {
  calibratePipeline,
  enforceOneToOnePageParity,
} from '../calibration/calibrationEngine.ts';
import {
  CalibrationConstraints,
  CalibrationRunSummary,
  CompilerWeights,
  ExistingProjectPattern,
  IntermediateLayoutModel,
  LogicTestCase,
  PinnedCalibrationDoc,
  PipelineRunResult,
  StructuredLogger,
} from '../core/types.ts';
import { ReportGenServices } from '../mcp/mcpTools.ts';
import { RdlcValidator } from '../rdlc/rdlcValidator.ts';

export interface AgentRunInput {
  documentName: string;
  pdfBytes: Uint8Array;
  existingRdlcXml?: string;
  existingRdlcFileName?: string;
  existingVbSource?: string;
  existingVbFileName?: string;
  excelBytes?: Buffer;
  customJsonTestCases?: LogicTestCase[];
  comparisonPdfBytes?: Uint8Array;
  schemaVersion?: '2008' | '2016';
  weights?: Partial<CompilerWeights>;
  calibrationConstraints?: CalibrationConstraints;
  autoCalibrate?: boolean;
  pinnedDocs?: PinnedCalibrationDoc[];
  preAnalyzedLayout?: IntermediateLayoutModel;
}

/**
 * Deterministic Zero-AI Orchestrator:
 * - Bounded validation gate (RDLC 10-point validation + VB Logic test gate)
 * - Dual-Layer Hybrid + Repeating Tablix conversion
 * - Self-verifying Ghostscript + pixelmatch parity check (Original PDF vs Rendered RDLC PDF)
 */
export class ReportGenAgent {
  private readonly services: ReportGenServices;
  private readonly logger: StructuredLogger;

  constructor(services: ReportGenServices) {
    this.services = services;
    this.logger = services.logger;
  }

  public async execute(input: AgentRunInput): Promise<PipelineRunResult> {
    const runId = crypto
      .createHash('sha256')
      .update(`${input.documentName}:${input.pdfBytes.byteLength}`)
      .digest('hex')
      .slice(0, 8);
    const { config } = this.services;

    // Step 1: Analyze PDF deterministically (includes Layer 0 text-stripped backgrounds & broken glyph crops)
    const rawLayout = input.preAnalyzedLayout
      ? input.preAnalyzedLayout
      : await this.services.pdfAnalyzer.analyzeBuffer(
          input.pdfBytes,
          input.documentName,
          config.pdf.dpi,
          input.weights
        );

    // Step 2: Inspect existing RDLC/VB project artifacts if provided
    let existingPattern: ExistingProjectPattern | undefined;
    if (input.existingRdlcXml || input.existingVbSource) {
      existingPattern = this.services.projectInspector.inspect({
        rdlcXml: input.existingRdlcXml,
        rdlcFileName: input.existingRdlcFileName,
        vbSource: input.existingVbSource,
        vbFileName: input.existingVbFileName,
      });
    }

    // Step 3: Reconstruct deterministic coordinate grids & bands
    const layoutModel = input.preAnalyzedLayout
      ? input.preAnalyzedLayout
      : this.services.gridReconstructor.reconstruct(
          rawLayout,
          config.pdf.coordinateTolerance
        );

    // Step 4: Deterministic Flat-2008 or Shared-Layer-1-4 2016 Tablix generation & optional CEGIS calibration
    const schemaVersion: '2008' | '2016' = input.schemaVersion === '2016' ? '2016' : '2008';
    const is2008 = schemaVersion === '2008';
    const rdlcValidator = new RdlcValidator(this.logger);
    let activeWeights = input.weights;
    let activeConstraints = input.calibrationConstraints;
    let calibrationSummary: CalibrationRunSummary | undefined;

    const prelimDefForDummy = this.services.tablixBuilder.buildReportDefinition(
      layoutModel,
      existingPattern,
      {
        schemaVersion,
        weights: activeWeights,
        calibrationConstraints: activeConstraints,
      }
    );
    const prelimDummy = this.services.excelOracle.generateDummyJson(prelimDefForDummy);

    if (input.autoCalibrate) {
      calibrationSummary = calibratePipeline({
        layoutModel,
        schemaVersion,
        initialWeights: activeWeights,
        initialConstraints: activeConstraints,
        pinnedDocs: input.pinnedDocs,
        existingPattern,
        dummyJson: prelimDummy,
        logger: this.logger,
      });
      activeWeights = calibrationSummary.weights;
      activeConstraints = calibrationSummary.constraints;
    }

    const parityResult = enforceOneToOnePageParity({
      layoutModel,
      schemaVersion,
      existingPattern,
      weights: activeWeights,
      calibrationConstraints: activeConstraints,
      dummyJson: prelimDummy,
      logger: this.logger,
    });
    activeWeights = parityResult.weights;
    activeConstraints = parityResult.constraints;

    let iterations = 0;
    let reportDefinition = parityResult.reportDef;
    let vbArtifacts = this.services.vbGenerator.generate(reportDefinition, existingPattern);
    let rdlcXml = this.services.rdlcGenerator.generate(
      reportDefinition,
      vbArtifacts.embeddedRdlcCode,
      { schemaVersion }
    );
    let rdlcValidation = rdlcValidator.validate(rdlcXml, { requireRdlc2008: is2008 });

    while (!rdlcValidation.valid && iterations < config.validation.maxAgentIterations - 1) {
      iterations++;
      this.logger.warn('DeterministicGate', `Validation gate triggered retry iteration ${iterations}`);
      reportDefinition = this.services.tablixBuilder.buildReportDefinition(
        layoutModel,
        existingPattern,
        {
          schemaVersion,
          weights: activeWeights,
          calibrationConstraints: activeConstraints,
        }
      );
      vbArtifacts = this.services.vbGenerator.generate(reportDefinition, existingPattern);
      rdlcXml = this.services.rdlcGenerator.generate(
        reportDefinition,
        vbArtifacts.embeddedRdlcCode,
        { schemaVersion }
      );
      rdlcValidation = rdlcValidator.validate(rdlcXml, { requireRdlc2008: is2008 });
    }

    const rdlcSha256 = crypto.createHash('sha256').update(rdlcXml, 'utf-8').digest('hex');

    // Step 5: Excel Oracle / Dummy JSON & VB Logic Tests
    const dummyJson = this.services.excelOracle.generateDummyJson(reportDefinition);
    let externalCases: LogicTestCase[] = input.customJsonTestCases ?? [];
    let ambiguousOracleWarnings: string[] = [];

    if (input.excelBytes) {
      const excelResult = this.services.excelOracle.readBuffer(input.excelBytes);
      externalCases = [...excelResult.testCases, ...externalCases];
      ambiguousOracleWarnings = excelResult.ambiguousWarnings;
    }

    const logicTests = this.services.logicTestRunner.run(
      vbArtifacts.fullVbClass,
      reportDefinition,
      externalCases,
      ambiguousOracleWarnings
    );

    // Step 6: External ReportViewer status (honestly reports unavailable on Linux) + built-in RDLC HTML & PDF render
    const renderStatus = await this.services.renderer.renderToPdf(rdlcXml);
    const previewHtml = this.services.rdlcPreviewRenderer.renderHtml(rdlcXml, {
      title: input.documentName,
      sampleFields: dummyJson,
    });
    const renderedPdfBytes = await this.services.rdlcPreviewRenderer.renderPdf(rdlcXml, {
      title: input.documentName,
      sampleFields: dummyJson,
    });

    // Step 7: Visual parity comparison (Original PDF vs Rendered RDLC PDF or supplied comparisonPdf)
    const comparisonTarget = input.comparisonPdfBytes ?? renderedPdfBytes;
    const visualDiff =
      input.pdfBytes.byteLength > 0
        ? await this.services.visualDiff.comparePdfs(
            input.pdfBytes,
            comparisonTarget,
            config.validation.visualSimilarityTarget,
            undefined,
            config.pdf.dpi
          )
        : {
            available: false,
            targetSimilarity: config.validation.visualSimilarityTarget ?? 0.95,
            overallSimilarity: 0,
            overallParityPercent: 0,
            meanAbsoluteError: 0,
            note: 'Skipped visual diff: original PDF buffer not provided.',
            pages: [],
          };

    // Final Validation Gate: validate XML structure + runtime 1:1 page parity, 0 collisions, 0 clipped rows
    const targetPct = Math.round((config.validation.visualSimilarityTarget ?? 0.95) * 10000) / 100;
    const pageSpilloverSummary = previewHtml.pageSpillovers.map(
      (s) =>
        `P${s.sourcePage}->${s.renderedPages}pp (${s.compiledHeightPt.toFixed(0)}/${s.availableBodyHeightPt.toFixed(0)}pt)`
    );
    rdlcValidation = rdlcValidator.validate(rdlcXml, {
      requireRdlc2008: is2008,
      context: {
        sourcePageCount: layoutModel.document.pageCount,
        renderedPageCount: previewHtml.pageCount,
        collisionsCount: previewHtml.collisions.length,
        clippedRowsCount: previewHtml.clippedRows.length,
        pageSpilloverCount: previewHtml.pageSpillovers.length,
        pageSpilloverSummary,
        perPageParity: visualDiff.available
          ? visualDiff.pages.map((p) => ({ page: p.page, parityPercent: p.parityPercent }))
          : undefined,
        targetParityPercent: targetPct,
        deterministicShaMatch: true,
      },
    });

    const countRectTree = (rect: {
      children?: {
        rectangles: typeof reportDefinition.bodySections;
        textboxes: unknown[];
        tablixes: unknown[];
      };
    }): { textboxes: number; tablixes: number } => {
      if (!rect.children) return { textboxes: 0, tablixes: 0 };
      let tb = rect.children.textboxes.length;
      let tx = rect.children.tablixes.length;
      for (const sub of rect.children.rectangles ?? []) {
        const subCount = countRectTree(sub);
        tb += subCount.textboxes;
        tx += subCount.tablixes;
      }
      return { textboxes: tb, tablixes: tx };
    };

    const countTablixTree = (
      tbl: NonNullable<typeof reportDefinition.bodyTablixes>[number],
      isNested = false
    ): { textboxes: number; tablixes: number; nestedTablixes: number } => {
      let textboxes = 0;
      let tablixes = 1;
      let nestedTablixes = isNested ? 1 : 0;

      const countNestedRect = (r: NonNullable<typeof reportDefinition.bodySections>[number]) => {
        if (!r.children) return;
        textboxes += r.children.textboxes.length;
        for (const nt of r.children.tablixes ?? []) {
          const sub = countTablixTree(nt, true);
          textboxes += sub.textboxes;
          tablixes += sub.tablixes;
          nestedTablixes += sub.nestedTablixes;
        }
        for (const sr of r.children.rectangles ?? []) {
          countNestedRect(sr);
        }
      };

      for (const row of tbl.rows) {
        for (const cell of row.cells) {
          if (cell.skipBecauseMerged) continue;
          const c = cell.content;
          if (c.kind === 'Textbox') {
            textboxes += 1;
          } else if (c.kind === 'Tablix') {
            const sub = countTablixTree(c.tablix, true);
            textboxes += sub.textboxes;
            tablixes += sub.tablixes;
            nestedTablixes += sub.nestedTablixes;
          } else if (c.kind === 'Rectangle') {
            textboxes += c.textboxes.length;
            for (const nt of c.tablixes) {
              const sub = countTablixTree(nt, true);
              textboxes += sub.textboxes;
              tablixes += sub.tablixes;
              nestedTablixes += sub.nestedTablixes;
            }
            for (const sr of c.rectangles) {
              countNestedRect(sr);
            }
          }
        }
      }
      return { textboxes, tablixes, nestedTablixes };
    };

    const visualPages = reportDefinition.visualPages ?? [];
    const bodyTablixes = reportDefinition.bodyTablixes ?? [];
    const bodySections = reportDefinition.bodySections ?? [];
    const hierarchy = reportDefinition.hierarchy;

    const chromeTextboxes =
      (reportDefinition.pageHeaderSpec?.textboxes.length ?? 0) +
      (reportDefinition.pageFooterSpec?.textboxes.length ?? 0);

    let bodyTextboxCount = 0;
    let bodyTablixCount = 0;
    let nestedTablixCount = 0;

    if (bodyTablixes.length > 0) {
      for (const bt of bodyTablixes) {
        const c = countTablixTree(bt, false);
        bodyTextboxCount += c.textboxes;
        bodyTablixCount += c.tablixes;
        nestedTablixCount += c.nestedTablixes;
      }
    } else if (bodySections.length > 0) {
      for (const sec of bodySections) {
        const c = countRectTree(sec);
        bodyTextboxCount += c.textboxes;
        bodyTablixCount += c.tablixes;
      }
    }

    const conversionMetrics = {
      textboxes:
        bodyTablixes.length > 0 || bodySections.length > 0
          ? bodyTextboxCount + chromeTextboxes
          : visualPages.reduce((s, p) => s + p.textboxes.length, 0),
      tablixes:
        bodyTablixes.length > 0 || bodySections.length > 0
          ? bodyTablixCount
          : visualPages.reduce((s, p) => s + p.tablixes.length, 0),
      nestedTablixes: nestedTablixCount,
      layer0Pages:
        bodyTablixes.length > 0 || bodySections.length > 0
          ? 0
          : visualPages.filter((p) => p.images.some((im) => im.name.startsWith('Img_Layer0_P'))).length,
      glyphFallbacks: layoutModel.pages.reduce(
        (s, p) => s + (p.brokenGlyphRegions ?? 0),
        0
      ),
      deduplicatedFakeBold: layoutModel.pages.reduce(
        (s, p) => s + (p.deduplicatedSpans ?? 0),
        0
      ),
      parameters: reportDefinition.parameters.length,
      sectionsCount: hierarchy?.sections.length ?? (bodyTablixes.length || bodySections.length),
      dualColumnSections:
        hierarchy?.sections.filter(
          (s) =>
            (s.columnCount ?? 1) >= 2 ||
            s.layoutType === 'Dual-Column' ||
            s.layoutType === 'Multi-Column'
        ).length ?? 0,
      printOnFirstPage: reportDefinition.pageHeaderSpec?.printOnFirstPage ?? false,
      nativeHeaderPresent: Boolean(reportDefinition.pageHeaderSpec),
      nativeFooterPresent: Boolean(reportDefinition.pageFooterSpec),
      collisionsCount: previewHtml.collisions.length,
      clippedRowsCount: previewHtml.clippedRows.length,
      sourcePageCount: layoutModel.document.pageCount,
      renderedPageCount: previewHtml.pageCount,
      pageSpilloverCount: previewHtml.pageSpillovers.length,
      pageParityDiagnostics: parityResult.pageParityDiagnostics,
    };

    const finalized =
      rdlcValidation.valid &&
      previewHtml.collisions.length === 0 &&
      previewHtml.clippedRows.length === 0 &&
      previewHtml.pageSpillovers.length === 0 &&
      previewHtml.pageCount === layoutModel.document.pageCount &&
      (!config.validation.requirePassingLogicTests || logicTests.status === 'PASS');

    if (finalized) {
      this.logger.info('Finalize', 'Deterministic RDLC & Logic gates passed', {
        rdlcSha256: rdlcSha256.slice(0, 12),
        parityPercent: visualDiff.overallParityPercent,
        bodyTablixes: bodyTablixes.length,
        nestedTablixes: nestedTablixCount,
        collisions: previewHtml.collisions.length,
        clippedRows: previewHtml.clippedRows.length,
        sourcePages: layoutModel.document.pageCount,
        renderedPages: previewHtml.pageCount,
      });
    } else {
      this.logger.warn('Finalize', 'Report NOT finalized due to failed quality, page parity, or logic gate', {
        collisions: previewHtml.collisions.length,
        clippedRows: previewHtml.clippedRows.length,
        sourcePages: layoutModel.document.pageCount,
        renderedPages: previewHtml.pageCount,
        pageSpillovers: previewHtml.pageSpillovers.length,
        rdlcErrors: rdlcValidation.errors.map((e) => `${e.ruleId}: ${e.message}`),
      });
    }

    return {
      runId,
      documentName: input.documentName,
      rdlcSha256,
      rdlcSchemaVersion: schemaVersion,
      conversionMetrics,
      layoutModel,
      existingPattern,
      reportDefinition,
      rdlcXml,
      vbCode: vbArtifacts.fullVbClass,
      dummyJson,
      rdlcValidation,
      logicTests,
      renderStatus,
      visualDiff,
      logs: this.logger.getEntries(),
      finalized,
      agentIterations: iterations + 1,
      calibrationSummary,
    };
  }
}
