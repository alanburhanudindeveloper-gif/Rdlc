Option Strict On
Option Explicit On

Imports System
Imports System.Collections.Generic
Imports System.Data
Imports System.IO
Imports System.Linq
Imports System.Security.Cryptography
Imports System.Text
Imports System.Text.Json
Imports Microsoft.Reporting.NETCore
Imports ReportGen.VbCompiler.Contracts
Imports ReportGen.VbCompiler.Emitter
Imports ReportGen.VbCompiler.Solver
Imports ReportGen.VbCompiler.ValueFill

Namespace ReportGen.VbCompiler.Runtime

    ''' <summary>
    ''' Section 5A: Assistive Vector Artifact Database ([R-ARCH-01]).
    ''' Stores test artifacts and scan-coordinate snapshots with 16-feature geometric embeddings
    ''' strictly for similar-layout lookup, regression inspection, and diagnostic diffing.
    ''' NEVER overwrites active document coordinates or bypasses deterministic solver rules.
    ''' </summary>
    Public NotInheritable Class AssistiveVectorArtifactStore
        Private Const VectorDim As Integer = 16
        Private ReadOnly _storePath As String
        Private ReadOnly _records As New List(Of VectorArtifactRecord)()

        Public Sub New(ByVal storeFilePath As String)
            Dim fullRoot As String = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "output"))
            Dim candidate As String = Path.GetFullPath(storeFilePath)
            If Not candidate.StartsWith(fullRoot & Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) AndAlso
               Not String.Equals(candidate, fullRoot, StringComparison.OrdinalIgnoreCase) Then
                Throw New InvalidOperationException("Vector store path must remain confined inside the output directory.")
            End If
            _storePath = candidate
            LoadExisting()
        End Sub

        Public Function RecordSnapshot(ByVal state As PipelineState) As VectorArtifactRecord
            If state Is Nothing Then Throw New ArgumentNullException(NameOf(state))
            Dim firstPage = If(state.SourceDocument.Pages.Count > 0, state.SourceDocument.Pages(0), New LayoutPageIr())

            Dim hasDualTrack As Boolean = state.CompiledTablixes.Any(Function(t) t.IsRightTrack) OrElse state.AppliedRules.Contains("[R-DUAL-TRACK]")
            Dim hasNested As Boolean = state.CompiledTablixes.Any(Function(t) t.Strategy = SolverStrategyKind.ParentNestedBannerGrid)
            Dim hasStaircase As Boolean = state.CompiledTablixes.Any(Function(t) t.Strategy = SolverStrategyKind.IndentationClauseSolver)

            Dim rawFeatures = Build16FeatureVector(state, firstPage, hasDualTrack, hasNested, hasStaircase)
            Dim embedding = NormalizeL2(rawFeatures)

            Dim containers = state.CompiledTablixes.Select(Function(t) New GeometricContainerSnapshot With {
                .ContainerKey = t.Name,
                .Strategy = t.Strategy.ToString(),
                .TopPt = t.TopPt,
                .LeftPt = t.LeftPt,
                .WidthPt = t.WidthPt,
                .HeightPt = t.HeightPt,
                .ColCount = t.ColumnWidthsPt.Count,
                .RowCount = t.Rows.Count,
                .ColumnWidthsPt = New List(Of Double)(t.ColumnWidthsPt)
            }).ToList()

            Dim rec As New VectorArtifactRecord With {
                .Id = $"vec_{Guid.NewGuid().ToString("N").Substring(0, 12)}",
                .Metadata = New VectorArtifactMetadata With {
                    .DocumentTemplate = If(String.IsNullOrWhiteSpace(state.DocumentTemplate), state.SourceDocument.DocumentTemplate, state.DocumentTemplate),
                    .PageIndex = firstPage.PageIndex,
                    .GateStage = state.CurrentGate.ToString(),
                    .AppliedRules = state.AppliedRules.OrderBy(Function(r) r).ToList(),
                    .HasDualTrackStream = hasDualTrack,
                    .HasNestedTablix = hasNested,
                    .HasStaircaseIndent = hasStaircase,
                    .XsdValidationPassed = state.XsdValidationPassed,
                    .RenderedPageCount = state.RenderedPageCount,
                    .SourcePageCount = Math.Max(1, state.SourceDocument.PageCount)
                },
                .Embedding = embedding,
                .RawFeatures = rawFeatures,
                .Containers = containers,
                .Diagnostics = New List(Of String)(state.ValidationErrors),
                .CreatedAtIso = DateTimeOffset.UtcNow.ToString("O")
            }

            _records.Add(rec)
            Persist()
            Return rec
        End Function

        Public Function FindSimilarLayouts(ByVal queryEmbedding As List(Of Double), Optional ByVal topK As Integer = 5) As List(Of VectorSearchResult)
            Dim clampedK As Integer = Math.Clamp(topK, 1, 50)
            Return _records.
                Select(Function(r) New VectorSearchResult With {.Artifact = r, .Similarity = CosineSimilarity(queryEmbedding, r.Embedding)}).
                OrderByDescending(Function(x) x.Similarity).
                Take(clampedK).
                ToList()
        End Function

        Public Function DiffSnapshots(ByVal baselineId As String, ByVal candidateId As String) As RegressionDiffReport
            Dim baseline = _records.FirstOrDefault(Function(r) r.Id = baselineId)
            Dim candidate = _records.FirstOrDefault(Function(r) r.Id = candidateId)
            If baseline Is Nothing OrElse candidate Is Nothing Then
                Throw New KeyNotFoundException("Baseline or candidate vector artifact not found.")
            End If

            Dim baseRules = New HashSet(Of String)(baseline.Metadata.AppliedRules, StringComparer.Ordinal)
            Dim candRules = New HashSet(Of String)(candidate.Metadata.AppliedRules, StringComparer.Ordinal)

            Return New RegressionDiffReport With {
                .BaselineId = baseline.Id,
                .CandidateId = candidate.Id,
                .PageParityDelta = (candidate.Metadata.RenderedPageCount - candidate.Metadata.SourcePageCount) - (baseline.Metadata.RenderedPageCount - baseline.Metadata.SourcePageCount),
                .TablixCountDelta = candidate.Containers.Count - baseline.Containers.Count,
                .XsdRegressed = baseline.Metadata.XsdValidationPassed AndAlso Not candidate.Metadata.XsdValidationPassed,
                .AddedRules = candRules.Where(Function(r) Not baseRules.Contains(r)).ToList(),
                .RemovedRules = baseRules.Where(Function(r) Not candRules.Contains(r)).ToList(),
                .EmbeddingCosineSimilarity = CosineSimilarity(baseline.Embedding, candidate.Embedding),
                .Notes = New List(Of String) From {"Assistive diagnostic diff only; deterministic solver outputs unchanged."}
            }
        End Function

        Private Shared Function Build16FeatureVector(
            ByVal state As PipelineState,
            ByVal page As LayoutPageIr,
            ByVal hasDual As Boolean,
            ByVal hasNested As Boolean,
            ByVal hasStaircase As Boolean) As List(Of Double)

            Dim srcPages As Double = Math.Max(1.0, state.SourceDocument.PageCount)
            Dim rndPages As Double = Math.Max(0.0, state.RenderedPageCount)
            Return New List(Of Double) From {
                0.0,
                0.0,
                1.0,
                1.0,
                Math.Min(1.0, page.BodySpans.Count / 200.0),
                Math.Min(1.0, page.HLines.Count / 60.0),
                Math.Min(1.0, page.VLines.Count / 30.0),
                Math.Min(1.0, page.FillBanners.Count / 10.0),
                Math.Min(1.0, page.RowFills.Count / 40.0),
                0.25,
                If(hasDual, 1.0, 0.0),
                If(hasNested, 1.0, 0.0),
                If(hasStaircase, 1.0, 0.0),
                If(state.XsdValidationPassed, 1.0, 0.0),
                Math.Min(2.0, rndPages / srcPages),
                Math.Min(1.0, state.CompiledTablixes.Count / 20.0)
            }
        End Function

        Private Shared Function NormalizeL2(ByVal vals As List(Of Double)) As List(Of Double)
            Dim sumSq As Double = vals.Sum(Function(v) v * v)
            Dim norm As Double = Math.Sqrt(sumSq)
            If norm <= 0.000000001 Then Return New List(Of Double)(vals)
            Return vals.Select(Function(v) Math.Round(v / norm, 6)).ToList()
        End Function

        Private Shared Function CosineSimilarity(ByVal a As List(Of Double), ByVal b As List(Of Double)) As Double
            Dim n As Integer = Math.Min(VectorDim, Math.Min(a.Count, b.Count))
            If n = 0 Then Return 0.0
            Dim dot As Double = 0.0, na As Double = 0.0, nb As Double = 0.0
            For i As Integer = 0 To n - 1
                dot += a(i) * b(i)
                na += a(i) * a(i)
                nb += b(i) * b(i)
            Next
            Dim denom As Double = Math.Sqrt(na) * Math.Sqrt(nb)
            Return If(denom <= 0.000000001, 0.0, Math.Round(dot / denom, 6))
        End Function

        Private Sub LoadExisting()
            If Not File.Exists(_storePath) Then Return
            Try
                Dim jsonText As String = File.ReadAllText(_storePath)
                Dim loaded = JsonSerializer.Deserialize(Of List(Of VectorArtifactRecord))(jsonText)
                If loaded IsNot Nothing Then _records.AddRange(loaded)
            Catch
                _records.Clear()
            End Try
        End Sub

        Private Sub Persist()
            Dim dir = Path.GetDirectoryName(_storePath)
            If Not String.IsNullOrWhiteSpace(dir) Then Directory.CreateDirectory(dir)
            Dim opts As New JsonSerializerOptions With {.WriteIndented = True}
            File.WriteAllText(_storePath, JsonSerializer.Serialize(_records, opts), Encoding.UTF8)
        End Sub
    End Class

    ''' <summary>
    ''' Section 5B: Real LocalReport.Render("PDF") Renderer + 1:1 Compaction Loop + CLI Orchestrator.
    ''' </summary>
    Public NotInheritable Class LocalReportRendererAndOrchestrator
        Public Shared Sub RenderWithParityCompaction(ByVal state As PipelineState, ByVal rdlcPath As String, ByVal outPdfPath As String)
            Dim emitter As New Rdlc2008EmitterAndValidator()
            Dim sourcePages As Integer = Math.Max(1, state.SourceDocument.PageCount)

            For attempt As Integer = 0 To 4
                emitter.EmitAndValidate(state)
                If Not state.XsdValidationPassed Then
                    Throw New InvalidOperationException($"RDLC 2008 validation failed: {String.Join("; ", state.ValidationErrors)}")
                End If

                Dim rdlcDir As String = Path.GetDirectoryName(rdlcPath)
                If Not String.IsNullOrWhiteSpace(rdlcDir) Then Directory.CreateDirectory(rdlcDir)
                File.WriteAllText(rdlcPath, state.RdlcXml, Encoding.UTF8)

                Dim pdfBytes As Byte()
                Using rpt As New LocalReport()
                    rpt.ReportPath = rdlcPath
                    Dim dt As DataTable = If(state.LogicalFillResult IsNot Nothing,
                        LogicalValueFiller.ToReportDataTable(state.LogicalFillResult),
                        CreateDummyDataTable())
                    rpt.DataSources.Add(New ReportDataSource("dsReport", dt))
                    pdfBytes = rpt.Render("PDF")
                End Using

                Dim outDir As String = Path.GetDirectoryName(outPdfPath)
                If Not String.IsNullOrWhiteSpace(outDir) Then Directory.CreateDirectory(outDir)
                File.WriteAllBytes(outPdfPath, pdfBytes)
                state.RenderedPdfPath = outPdfPath
                state.RenderedPageCount = CountPdfPages(pdfBytes)
                state.CurrentGate = GateStage.Gate6ParityRender

                If state.RenderedPageCount = sourcePages Then
                    state.TraceLog.Add($"Gate6: 1:1 page parity verified ({state.RenderedPageCount}/{sourcePages}) on attempt {attempt + 1}.")
                    Exit Sub
                End If

                ' Compact vertical padding & row heights proportionally across both tracks cleanly
                CompactVerticalHeights(state, Math.Max(0.85, CDbl(sourcePages) / Math.Max(1, state.RenderedPageCount)))
            Next
        End Sub

        Private Shared Sub CompactVerticalHeights(ByVal state As PipelineState, ByVal ratio As Double)
            For Each tbl In state.CompiledTablixes
                Dim yCursor As Double = tbl.TopPt
                For Each row In tbl.Rows
                    row.HeightPt = Math.Max(10.5, Math.Round(row.HeightPt * ratio, 2))
                    For Each cell In row.Cells
                        cell.PadTopPt = Math.Max(0.25, Math.Round(cell.PadTopPt * ratio, 2))
                        cell.PadBottomPt = Math.Max(0.25, Math.Round(cell.PadBottomPt * ratio, 2))
                    Next
                Next
                tbl.HeightPt = tbl.Rows.Sum(Function(r) r.HeightPt)
                If Not tbl.IsRightTrack Then tbl.TopPt = yCursor
            Next
        End Sub

        Private Shared Function CountPdfPages(ByVal pdfBytes As Byte()) As Integer
            Dim txt As String = Encoding.ASCII.GetString(pdfBytes)
            Dim matches = System.Text.RegularExpressions.Regex.Matches(txt, "/Type\s*/Page(?!s)\b")
            Return Math.Max(1, matches.Count)
        End Function

        Private Shared Function CreateDummyDataTable() As DataTable
            Dim dt As New DataTable("dsReport")
            dt.Columns.Add("DocumentTitle", GetType(String))
            Dim row = dt.NewRow()
            row("DocumentTitle") = String.Empty
            dt.Rows.Add(row)
            Return dt
        End Function
    End Class

    Public Module Program
        Public Sub Main(ByVal args As String())
            If args.Length < 3 Then
                Console.Error.WriteLine("Usage: ReportGen.VbCompiler <layout_ir.json> <output.rdlc> <output.pdf> [logical_fill.json]")
                Environment.Exit(2)
            End If

            Dim irPath As String = Path.GetFullPath(args(0))
            Dim outRdlc As String = Path.GetFullPath(args(1))
            Dim outPdf As String = Path.GetFullPath(args(2))

            Dim irDoc = JsonSerializer.Deserialize(Of LayoutIrDocument)(File.ReadAllText(irPath))
            If irDoc Is Nothing Then Throw New InvalidOperationException("Failed to deserialize layout_ir.json.")

            Dim state As New PipelineState With {
                .DocumentTemplate = Path.GetFileNameWithoutExtension(irPath),
                .SourceDocument = irDoc
            }

            Dim solver As New GeometryAndLayoutSolver()
            solver.SolveDocument(state)

            Dim fillInput As LogicalFillRuleInput = If(args.Length >= 4 AndAlso File.Exists(args(3)),
                JsonSerializer.Deserialize(Of LogicalFillRuleInput)(File.ReadAllText(args(3))),
                New LogicalFillRuleInput())
            Dim filler As New LogicalValueFiller()
            filler.FillLogicalValues(state, If(fillInput, New LogicalFillRuleInput()))

            LocalReportRendererAndOrchestrator.RenderWithParityCompaction(state, outRdlc, outPdf)

            Dim storePath As String = Path.Combine(Directory.GetCurrentDirectory(), "output", "vector-store", "vb-artifacts.json")
            Dim vectorStore As New AssistiveVectorArtifactStore(storePath)
            Dim saved = vectorStore.RecordSnapshot(state)

            Console.WriteLine($"VB_COMPILER_OK | Template={saved.Metadata.DocumentTemplate} | Pages={state.RenderedPageCount}/{irDoc.PageCount} | XSD={state.XsdValidationPassed} | ArtifactId={saved.Id}")
        End Sub
    End Module

End Namespace
