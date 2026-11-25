import { execFile, spawn } from 'child_process';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { createServer as createViteServer } from 'vite';

const execFileAsync = promisify(execFile);
import { ReportGenAgent } from './src/engine/agent/reportGenAgent.ts';
import { loadConfig, resolveSafeSubpath } from './src/engine/core/config.ts';
import {
  CalibrationConstraints,
  CompilerWeights,
  IntermediateLayoutModel,
  PinnedCalibrationDoc,
  ReportGenError,
  StructuredLogger,
} from './src/engine/core/types.ts';
import { createReportGenServices, MCP_TOOL_CATALOG } from './src/engine/mcp/mcpTools.ts';
import { ProjectInserter } from './src/engine/proposal/projectInserter.ts';
import { ProposalOrchestrator } from './src/engine/proposal/proposalOrchestrator.ts';
import { sanitizeProductCode, StagingManager } from './src/engine/proposal/stagingManager.ts';
import { RdlcValidator } from './src/engine/rdlc/rdlcValidator.ts';
import {
  buildVerificationFixtureExcel,
  buildVerificationFixturePdf,
  SAMPLE_EXISTING_RDLC,
  SAMPLE_EXISTING_VB,
} from './src/samples/fixtureGenerator.ts';
import {
  buildProposalTemplatePdfA,
  buildReferenceSystemPdfB,
} from './src/samples/proposalFixtures.ts';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  app.use(express.json({ limit: '50mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'ReportGen', engineMode: 'deterministic-zero-ai' });
  });

  app.get('/api/config', (_req, res) => {
    const config = loadConfig();
    res.json({ ...config, engineMode: 'deterministic-zero-ai' });
  });

  app.get('/api/mcp/tools', (_req, res) => {
    res.json({ tools: MCP_TOOL_CATALOG });
  });

  app.get('/api/skills', (_req, res) => {
    const config = loadConfig();
    const services = createReportGenServices(config, false);
    const names = services.skillManager.listAvailableSkills();
    const skills = names
      .map((name) => services.skillManager.loadSkill(name))
      .filter(Boolean);
    res.json({ skills });
  });

  app.get('/api/fixture/:kind', async (req, res) => {
    try {
      const { kind } = req.params;
      if (kind === 'pdf') {
        const bytes = await buildVerificationFixturePdf();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="verification-fixture.pdf"');
        return res.send(Buffer.from(bytes));
      }
      if (kind === 'xlsx') {
        const buf = buildVerificationFixtureExcel();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="verification-oracle.xlsx"');
        return res.send(buf);
      }
      if (kind === 'rdlc') {
        res.setHeader('Content-Type', 'application/xml');
        return res.send(SAMPLE_EXISTING_RDLC);
      }
      if (kind === 'vb') {
        res.setHeader('Content-Type', 'text/plain');
        return res.send(SAMPLE_EXISTING_VB);
      }
      return res.status(404).json({ error: 'Unknown fixture kind' });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post(
    '/api/pipeline/run',
    upload.fields([
      { name: 'pdf', maxCount: 1 },
      { name: 'existingRdlc', maxCount: 1 },
      { name: 'existingVb', maxCount: 1 },
      { name: 'excel', maxCount: 1 },
      { name: 'comparisonPdf', maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
        const useFixture = req.body?.useFixture === 'true';

        let pdfBytes: Uint8Array;
        let documentName: string;
        let excelBytes: Buffer | undefined;
        let existingRdlcXml: string | undefined;
        let existingRdlcFileName: string | undefined;
        let existingVbSource: string | undefined;
        let existingVbFileName: string | undefined;

        if (files.pdf?.[0]) {
          pdfBytes = new Uint8Array(files.pdf[0].buffer);
          documentName = path.basename(files.pdf[0].originalname, path.extname(files.pdf[0].originalname));
        } else if (useFixture) {
          pdfBytes = await buildVerificationFixturePdf();
          documentName = 'VerificationFixtureReport';
          excelBytes = buildVerificationFixtureExcel();
          existingRdlcXml = SAMPLE_EXISTING_RDLC;
          existingRdlcFileName = 'ExistingReport.rdlc';
          existingVbSource = SAMPLE_EXISTING_VB;
          existingVbFileName = 'ExistingReport.vb';
        } else {
          return res.status(400).json({ error: 'Please upload a PDF file or run with the verification fixture.' });
        }

        if (files.excel?.[0]) excelBytes = files.excel[0].buffer;
        if (files.existingRdlc?.[0]) {
          existingRdlcXml = files.existingRdlc[0].buffer.toString('utf-8');
          existingRdlcFileName = files.existingRdlc[0].originalname;
        }
        if (files.existingVb?.[0]) {
          existingVbSource = files.existingVb[0].buffer.toString('utf-8');
          existingVbFileName = files.existingVb[0].originalname;
        }
        const comparisonPdfBytes = files.comparisonPdf?.[0]
          ? new Uint8Array(files.comparisonPdf[0].buffer)
          : undefined;

        const schemaVersion: '2008' | '2016' =
          req.body?.schemaVersion === '2016' ? '2016' : '2008';

        const parseJsonField = <T,>(raw: unknown): T | undefined => {
          if (!raw) return undefined;
          if (typeof raw === 'string') {
            try {
              return JSON.parse(raw) as T;
            } catch {
              return undefined;
            }
          }
          return raw as T;
        };

        const weights = parseJsonField<Partial<CompilerWeights>>(req.body?.weights);
        const calibrationConstraints = parseJsonField<CalibrationConstraints>(
          req.body?.calibrationConstraints
        );
        const pinnedDocs = parseJsonField<PinnedCalibrationDoc[]>(req.body?.pinnedDocs);
        const autoCalibrate =
          req.body?.autoCalibrate === 'true' || req.body?.autoCalibrate === true;

        const config = loadConfig();
        const services = createReportGenServices(config, false);
        const agent = new ReportGenAgent(services);

        const result = await agent.execute({
          documentName,
          pdfBytes,
          existingRdlcXml,
          existingRdlcFileName,
          existingVbSource,
          existingVbFileName,
          excelBytes,
          comparisonPdfBytes,
          schemaVersion,
          weights,
          calibrationConstraints,
          autoCalibrate,
          pinnedDocs,
        });

        return res.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof ReportGenError ? err.code : 'PIPELINE_ERROR';
        return res.status(500).json({ code, error: message });
      }
    }
  );

  app.post(
    '/api/pipeline/calibrate',
    upload.fields([
      { name: 'pdf', maxCount: 1 },
      { name: 'existingRdlc', maxCount: 1 },
      { name: 'existingVb', maxCount: 1 },
      { name: 'excel', maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
        const useFixture = req.body?.useFixture === 'true' || req.body?.useFixture === true;

        const parseJsonField = <T,>(raw: unknown): T | undefined => {
          if (!raw) return undefined;
          if (typeof raw === 'string') {
            try {
              return JSON.parse(raw) as T;
            } catch {
              return undefined;
            }
          }
          return raw as T;
        };

        const preAnalyzedLayout = parseJsonField<IntermediateLayoutModel>(req.body?.layoutModel);
        let pdfBytes: Uint8Array = new Uint8Array(0);
        let documentName = String(req.body?.documentName || preAnalyzedLayout?.document?.name || 'CalibratedReport');
        let excelBytes: Buffer | undefined;
        let existingRdlcXml: string | undefined;
        let existingRdlcFileName: string | undefined;
        let existingVbSource: string | undefined;
        let existingVbFileName: string | undefined;

        if (files.pdf?.[0]) {
          pdfBytes = new Uint8Array(files.pdf[0].buffer);
          documentName = path.basename(files.pdf[0].originalname, path.extname(files.pdf[0].originalname));
        } else if (typeof req.body?.originalPdfBase64 === 'string' && req.body.originalPdfBase64.length > 0) {
          const cleanB64 = req.body.originalPdfBase64.replace(/^data:[^;]+;base64,/, '');
          pdfBytes = new Uint8Array(Buffer.from(cleanB64, 'base64'));
        } else if (useFixture) {
          pdfBytes = await buildVerificationFixturePdf();
          documentName = 'VerificationFixtureReport';
          excelBytes = buildVerificationFixtureExcel();
          existingRdlcXml = SAMPLE_EXISTING_RDLC;
          existingRdlcFileName = 'ExistingReport.rdlc';
          existingVbSource = SAMPLE_EXISTING_VB;
          existingVbFileName = 'ExistingReport.vb';
        } else if (!preAnalyzedLayout) {
          return res.status(400).json({ error: 'Provide a PDF file, originalPdfBase64, layoutModel, or useFixture.' });
        }

        if (files.excel?.[0]) excelBytes = files.excel[0].buffer;
        if (files.existingRdlc?.[0]) {
          existingRdlcXml = files.existingRdlc[0].buffer.toString('utf-8');
          existingRdlcFileName = files.existingRdlc[0].originalname;
        }
        if (files.existingVb?.[0]) {
          existingVbSource = files.existingVb[0].buffer.toString('utf-8');
          existingVbFileName = files.existingVb[0].originalname;
        }

        const schemaVersion: '2008' | '2016' =
          req.body?.schemaVersion === '2016' ? '2016' : '2008';
        const weights = parseJsonField<Partial<CompilerWeights>>(req.body?.weights);
        const calibrationConstraints = parseJsonField<CalibrationConstraints>(
          req.body?.calibrationConstraints
        );
        const pinnedDocs = parseJsonField<PinnedCalibrationDoc[]>(req.body?.pinnedDocs);

        const config = loadConfig();
        const services = createReportGenServices(config, false);
        const agent = new ReportGenAgent(services);

        const result = await agent.execute({
          documentName,
          pdfBytes,
          existingRdlcXml,
          existingRdlcFileName,
          existingVbSource,
          existingVbFileName,
          excelBytes,
          schemaVersion,
          weights,
          calibrationConstraints,
          autoCalibrate: true,
          pinnedDocs,
          preAnalyzedLayout,
        });

        return res.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof ReportGenError ? err.code : 'CALIBRATION_ERROR';
        return res.status(500).json({ code, error: message });
      }
    }
  );

  app.post('/api/pipeline/validate', (req, res) => {
    try {
      const { rdlcXml, requireRdlc2008 } = req.body as {
        rdlcXml?: string;
        requireRdlc2008?: boolean;
      };
      if (!rdlcXml) return res.status(400).json({ error: 'rdlcXml is required' });
      const config = loadConfig();
      const services = createReportGenServices(config, false);
      const validator = new RdlcValidator(services.logger);
      return res.json(
        validator.validate(
          rdlcXml,
          requireRdlc2008 !== undefined ? { requireRdlc2008 } : undefined
        )
      );
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/pipeline/preview-html', (req, res) => {
    try {
      const { rdlcXml, title, sampleFields } = (req.body ?? {}) as {
        rdlcXml?: string;
        title?: string;
        sampleFields?: Record<string, unknown>;
      };
      if (!rdlcXml || typeof rdlcXml !== 'string') {
        return res.status(400).json({ error: 'rdlcXml string is required' });
      }
      const config = loadConfig();
      const services = createReportGenServices(config, false);
      const preview = services.rdlcPreviewRenderer.renderHtml(rdlcXml, { title, sampleFields });
      return res.json(preview);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/pipeline/preview-pdf', async (req, res) => {
    try {
      const { rdlcXml, title, filename, sampleFields, parameterOverrides } = (req.body ?? {}) as {
        rdlcXml?: string;
        title?: string;
        filename?: string;
        sampleFields?: Record<string, unknown>;
        parameterOverrides?: Record<string, string>;
      };
      if (!rdlcXml || typeof rdlcXml !== 'string') {
        return res.status(400).json({ error: 'rdlcXml string is required' });
      }
      const config = loadConfig();
      const services = createReportGenServices(config, false);
      const pdfBytes = await services.rdlcPreviewRenderer.renderPdf(rdlcXml, {
        title,
        sampleFields,
        parameterOverrides,
      });
      const safeBase = String(filename || title || 'rdlc-preview')
        .replace(/\.pdf$/i, '')
        .replace(/[^A-Za-z0-9._-]+/g, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeBase}.pdf"`);
      return res.send(Buffer.from(pdfBytes));
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/pipeline/preview-render', async (req, res) => {
    try {
      const { rdlcXml, title, sampleFields, parameterOverrides, originalPdfBase64, dpi } = (req.body ?? {}) as {
        rdlcXml?: string;
        title?: string;
        sampleFields?: Record<string, unknown>;
        parameterOverrides?: Record<string, string>;
        originalPdfBase64?: string;
        dpi?: number;
      };
      if (!rdlcXml || typeof rdlcXml !== 'string') {
        return res.status(400).json({ error: 'rdlcXml string is required' });
      }
      const config = loadConfig();
      const services = createReportGenServices(config, false);
      const targetDpi = typeof dpi === 'number' && dpi >= 72 && dpi <= 300 ? dpi : config.pdf.dpi;

      const htmlPreview = services.rdlcPreviewRenderer.renderHtml(rdlcXml, {
        title,
        sampleFields,
        parameterOverrides,
      });
      const renderedPdfBytes = await services.rdlcPreviewRenderer.renderPdf(rdlcXml, {
        title,
        sampleFields,
        parameterOverrides,
      });
      const renderedBuffers = await services.visualDiff.rasterizePdf(renderedPdfBytes, targetDpi);
      const renderedPagesBase64 = renderedBuffers.map((b) => b.toString('base64'));
      const parameters = services.rdlcPreviewRenderer.extractParameters(rdlcXml);

      let parityReport;
      let originalPagesBase64: string[] | undefined;
      if (originalPdfBase64 && typeof originalPdfBase64 === 'string') {
        const cleanB64 = originalPdfBase64.replace(/^data:[^;]+;base64,/, '');
        const origBytes = new Uint8Array(Buffer.from(cleanB64, 'base64'));
        parityReport = await services.visualDiff.comparePdfs(
          origBytes,
          renderedPdfBytes,
          config.validation.visualSimilarityTarget,
          undefined,
          targetDpi
        );
        originalPagesBase64 = parityReport.pages
          .map((p) => p.originalImageBase64)
          .filter((s): s is string => Boolean(s));
      }

      return res.json({
        html: htmlPreview.html,
        pageCount: htmlPreview.pageCount,
        pageWidth: htmlPreview.pageWidth,
        pageHeight: htmlPreview.pageHeight,
        stats: htmlPreview.stats,
        collisions: htmlPreview.collisions,
        clippedRows: htmlPreview.clippedRows,
        pageSpillovers: htmlPreview.pageSpillovers,
        parameters,
        renderedPagesBase64,
        originalPagesBase64,
        parityReport,
      });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/outputs', (_req, res) => {
    try {
      const outputRoot = path.resolve(process.cwd(), 'output');
      if (!fs.existsSync(outputRoot)) {
        return res.json({ outputs: [] });
      }
      const entries = fs.readdirSync(outputRoot, { withFileTypes: true });
      const outputs = entries
        .filter((e) => e.isDirectory())
        .map((e) => {
          const dirPath = path.join(outputRoot, e.name);
          const files = fs.readdirSync(dirPath);
          const rdlcFile = files.find((f) => f.endsWith('.rdlc'));
          const hasPreviewHtml = files.includes('preview.html');
          if (!rdlcFile) return null;
          const rdlcPath = path.join(dirPath, rdlcFile);
          return {
            folder: e.name,
            rdlcFile,
            rdlcBytes: fs.statSync(rdlcPath).size,
            hasPreviewHtml,
          };
        })
        .filter(Boolean);
      return res.json({ outputs });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/outputs/:folder/preview', (req, res) => {
    try {
      const folder = String(req.params.folder || '').trim();
      if (!folder || !/^[A-Za-z0-9._-]+$/.test(folder)) {
        return res.status(400).json({ error: 'Invalid output folder name.' });
      }
      const outputRoot = path.resolve(process.cwd(), 'output');
      const targetDir = resolveSafeSubpath(outputRoot, folder);
      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return res.status(404).json({ error: 'Output folder not found.' });
      }
      const files = fs.readdirSync(targetDir);
      const rdlcFile = files.find((f) => f.endsWith('.rdlc'));
      if (!rdlcFile) {
        return res.status(404).json({ error: 'No .rdlc file found in output folder.' });
      }
      const rdlcXml = fs.readFileSync(path.join(targetDir, rdlcFile), 'utf-8');
      const dummyPath = ['dummy-data.json', 'dummy.json']
        .map((f) => path.join(targetDir, f))
        .find((p) => fs.existsSync(p));
      const sampleFields = dummyPath ? (JSON.parse(fs.readFileSync(dummyPath, 'utf-8')) as Record<string, unknown>) : undefined;
      const config = loadConfig();
      const services = createReportGenServices(config, false);
      const validation = new RdlcValidator(services.logger).validate(rdlcXml);
      const preview = services.rdlcPreviewRenderer.renderHtml(rdlcXml, {
        title: `${folder} (${rdlcFile})`,
        sampleFields,
      });
      return res.json({
        folder,
        rdlcFile,
        rdlcBytes: Buffer.byteLength(rdlcXml, 'utf-8'),
        validation,
        preview,
      });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/outputs/:folder/pdf', async (req, res) => {
    try {
      const folder = String(req.params.folder || '').trim();
      if (!folder || !/^[A-Za-z0-9._-]+$/.test(folder)) {
        return res.status(400).json({ error: 'Invalid output folder name.' });
      }
      const outputRoot = path.resolve(process.cwd(), 'output');
      const targetDir = resolveSafeSubpath(outputRoot, folder);
      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return res.status(404).json({ error: 'Output folder not found.' });
      }
      const files = fs.readdirSync(targetDir);
      const rdlcFile = files.find((f) => f.endsWith('.rdlc'));
      if (!rdlcFile) {
        return res.status(404).json({ error: 'No .rdlc file found in output folder.' });
      }
      const rdlcXml = fs.readFileSync(path.join(targetDir, rdlcFile), 'utf-8');
      const dummyPath = ['dummy-data.json', 'dummy.json']
        .map((f) => path.join(targetDir, f))
        .find((p) => fs.existsSync(p));
      const sampleFields = dummyPath ? (JSON.parse(fs.readFileSync(dummyPath, 'utf-8')) as Record<string, unknown>) : undefined;
      const config = loadConfig();
      const services = createReportGenServices(config, false);
      const pdfBytes = await services.rdlcPreviewRenderer.renderPdf(rdlcXml, {
        title: `${folder} (${rdlcFile})`,
        sampleFields,
      });
      const safeBase = path.basename(rdlcFile, '.rdlc').replace(/[^A-Za-z0-9._-]+/g, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeBase}.pdf"`);
      return res.send(Buffer.from(pdfBytes));
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post(
    '/api/pipeline/compare',
    upload.fields([
      { name: 'originalPdf', maxCount: 1 },
      { name: 'generatedPdf', maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
        if (!files.originalPdf?.[0] || !files.generatedPdf?.[0]) {
          return res.status(400).json({ error: 'Both originalPdf and generatedPdf are required.' });
        }
        const config = loadConfig();
        const services = createReportGenServices(config, false);
        const report = await services.visualDiff.comparePdfs(
          new Uint8Array(files.originalPdf[0].buffer),
          new Uint8Array(files.generatedPdf[0].buffer),
          config.validation.visualSimilarityTarget
        );
        return res.json(report);
      } catch (err) {
        return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  app.post('/api/pipeline/integrate', (req, res) => {
    try {
      const { relativeOutputDir, reportName, force, rdlcXml, vbCode, dummyJson, reportDefinitionJson } =
        req.body as {
          relativeOutputDir: string;
          reportName: string;
          force: boolean;
          rdlcXml: string;
          vbCode: string;
          dummyJson: string;
          reportDefinitionJson: string;
        };

      const config = loadConfig();
      const services = createReportGenServices(config, false);
      const safeOutBase = path.resolve(process.cwd(), 'output');
      fs.mkdirSync(safeOutBase, { recursive: true });

      const writeRes = services.projectIntegrator.writeArtifacts(
        {
          projectRoot: safeOutBase,
          relativeOutputDir: relativeOutputDir || reportName,
          reportName,
          force: Boolean(force),
          files: {
            rdlcXml,
            vbCode,
            dummyJson,
            reportDefinitionJson,
          },
        },
        config
      );
      return res.json(writeRes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof ReportGenError ? err.code : 'INTEGRATION_ERROR';
      return res.status(400).json({ code, error: message });
    }
  });

  // Proposal Report Adaptation Engine API routes
  app.get('/api/proposal/fixture/:kind', async (req, res) => {
    try {
      const { kind } = req.params;
      if (kind === 'pdfA') {
        const bytes = await buildProposalTemplatePdfA();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="EGA-Template-PDFA.pdf"');
        return res.send(Buffer.from(bytes));
      }
      if (kind === 'pdfB') {
        const bytes = await buildReferenceSystemPdfB();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="Reference-System-PDFB.pdf"');
        return res.send(Buffer.from(bytes));
      }
      return res.status(404).json({ error: 'Unknown proposal fixture kind' });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/proposal/tech-profile', (req, res) => {
    try {
      const { projectRoot } = (req.body ?? {}) as { projectRoot?: string };
      const relRoot = projectRoot?.trim() || 'samples/SampleProposalProject';
      const safeProjectDir = resolveSafeSubpath(process.cwd(), relRoot);
      const config = loadConfig();
      const orch = new ProposalOrchestrator(config, false);
      const profile = orch.detectTechnology(safeProjectDir);
      return res.json(profile);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/proposal/scan', (req, res) => {
    try {
      const { projectRoot } = (req.body ?? {}) as { projectRoot?: string };
      const relRoot = projectRoot?.trim() || 'samples/SampleProposalProject';
      const safeProjectDir = resolveSafeSubpath(process.cwd(), relRoot);
      const config = loadConfig();
      const orch = new ProposalOrchestrator(config, false);
      const scan = orch.scanProject(safeProjectDir);
      return res.json(scan);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/proposal/catalog', (req, res) => {
    try {
      const { projectRoot } = (req.body ?? {}) as { projectRoot?: string };
      const relRoot = projectRoot?.trim() || 'samples/SampleProposalProject';
      const safeProjectDir = resolveSafeSubpath(process.cwd(), relRoot);
      const config = loadConfig();
      const orch = new ProposalOrchestrator(config, false);
      const catalog = orch.buildCatalog(safeProjectDir);
      return res.json(catalog);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post(
    '/api/proposal/run',
    upload.fields([
      { name: 'pdfA', maxCount: 1 },
      { name: 'pdfB', maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
        const useFixture = req.body?.useFixture === 'true';
        const productCode = String(req.body?.productCode || 'EGA');
        const planCode = String(req.body?.planCode || `${productCode}-EXEC-2026`);
        const benchmarkProductCode = req.body?.benchmarkProductCode
          ? String(req.body.benchmarkProductCode)
          : undefined;
        const relProjectRoot = String(req.body?.projectRoot || 'samples/SampleProposalProject');
        const safeProjectRoot = resolveSafeSubpath(process.cwd(), relProjectRoot);

        let pdfABytes: Uint8Array;
        let pdfAFileName: string;
        let pdfBBytes: Uint8Array | undefined;
        let pdfBFileName: string | undefined;

        if (files.pdfA?.[0]) {
          pdfABytes = new Uint8Array(files.pdfA[0].buffer);
          pdfAFileName = files.pdfA[0].originalname;
        } else if (useFixture) {
          pdfABytes = await buildProposalTemplatePdfA();
          pdfAFileName = 'EGA-Template-PDFA.pdf';
        } else {
          return res.status(400).json({ error: 'PDF A (new product template) is required unless using fixture.' });
        }

        if (files.pdfB?.[0]) {
          pdfBBytes = new Uint8Array(files.pdfB[0].buffer);
          pdfBFileName = files.pdfB[0].originalname;
        } else if (useFixture) {
          pdfBBytes = await buildReferenceSystemPdfB();
          pdfBFileName = 'Reference-System-PDFB.pdf';
        }

        const config = loadConfig();
        const orch = new ProposalOrchestrator(config, false);
        const result = await orch.runAdaptation({
          projectRoot: safeProjectRoot,
          productCode,
          planCode,
          benchmarkProductCode,
          pdfABytes,
          pdfAFileName,
          pdfBBytes,
          pdfBFileName,
        });

        return res.json(result);
      } catch (err) {
        return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  app.post('/api/proposal/confirm-field', async (req, res) => {
    try {
      const { productCode, confirmations } = req.body as {
        productCode: string;
        confirmations: Array<{
          id?: string;
          field: string;
          value?: string | number;
          status?: 'CONFIRMED' | 'UNCERTAIN';
        }>;
      };
      if (!productCode || !Array.isArray(confirmations)) {
        return res.status(400).json({ error: 'productCode and confirmations[] are required.' });
      }
      const config = loadConfig();
      const orch = new ProposalOrchestrator(config, false);
      const updated = await orch.rerunWithFieldConfirmations(productCode, confirmations);
      return res.json(updated);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/proposal/approve', (req, res) => {
    try {
      const { productCode, approvedBy, decision, policyOverrideWarnings, notes } = req.body as {
        productCode: string;
        approvedBy: string;
        decision: 'APPROVED' | 'REJECTED';
        policyOverrideWarnings?: boolean;
        notes?: string;
      };
      const config = loadConfig();
      const logger = new StructuredLogger(false);
      const manager = new StagingManager(logger);
      const outputRoot = path.resolve(process.cwd(), config.project.outputPath || 'output');
      const stagingDir = manager.getStagingDir(outputRoot, sanitizeProductCode(productCode));
      const approval = manager.approveStaging({
        stagingDir,
        approvedBy: approvedBy || 'reviewer',
        decision: decision === 'REJECTED' ? 'REJECTED' : 'APPROVED',
        policyOverrideWarnings,
        notes,
      });
      return res.json(approval);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/proposal/insert-dry-run', (req, res) => {
    try {
      const { productCode, projectRoot, allowOverwrite } = req.body as {
        productCode: string;
        projectRoot?: string;
        allowOverwrite?: boolean;
      };
      const config = loadConfig();
      const logger = new StructuredLogger(false);
      const manager = new StagingManager(logger);
      const inserter = new ProjectInserter(logger);
      const outputRoot = path.resolve(process.cwd(), config.project.outputPath || 'output');
      const stagingDir = manager.getStagingDir(outputRoot, sanitizeProductCode(productCode));
      const safeProjectDir = resolveSafeSubpath(
        process.cwd(),
        projectRoot?.trim() || 'samples/SampleProposalProject'
      );
      const plan = inserter.dryRun(safeProjectDir, stagingDir, Boolean(allowOverwrite));
      return res.json(plan);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/proposal/insert-confirm', (req, res) => {
    try {
      const { productCode, projectRoot, allowOverwrite } = req.body as {
        productCode: string;
        projectRoot?: string;
        allowOverwrite?: boolean;
      };
      const config = loadConfig();
      const logger = new StructuredLogger(false);
      const manager = new StagingManager(logger);
      const inserter = new ProjectInserter(logger);
      const outputRoot = path.resolve(process.cwd(), config.project.outputPath || 'output');
      const stagingDir = manager.getStagingDir(outputRoot, sanitizeProductCode(productCode));
      const safeProjectDir = resolveSafeSubpath(
        process.cwd(),
        projectRoot?.trim() || 'samples/SampleProposalProject'
      );
      const manifest = inserter.insert(safeProjectDir, stagingDir, {
        confirm: true,
        allowOverwrite: Boolean(allowOverwrite),
      });
      return res.json(manifest);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Multi-Modal ML Layout Engine API routes
  const getMlStatus = async () => {
    const { stdout } = await execFileAsync('python3', ['-m', 'ml_engine.cli', '--mode', 'status'], {
      cwd: process.cwd(),
      timeout: 15000,
    });
    return JSON.parse(stdout) as {
      available: boolean;
      installedPackages: Record<string, boolean>;
      missingPackages: string[];
      checkpointPath: string;
      checkpointExists: boolean;
      historyCount?: number;
      recentHistory?: Array<Record<string, unknown>>;
    };
  };

  app.get('/api/ml/status', async (_req, res) => {
    try {
      const status = await getMlStatus();
      return res.json(status);
    } catch (err) {
      return res.json({
        available: false,
        installedPackages: {},
        missingPackages: ['torch', 'fitz', 'cv2', 'skimage', 'rapidocr_onnxruntime', 'numpy'],
        checkpointExists: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const handleMlTrainOrInfer = async (
    mode: 'train' | 'infer',
    req: express.Request,
    res: express.Response
  ) => {
    let tempDir: string | null = null;
    try {
      const mlEnv = await getMlStatus();
      if (!mlEnv.available) {
        return res.status(422).json({
          error: `Python ML dependencies are not installed (${mlEnv.missingPackages.join(', ')}).`,
          missingPackages: mlEnv.missingPackages,
          installCommand: 'pip install -r ml_engine/requirements.txt',
        });
      }

      const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
      const useFixture = req.body?.useFixture === 'true' || req.body?.useFixture === true;
      const schemaVersion: '2008' | '2016' = req.body?.schemaVersion === '2016' ? '2016' : '2008';
      const maxEpochs = Math.max(1, Math.min(25, Number(req.body?.maxEpochs ?? 12) || 12));
      const targetSsim = Math.max(0.5, Math.min(0.995, Number(req.body?.targetSsim ?? 0.95) || 0.95));
      const wantsStream =
        req.body?.stream === 'true' ||
        req.body?.stream === true ||
        String(req.headers.accept ?? '').includes('application/x-ndjson');

      let pdfBuffer: Buffer;
      let baseName = 'MlTargetDocument';
      if (files.pdf?.[0]) {
        pdfBuffer = files.pdf[0].buffer;
        baseName = path.basename(files.pdf[0].originalname, path.extname(files.pdf[0].originalname));
      } else if (typeof req.body?.originalPdfBase64 === 'string' && req.body.originalPdfBase64.length > 0) {
        const cleanB64 = req.body.originalPdfBase64.replace(/^data:[^;]+;base64,/, '');
        pdfBuffer = Buffer.from(cleanB64, 'base64');
        baseName = String(req.body?.documentName || baseName);
      } else if (useFixture) {
        pdfBuffer = Buffer.from(await buildVerificationFixturePdf());
        baseName = 'VerificationFixtureReport';
      } else {
        return res.status(400).json({ error: 'Provide a PDF file, originalPdfBase64, or useFixture=true.' });
      }

      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reportgen_ml_api_'));
      const safeName = baseName.replace(/[^A-Za-z0-9._-]+/g, '_') || 'document';
      const pdfPath = path.join(tempDir, `${safeName}.pdf`);
      const outJsonPath = path.join(tempDir, 'ml_result.json');
      fs.writeFileSync(pdfPath, pdfBuffer);

      const args = [
        '-m',
        'ml_engine.cli',
        '--mode',
        mode,
        '--pdf',
        pdfPath,
        '--schema-version',
        schemaVersion,
        '--max-epochs',
        String(maxEpochs),
        '--target-ssim',
        String(targetSsim),
        '--out-json',
        outJsonPath,
      ];
      if (wantsStream) {
        args.push('--stream');
      }

      if (wantsStream) {
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
      }

      const child = spawn('python3', args, { cwd: process.cwd() });
      let stderrBuf = '';
      let stdoutBuf = '';

      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf-8');
      });

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf-8');
        stdoutBuf += text;
        if (wantsStream) {
          res.write(text);
        }
      });

      child.on('close', (code) => {
        try {
          if (code !== 0) {
            const errPayload = {
              error: stderrBuf.trim() || `ML ${mode} exited with code ${code}`,
            };
            if (wantsStream) {
              res.write(JSON.stringify({ event: 'error', data: errPayload }) + '\n');
              res.end();
            } else {
              res.status(500).json(errPayload);
            }
            return;
          }
          if (wantsStream) {
            res.end();
          } else if (fs.existsSync(outJsonPath)) {
            const finalJson = JSON.parse(fs.readFileSync(outJsonPath, 'utf-8'));
            res.json(finalJson);
          } else {
            res.json(JSON.parse(stdoutBuf));
          }
        } finally {
          if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        }
      });
    } catch (err) {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  app.post('/api/ml/train', upload.fields([{ name: 'pdf', maxCount: 1 }]), (req, res) => {
    void handleMlTrainOrInfer('train', req, res);
  });

  app.post('/api/ml/infer', upload.fields([{ name: 'pdf', maxCount: 1 }]), (req, res) => {
    void handleMlTrainOrInfer('infer', req, res);
  });

  app.get('/api/ml/checkpoint/export', (_req, res) => {
    try {
      const ckptPath = path.resolve(process.cwd(), 'ml_engine', 'checkpoints', 'layout_policy.pt');
      if (!fs.existsSync(ckptPath)) {
        return res.status(404).json({ error: 'No trained layout_policy.pt checkpoint exists yet.' });
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="layout_policy.pt"');
      return res.sendFile(ckptPath);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/ml/checkpoint/import', upload.single('checkpoint'), async (req, res) => {
    try {
      const file = req.file;
      if (!file || file.buffer.byteLength === 0) {
        return res.status(400).json({ error: 'Upload a valid layout_policy.pt checkpoint file.' });
      }
      const ckptDir = path.resolve(process.cwd(), 'ml_engine', 'checkpoints');
      fs.mkdirSync(ckptDir, { recursive: true });
      const ckptPath = path.join(ckptDir, 'layout_policy.pt');
      fs.writeFileSync(ckptPath, file.buffer);
      const status = await getMlStatus();
      return res.json({ ok: true, bytes: file.buffer.byteLength, status });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ReportGen server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
