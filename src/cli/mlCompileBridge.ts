import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { enforceOneToOnePageParity } from '../engine/calibration/calibrationEngine.ts';
import { loadConfig } from '../engine/core/config.ts';
import {
  CalibrationConstraints,
  CompilerWeights,
  ExistingProjectPattern,
  IntermediateLayoutModel,
  PipelineRunResult,
} from '../engine/core/types.ts';
import { createReportGenServices } from '../engine/mcp/mcpTools.ts';
import { RdlcValidator } from '../engine/rdlc/rdlcValidator.ts';

interface BridgeInputPayload {
  pdfPath?: string;
  documentName?: string;
  schemaVersion?: '2008' | '2016';
  weights?: Partial<CompilerWeights>;
  calibrationConstraints?: CalibrationConstraints;
  preAnalyzedLayout?: IntermediateLayoutModel;
  renderedPdfOutPath?: string;
  fullResultOutPath?: string;
  includeFullResult?: boolean;
  enforcePageParity?: boolean;
  existingRdlcXml?: string;
  existingRdlcFileName?: string;
  existingVbSource?: string;
  existingVbFileName?: string;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

function getInputFileArg(): string | undefined {
  const idx = process.argv.indexOf('--input');
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function main() {
  const inputPath = getInputFileArg();
  const rawInput = inputPath ? fs.readFileSync(inputPath, 'utf-8') : await readStdin();
  const payload = JSON.parse(rawInput) as BridgeInputPayload;

  const config = loadConfig();
  const services = createReportGenServices(config, false);
  const schemaVersion: '2008' | '2016' = payload.schemaVersion === '2016' ? '2016' : '2008';
  const is2008 = schemaVersion === '2008';

  const pdfBytes =
    payload.pdfPath && fs.existsSync(payload.pdfPath)
      ? new Uint8Array(fs.readFileSync(payload.pdfPath))
      : new Uint8Array(0);
  const documentName =
    payload.documentName ||
    payload.preAnalyzedLayout?.document?.name ||
    (payload.pdfPath ? path.basename(payload.pdfPath, path.extname(payload.pdfPath)) : 'MlCompiledReport');

  let layoutModel: IntermediateLayoutModel;
  if (payload.preAnalyzedLayout) {
    layoutModel = services.gridReconstructor.reconstruct(
      payload.preAnalyzedLayout,
      config.pdf.coordinateTolerance
    );
  } else if (pdfBytes.byteLength > 0) {
    const rawLayout = await services.pdfAnalyzer.analyzeBuffer(
      pdfBytes,
      documentName,
      config.pdf.dpi,
      payload.weights
    );
    layoutModel = services.gridReconstructor.reconstruct(
      rawLayout,
      config.pdf.coordinateTolerance
    );
  } else {
    throw new Error('Bridge requires either preAnalyzedLayout or an existing pdfPath.');
  }

  let existingPattern: ExistingProjectPattern | undefined;
  if (payload.existingRdlcXml || payload.existingVbSource) {
    existingPattern = services.projectInspector.inspect({
      rdlcXml: payload.existingRdlcXml,
      rdlcFileName: payload.existingRdlcFileName,
      vbSource: payload.existingVbSource,
      vbFileName: payload.existingVbFileName,
    });
  }

  let activeWeights = payload.weights;
  let activeConstraints = payload.calibrationConstraints;

  const prelimDef = services.tablixBuilder.buildReportDefinition(layoutModel, existingPattern, {
    schemaVersion,
    weights: activeWeights,
    calibrationConstraints: activeConstraints,
  });
  const prelimDummy = services.excelOracle.generateDummyJson(prelimDef);

  let reportDefinition = prelimDef;
  let pageParityDiagnostics;
  if (payload.enforcePageParity) {
    const parityRes = enforceOneToOnePageParity({
      layoutModel,
      schemaVersion,
      existingPattern,
      weights: activeWeights,
      calibrationConstraints: activeConstraints,
      dummyJson: prelimDummy,
      logger: services.logger,
    });
    reportDefinition = parityRes.reportDef;
    activeWeights = parityRes.weights;
    activeConstraints = parityRes.constraints;
    pageParityDiagnostics = parityRes.pageParityDiagnostics;
  }

  const vbArtifacts = services.vbGenerator.generate(reportDefinition, existingPattern);
  const rdlcXml = services.rdlcGenerator.generate(reportDefinition, vbArtifacts.embeddedRdlcCode, {
    schemaVersion,
  });
  const rdlcSha256 = crypto.createHash('sha256').update(rdlcXml, 'utf-8').digest('hex');

  const dummyJson = services.excelOracle.generateDummyJson(reportDefinition);
  const previewHtml = services.rdlcPreviewRenderer.renderHtml(rdlcXml, {
    title: documentName,
    sampleFields: dummyJson,
  });
  const renderedPdfBytes = await services.rdlcPreviewRenderer.renderPdf(rdlcXml, {
    title: documentName,
    sampleFields: dummyJson,
  });

  if (payload.renderedPdfOutPath) {
    fs.mkdirSync(path.dirname(payload.renderedPdfOutPath), { recursive: true });
    fs.writeFileSync(payload.renderedPdfOutPath, Buffer.from(renderedPdfBytes));
  }

  const validator = new RdlcValidator(services.logger);
  const rdlcValidation = validator.validate(rdlcXml, {
    requireRdlc2008: is2008,
    context: {
      sourcePageCount: layoutModel.document.pageCount,
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

  const tablixMeta = (reportDefinition.bodyTablixes ?? reportDefinition.tablixRegions ?? []).map((t) => ({
    name: t.name,
    pageNumber: t.pageNumber,
    containerKey: t.containerKey,
    solverStrategy: t.solverStrategy,
    topIn: t.topIn,
    heightIn: t.heightIn,
    rowCount: t.rows.length,
    colCount: t.columnWidthsIn.length,
  }));

  let fullResult: PipelineRunResult | undefined;
  if (payload.includeFullResult || payload.fullResultOutPath) {
    const logicTests = services.logicTestRunner.run(
      vbArtifacts.fullVbClass,
      reportDefinition,
      [],
      []
    );
    const renderStatus = await services.renderer.renderToPdf(rdlcXml);
    const visualDiff =
      pdfBytes.byteLength > 0
        ? await services.visualDiff.comparePdfs(
            pdfBytes,
            renderedPdfBytes,
            config.validation.visualSimilarityTarget,
            undefined,
            config.pdf.dpi
          )
        : undefined;

    const bodyTablixes = reportDefinition.bodyTablixes ?? [];
    const chromeTextboxes =
      (reportDefinition.pageHeaderSpec?.textboxes.length ?? 0) +
      (reportDefinition.pageFooterSpec?.textboxes.length ?? 0);
    let bodyTextboxCount = 0;
    for (const bt of bodyTablixes) {
      for (const row of bt.rows) {
        for (const cell of row.cells) {
          if (!cell.skipBecauseMerged && cell.content.kind === 'Textbox') bodyTextboxCount++;
        }
      }
    }

    const runId = crypto
      .createHash('sha256')
      .update(`${documentName}:${pdfBytes.byteLength}`)
      .digest('hex')
      .slice(0, 8);

    const finalized =
      rdlcValidation.valid &&
      previewHtml.collisions.length === 0 &&
      previewHtml.clippedRows.length === 0 &&
      previewHtml.pageSpillovers.length === 0 &&
      previewHtml.pageCount === layoutModel.document.pageCount;

    fullResult = {
      runId,
      documentName,
      layoutModel,
      existingPattern,
      reportDefinition,
      rdlcXml,
      rdlcSha256,
      rdlcSchemaVersion: schemaVersion,
      vbCode: vbArtifacts.fullVbClass,
      dummyJson,
      rdlcValidation,
      logicTests,
      renderStatus,
      visualDiff,
      conversionMetrics: {
        textboxes: bodyTablixes.length > 0 ? bodyTextboxCount + chromeTextboxes : 0,
        tablixes: bodyTablixes.length || reportDefinition.tablixRegions.length,
        nestedTablixes: 0,
        layer0Pages: 0,
        glyphFallbacks: layoutModel.pages.reduce((s, p) => s + (p.brokenGlyphRegions ?? 0), 0),
        deduplicatedFakeBold: layoutModel.pages.reduce((s, p) => s + (p.deduplicatedSpans ?? 0), 0),
        parameters: reportDefinition.parameters.length,
        sectionsCount: reportDefinition.hierarchy?.sections.length ?? bodyTablixes.length,
        dualColumnSections:
          reportDefinition.hierarchy?.sections.filter(
            (s) => (s.columnCount ?? 1) >= 2 || s.layoutType === 'Dual-Column' || s.layoutType === 'Multi-Column'
          ).length ?? 0,
        printOnFirstPage: reportDefinition.pageHeaderSpec?.printOnFirstPage ?? false,
        nativeHeaderPresent: Boolean(reportDefinition.pageHeaderSpec),
        nativeFooterPresent: Boolean(reportDefinition.pageFooterSpec),
        collisionsCount: previewHtml.collisions.length,
        clippedRowsCount: previewHtml.clippedRows.length,
        sourcePageCount: layoutModel.document.pageCount,
        renderedPageCount: previewHtml.pageCount,
        pageSpilloverCount: previewHtml.pageSpillovers.length,
        pageParityDiagnostics,
      },
      logs: services.logger.getEntries(),
      finalized,
      agentIterations: 1,
    };

    if (payload.fullResultOutPath) {
      fs.mkdirSync(path.dirname(payload.fullResultOutPath), { recursive: true });
      fs.writeFileSync(payload.fullResultOutPath, JSON.stringify(fullResult));
    }
  }

  const summaryOut = {
    sourcePageCount: layoutModel.document.pageCount,
    renderedPageCount: previewHtml.pageCount,
    collisionsCount: previewHtml.collisions.length,
    clippedRowsCount: previewHtml.clippedRows.length,
    pageSpillovers: previewHtml.pageSpillovers,
    collisions: previewHtml.collisions,
    clippedRows: previewHtml.clippedRows,
    validationValid: rdlcValidation.valid,
    validationErrors: rdlcValidation.errors,
    rdlcSha256,
    renderedPdfOutPath: payload.renderedPdfOutPath,
    fullResultOutPath: payload.fullResultOutPath,
    weights: activeWeights,
    constraints: activeConstraints,
    tablixMeta,
  };

  process.stdout.write(JSON.stringify(summaryOut));
}

main().catch((err) => {
  process.stderr.write(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
