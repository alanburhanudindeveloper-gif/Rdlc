Option Strict On
Option Explicit On

Imports System
Imports System.Collections.Generic
Imports System.Linq
Imports System.Text.RegularExpressions
Imports ReportGen.VbCompiler.Contracts

Namespace ReportGen.VbCompiler.Solver

    Public NotInheritable Class GeometryAndLayoutSolver
        Private Const MinGutterPt As Double = 6.0
        Private Const DedupTolPt As Double = 2.0
        Private Const BorderMatchTolPt As Double = 2.5
        Private Const ColonClusterTolPt As Double = 2.5
        Private Const StaircaseClusterTolPt As Double = 3.0
        Private Const BoldMergeXTolPt As Double = 4.0
        Private Const BaselineQuantPt As Double = 1.5
        Private Const LeadingRatioMax As Double = 1.65

        Private Shared ReadOnly StandaloneMarkerRegex As New Regex("^(\(\d+\)|\d+(?:\.\d+)*\.|[a-z]\.|[ivxlcdm]+\.|[•\u2022\-–*])$", RegexOptions.IgnoreCase Or RegexOptions.Compiled)
        Private Shared ReadOnly InlineMarkerRegex As New Regex("^(\(\d+\)|\d+(?:\.\d+)*\.|[a-z]\.|[ivxlcdm]+\.|[•\u2022\-–*])\s+(.+)$", RegexOptions.IgnoreCase Or RegexOptions.Compiled)
        Private Shared ReadOnly InlineColonRegex As New Regex("^(.{2,42}?)\s*([:=])\s+(.+)$", RegexOptions.Compiled)
        Private Shared ReadOnly PrefixColonRegex As New Regex("^([:=])\s+(.+)$", RegexOptions.Compiled)

        Private _nameSeq As Integer = 1

        ''' <summary>
        ''' Gates 1-3: Deterministic XY-Cut segmentation, 6 Geometric Portfolio Solvers (v3.3),
        ''' physical row cuts, independent stream Y-cursors, and exact ColSpan + RemoveAt invariants.
        ''' Zero hardcoded literals, product names, or page numbers.
        ''' </summary>
        Public Sub SolveDocument(ByVal state As PipelineState)
            If state Is Nothing Then Throw New ArgumentNullException(NameOf(state))
            state.CurrentGate = GateStage.Gate2Segmentation
            state.TraceLog.Add("Gate2: Starting deterministic visual sorting and XY-Cut segmentation.")

            Dim compiled As New List(Of CompiledTablix)()
            Dim pages = If(state.SourceDocument.Pages, New List(Of LayoutPageIr)()).OrderBy(Function(p) p.PageIndex).ToList()

            For Each page In pages
                Dim printableW As Double = Math.Max(144.0, page.WidthPt - state.MarginLeftPt - state.MarginRightPt)
                Dim bodyOriginY As Double = If(page.HeaderSpans.Count > 0, Math.Max(state.MarginTopPt, page.HeaderSpans.Max(Function(s) s.Y1) + 2.0), state.MarginTopPt)

                ' [R-ARCH-01] Sort all body spans deterministically in visual order (quantized Y then X)
                Dim relSpans = page.BodySpans.
                    Select(Function(s) ShiftSpanOrigin(s, -state.MarginLeftPt, -bodyOriginY)).
                    OrderBy(Function(s) Math.Floor(s.Y0 / BaselineQuantPt) * BaselineQuantPt).
                    ThenBy(Function(s) s.X0).
                    ToList()

                Dim relHLines = DedupSegments(
                    page.HLines.Select(Function(h) ShiftLineOrigin(h, -state.MarginLeftPt, -bodyOriginY)).ToList(),
                    horizontal:=True)
                Dim relVLines = DedupSegments(
                    page.VLines.Select(Function(v) ShiftLineOrigin(v, -state.MarginLeftPt, -bodyOriginY)).ToList(),
                    horizontal:=False)
                Dim relBanners = page.FillBanners.
                    Select(Function(b) ShiftFillOrigin(b, -state.MarginLeftPt, -bodyOriginY)).
                    OrderBy(Function(b) b.Y0).ThenBy(Function(b) b.X0).
                    ToList()
                Dim relRowFills = page.RowFills.
                    Select(Function(r) ShiftFillOrigin(r, -state.MarginLeftPt, -bodyOriginY)).
                    ToList()

                Dim pageTablixes = CompilePageSections(
                    page.PageIndex,
                    printableW,
                    relSpans,
                    relHLines,
                    relVLines,
                    relBanners,
                    relRowFills,
                    state.AppliedRules)

                compiled.AddRange(pageTablixes)
            Next

            ' [R-PB]: PageBreak ONLY on single top-most outer Tablix (min Top) where sourcePageIndex > 0
            EnforceSinglePageBreakRule(compiled, state.AppliedRules)

            state.CompiledTablixes = compiled
            state.CurrentGate = GateStage.Gate3Solver
            state.TraceLog.Add($"Gate3: Compiled {compiled.Count} top-level Tablix containers deterministically.")
        End Sub

        Private Function CompilePageSections(
            ByVal pageIndex As Integer,
            ByVal printableW As Double,
            ByVal spans As List(Of TextSpanIr),
            ByVal hLines As List(Of LineSegmentIr),
            ByVal vLines As List(Of LineSegmentIr),
            ByVal banners As List(Of FillBoxIr),
            ByVal rowFills As List(Of FillBoxIr),
            ByVal rules As HashSet(Of String)) As List(Of CompiledTablix)

            Dim output As New List(Of CompiledTablix)()
            Dim usedSpanSet As New HashSet(Of TextSpanIr)()

            ' Partition banners into full-width dark banners vs side-by-side pairs
            Dim fullBanners = banners.Where(Function(b) b.Width >= printableW * 0.85).OrderBy(Function(b) b.Y0).ToList()
            Dim fullYBounds As New List(Of Double)()
            For Each fb In fullBanners
                fullYBounds.Add(fb.Y0)
            Next
            fullYBounds.Add(Double.PositiveInfinity)

            Dim cursorTopPt As Double = 0.0
            Dim prevCutY As Double = Double.NegativeInfinity

            For idx As Integer = 0 To fullYBounds.Count - 1
                Dim nextCutY As Double = fullYBounds(idx)
                Dim activeBanner As FillBoxIr = If(idx > 0, fullBanners(idx - 1), Nothing)
                Dim bandMinY As Double = If(activeBanner IsNot Nothing, activeBanner.Y1, prevCutY)

                Dim bandSpans = spans.Where(Function(s) s.CenterY >= bandMinY - 1.5 AndAlso s.CenterY < nextCutY - 1.0 AndAlso Not usedSpanSet.Contains(s)).ToList()
                Dim bannerText As String = String.Empty
                If activeBanner IsNot Nothing Then
                    Dim insideBanner = spans.Where(Function(s) s.CenterY >= activeBanner.Y0 - 2.0 AndAlso s.CenterY <= activeBanner.Y1 + 2.0 AndAlso s.CenterX >= activeBanner.X0 - 3.0 AndAlso s.CenterX <= activeBanner.X1 + 3.0).OrderBy(Function(s) s.X0).ToList()
                    For Each bs In insideBanner
                        usedSpanSet.Add(bs)
                    Next
                    bannerText = String.Join(" ", insideBanner.Select(Function(s) s.Text.Trim())).Trim()
                    bandSpans = bandSpans.Where(Function(s) Not usedSpanSet.Contains(s)).ToList()
                End If

                Dim bandH = hLines.Where(Function(h) h.Y0 >= bandMinY - 2.0 AndAlso h.Y0 < nextCutY).ToList()
                Dim bandV = vLines.Where(Function(v) v.Y1 >= bandMinY - 2.0 AndAlso v.Y0 < nextCutY).ToList()
                Dim bandRF = rowFills.Where(Function(rf) rf.Y1 >= bandMinY - 2.0 AndAlso rf.Y0 < nextCutY).ToList()

                If activeBanner Is Nothing AndAlso bandSpans.Count = 0 Then
                    prevCutY = nextCutY
                    Continue For
                End If

                ' Check [R-PARENT-NESTED]: Dark full-width banner over balanced dual-track streams
                Dim parentGutter As Double = 0.0
                If activeBanner IsNot Nothing AndAlso activeBanner.Luminance < 0.72 AndAlso TryDetectBalancedGutter(bandSpans, bandV, bandH, printableW, parentGutter) Then
                    rules.Add("[R-PARENT-NESTED]")
                    Dim nestedTbl = BuildParentNestedTablix(pageIndex, activeBanner, bannerText, bandSpans, bandH, bandV, bandRF, printableW, parentGutter, cursorTopPt, rules)
                    output.Add(nestedTbl)
                    cursorTopPt = nestedTbl.TopPt + nestedTbl.HeightPt + 4.0
                    prevCutY = nextCutY
                    Continue For
                End If

                ' Check [R-DUAL-TRACK] without parent banner
                Dim dualGutter As Double = 0.0
                If activeBanner Is Nothing AndAlso TryDetectBalancedGutter(bandSpans, bandV, bandH, printableW, dualGutter) Then
                    rules.Add("[R-DUAL-TRACK]")
                    Dim pair = BuildDualTrackPair(pageIndex, bandSpans, bandH, bandV, bandRF, printableW, dualGutter, cursorTopPt, rules)
                    output.Add(pair.Left)
                    output.Add(pair.Right)
                    cursorTopPt = Math.Max(pair.Left.TopPt + pair.Left.HeightPt, pair.Right.TopPt + pair.Right.HeightPt) + 4.0
                    prevCutY = nextCutY
                    Continue For
                End If

                ' Standard full-width section (with optional [R-DENSITY-SPLIT] footnote split)
                Dim singleTbl = CompileSingleContainer(pageIndex, activeBanner, bannerText, bandSpans, bandH, bandV, bandRF, 0.0, printableW, cursorTopPt, False, False, False, rules)
                output.Add(singleTbl)
                cursorTopPt = singleTbl.TopPt + singleTbl.HeightPt + 4.0
                prevCutY = nextCutY
            Next

            Return output
        End Function

        ''' <summary>
        ''' Balanced multi-role gutter detector ([R-PARENT-NESTED] / [R-DUAL-TRACK]):
        ''' Scores candidate gutters so it picks the true track divider (both sides carry labels/operators
        ''' or >=2 VLines) instead of splitting inside a wide Label-to-Value gap.
        ''' </summary>
        Private Function TryDetectBalancedGutter(
            ByVal spans As List(Of TextSpanIr),
            ByVal vLines As List(Of LineSegmentIr),
            ByVal hLines As List(Of LineSegmentIr),
            ByVal widthPt As Double,
            ByRef gutterXPt As Double) As Boolean

            gutterXPt = widthPt / 2.0
            If spans.Count < 4 Then Return False
            If spans.Any(Function(s) s.Width >= widthPt * 0.68) OrElse hLines.Any(Function(h) h.Width >= widthPt * 0.68) Then
                Return False
            End If

            Dim intervals = spans.Select(Function(s) (X0:=s.X0, X1:=s.X1)).OrderBy(Function(iv) iv.X0).ToList()
            Dim merged As New List(Of (X0 As Double, X1 As Double)) From {intervals(0)}
            For i As Integer = 1 To intervals.Count - 1
                Dim cur = intervals(i)
                Dim last = merged(merged.Count - 1)
                If cur.X0 <= last.X1 + 3.0 Then
                    merged(merged.Count - 1) = (last.X0, Math.Max(last.X1, cur.X1))
                Else
                    merged.Add(cur)
                End If
            Next

            Dim bestScore As Double = Double.NegativeInfinity
            Dim bestCenter As Double = 0.0

            For i As Integer = 0 To merged.Count - 2
                Dim gap As Double = merged(i + 1).X0 - merged(i).X1
                Dim center As Double = (merged(i).X1 + merged(i + 1).X0) / 2.0
                If gap < MinGutterPt OrElse center < widthPt * 0.25 OrElse center > widthPt * 0.75 Then Continue For

                Dim anyCrossing As Boolean = spans.Any(Function(s) s.X0 < center - 1.5 AndAlso s.X1 > center + 1.5)
                If anyCrossing Then Continue For

                Dim leftSpans = spans.Where(Function(s) s.CenterX < center).ToList()
                Dim rightSpans = spans.Where(Function(s) s.CenterX >= center).ToList()
                If leftSpans.Count < 2 OrElse rightSpans.Count < 2 Then Continue For

                ' Require overlapping Y bands so top/bottom blocks aren't mistaken for side-by-side tracks
                Dim overlapY As Double = Math.Min(leftSpans.Max(Function(s) s.Y1), rightSpans.Max(Function(s) s.Y1)) -
                                         Math.Max(leftSpans.Min(Function(s) s.Y0), rightSpans.Min(Function(s) s.Y0))
                If overlapY <= -10.0 Then Continue For

                Dim leftV As Integer = vLines.Count(Function(v) v.X0 < center)
                Dim rightV As Integer = vLines.Count(Function(v) v.X0 > center)
                Dim leftOps = FindAlignedOperatorXs(leftSpans)
                Dim rightOps = FindAlignedOperatorXs(rightSpans)

                ' Reject intra-KV splits where rightSide starts directly at ':' without any labels left of ':'
                Dim rightStartsColonOnly As Boolean = rightOps.Count >= 1 AndAlso Not rightSpans.Any(Function(s) s.X1 <= rightOps(0) - 2.0 AndAlso Not PrefixColonRegex.IsMatch(s.Text.Trim()))
                If rightStartsColonOnly AndAlso (leftV < 2 OrElse rightV < 2) Then Continue For

                Dim hasPaired As Boolean = (leftV >= 2 AndAlso rightV >= 2) OrElse (leftOps.Count >= 1 AndAlso rightOps.Count >= 1) OrElse (leftSpans.Count >= 3 AndAlso rightSpans.Count >= 3)
                If Not hasPaired Then Continue For

                Dim score As Double = gap + (If(leftOps.Count >= 1 AndAlso rightOps.Count >= 1, 60.0, 0.0)) + (If(leftV >= 2 AndAlso rightV >= 2, 50.0, 0.0)) + Math.Min(leftSpans.Count, rightSpans.Count) * 3.0 - Math.Abs(center - widthPt / 2.0) * 1.4
                If score > bestScore Then
                    bestScore = score
                    bestCenter = center
                End If
            Next

            If bestScore > 0.0 Then
                gutterXPt = Math.Round(bestCenter, 2)
                Return True
            End If
            Return False
        End Function

        Private Function BuildParentNestedTablix(
            ByVal pageIndex As Integer,
            ByVal banner As FillBoxIr,
            ByVal bannerText As String,
            ByVal spans As List(Of TextSpanIr),
            ByVal hLines As List(Of LineSegmentIr),
            ByVal vLines As List(Of LineSegmentIr),
            ByVal rowFills As List(Of FillBoxIr),
            ByVal widthPt As Double,
            ByVal gutterXPt As Double,
            ByVal topPt As Double,
            ByVal rules As HashSet(Of String)) As CompiledTablix

            Dim halfGap As Double = MinGutterPt / 2.0
            Dim leftW As Double = Math.Round(Math.Clamp(gutterXPt - halfGap, 72.0, widthPt - 72.0 - MinGutterPt), 2)
            Dim rightLeft As Double = Math.Round(leftW + MinGutterPt, 2)
            Dim rightW As Double = Math.Round(Math.Max(72.0, widthPt - leftW), 2)

            Dim leftChild = CompileSingleContainer(
                pageIndex, Nothing, String.Empty,
                spans.Where(Function(s) s.CenterX < gutterXPt).ToList(),
                hLines.Where(Function(h) h.X1 <= gutterXPt + 2.0).ToList(),
                vLines.Where(Function(v) v.X0 < gutterXPt).ToList(),
                rowFills.Where(Function(r) r.X1 <= gutterXPt + 2.0).ToList(),
                0.0, leftW, 0.0, True, False, False, rules)

            Dim rightChild = CompileSingleContainer(
                pageIndex, Nothing, String.Empty,
                spans.Where(Function(s) s.CenterX >= gutterXPt).Select(Function(s) ShiftSpanOrigin(s, -rightLeft, 0.0)).ToList(),
                hLines.Where(Function(h) h.X0 >= gutterXPt - 2.0).Select(Function(h) ShiftLineOrigin(h, -rightLeft, 0.0)).ToList(),
                vLines.Where(Function(v) v.X0 >= gutterXPt).Select(Function(v) ShiftLineOrigin(v, -rightLeft, 0.0)).ToList(),
                rowFills.Where(Function(r) r.X0 >= gutterXPt - 2.0).Select(Function(r) ShiftFillOrigin(r, -rightLeft, 0.0)).ToList(),
                0.0, Math.Max(72.0, widthPt - rightLeft), 0.0, True, True, False, rules)

            Dim bannerH As Double = Math.Max(16.0, Math.Round(banner.Height, 2))
            Dim bodyH As Double = Math.Max(18.0, Math.Max(leftChild.HeightPt, rightChild.HeightPt))

            Dim r0 As New CompiledRow With {
                .HeightPt = bannerH,
                .IsHeaderRow = True,
                .Cells = New List(Of CompiledCell) From {BuildBannerCell(banner, bannerText, 2)}
            }
            Dim r1 As New CompiledRow With {
                .HeightPt = bodyH,
                .Cells = New List(Of CompiledCell) From {
                    New CompiledCell With {.Name = NextName("NestedLeft"), .ColSpan = 1, .NestedTablix = leftChild},
                    New CompiledCell With {.Name = NextName("NestedRight"), .ColSpan = 1, .NestedTablix = rightChild}
                }
            }

            Return New CompiledTablix With {
                .Name = NextName($"Tablix_P{pageIndex + 1}_ParentNested"),
                .SourcePageIndex = pageIndex,
                .Strategy = SolverStrategyKind.ParentNestedBannerGrid,
                .BorderMode = BorderRuleKind.None,
                .TopPt = topPt,
                .LeftPt = 0.0,
                .WidthPt = widthPt,
                .HeightPt = bannerH + bodyH,
                .ColumnWidthsPt = New List(Of Double) From {leftW, rightW},
                .Rows = New List(Of CompiledRow) From {r0, r1}
            }
        End Function

        Private Function BuildDualTrackPair(
            ByVal pageIndex As Integer,
            ByVal spans As List(Of TextSpanIr),
            ByVal hLines As List(Of LineSegmentIr),
            ByVal vLines As List(Of LineSegmentIr),
            ByVal rowFills As List(Of FillBoxIr),
            ByVal widthPt As Double,
            ByVal gutterXPt As Double,
            ByVal topPt As Double,
            ByVal rules As HashSet(Of String)) As (Left As CompiledTablix, Right As CompiledTablix)

            Dim halfGap As Double = MinGutterPt / 2.0
            Dim leftW As Double = Math.Round(Math.Clamp(gutterXPt - halfGap, 72.0, widthPt - 72.0 - MinGutterPt), 2)
            Dim rightLeft As Double = Math.Round(leftW + MinGutterPt, 2)
            Dim rightW As Double = Math.Round(Math.Max(72.0, widthPt - rightLeft), 2)

            Dim leftTbl = CompileSingleContainer(
                pageIndex, Nothing, String.Empty,
                spans.Where(Function(s) s.CenterX < gutterXPt).ToList(),
                hLines.Where(Function(h) h.X1 <= gutterXPt + 2.0).ToList(),
                vLines.Where(Function(v) v.X0 < gutterXPt).ToList(),
                rowFills.Where(Function(r) r.X1 <= gutterXPt + 2.0).ToList(),
                0.0, leftW, topPt, False, False, False, rules)

            Dim rightTbl = CompileSingleContainer(
                pageIndex, Nothing, String.Empty,
                spans.Where(Function(s) s.CenterX >= gutterXPt).Select(Function(s) ShiftSpanOrigin(s, -rightLeft, 0.0)).ToList(),
                hLines.Where(Function(h) h.X0 >= gutterXPt - 2.0).Select(Function(h) ShiftLineOrigin(h, -rightLeft, 0.0)).ToList(),
                vLines.Where(Function(v) v.X0 >= gutterXPt).Select(Function(v) ShiftLineOrigin(v, -rightLeft, 0.0)).ToList(),
                rowFills.Where(Function(r) r.X0 >= gutterXPt - 2.0).Select(Function(r) ShiftFillOrigin(r, -rightLeft, 0.0)).ToList(),
                rightLeft, rightW, topPt, False, True, False, rules)

            Return (leftTbl, rightTbl)
        End Function

        Private Function CompileSingleContainer(
            ByVal pageIndex As Integer,
            ByVal banner As FillBoxIr,
            ByVal bannerText As String,
            ByVal spans As List(Of TextSpanIr),
            ByVal hLines As List(Of LineSegmentIr),
            ByVal vLines As List(Of LineSegmentIr),
            ByVal rowFills As List(Of FillBoxIr),
            ByVal leftPt As Double,
            ByVal widthPt As Double,
            ByVal topPt As Double,
            ByVal isNested As Boolean,
            ByVal isRightTrack As Boolean,
            ByVal forceFootnote As Boolean,
            ByVal rules As HashSet(Of String)) As CompiledTablix

            Dim hasEmbeddedSubGrid As Boolean = DetectEmbeddedSubGridZones(spans, vLines, hLines)
            Dim strategy As SolverStrategyKind = SelectStrategy(spans, hLines, vLines, rowFills, widthPt, forceFootnote, hasEmbeddedSubGrid)
            rules.Add($"[{strategy}]")

            Dim borderMode As BorderRuleKind = ResolveBorderRule(strategy, hLines, vLines, widthPt)
            Dim built = If(strategy = SolverStrategyKind.PlanarGridSolver,
                BuildPlanarGridRows(spans, hLines, vLines, rowFills, widthPt, rules),
                BuildStructuredTrackRows(strategy, spans, hLines, vLines, rowFills, widthPt, rules))

            Dim colWidths = built.ColWidthsPt
            Dim rows = built.Rows

            If banner IsNot Nothing Then
                rows.Insert(0, New CompiledRow With {
                    .HeightPt = Math.Max(16.0, Math.Round(banner.Height, 2)),
                    .IsHeaderRow = True,
                    .SourceY0Pt = banner.Y0,
                    .SourceY1Pt = banner.Y1,
                    .Cells = New List(Of CompiledCell) From {BuildBannerCell(banner, bannerText, colWidths.Count)}
                })
                rules.Add("[R-ROW-PHYS]")
            End If

            If strategy <> SolverStrategyKind.PlanarGridSolver Then
                ConvergeProseAndKvContinuationMerge(rows, colWidths, hLines, rowFills, banner IsNot Nothing, rules)
            End If

            ApplyBorderRules(rows, colWidths, borderMode, hLines, vLines, widthPt, banner IsNot Nothing, rules)
            EnsureRowColSpanInvariants(rows, colWidths.Count)

            Dim totalH As Double = Math.Max(14.0, rows.Sum(Function(r) r.HeightPt))
            Return New CompiledTablix With {
                .Name = NextName(If(isNested, If(isRightTrack, $"NestedRight_P{pageIndex + 1}", $"NestedLeft_P{pageIndex + 1}"), If(isRightTrack, $"Tablix_Right_P{pageIndex + 1}", $"Tablix_P{pageIndex + 1}"))),
                .SourcePageIndex = pageIndex,
                .Strategy = strategy,
                .BorderMode = borderMode,
                .IsNested = isNested,
                .IsRightTrack = isRightTrack,
                .TopPt = topPt,
                .LeftPt = leftPt,
                .WidthPt = widthPt,
                .HeightPt = totalH,
                .ColumnWidthsPt = colWidths,
                .Rows = rows
            }
        End Function

        Private Function DetectEmbeddedSubGridZones(
            ByVal spans As List(Of TextSpanIr),
            ByVal vLines As List(Of LineSegmentIr),
            ByVal hLines As List(Of LineSegmentIr)) As Boolean

            If vLines.Count < 2 OrElse spans.Count < 2 Then Return False
            Dim minVY As Double = vLines.Min(Function(v) v.Y0)
            Dim maxVY As Double = vLines.Max(Function(v) v.Y1)
            Dim outsideTextCount As Integer = spans.Count(Function(s) s.CenterY < minVY - 4.0 OrElse s.CenterY > maxVY + 4.0)
            Dim leftLabelCount As Integer = spans.Count(Function(s) s.X1 < vLines.Min(Function(v) v.X0) - 4.0)
            Return outsideTextCount >= 2 OrElse leftLabelCount >= 2
        End Function

        Private Function SelectStrategy(
            ByVal spans As List(Of TextSpanIr),
            ByVal hLines As List(Of LineSegmentIr),
            ByVal vLines As List(Of LineSegmentIr),
            ByVal rowFills As List(Of FillBoxIr),
            ByVal widthPt As Double,
            ByVal forceFootnote As Boolean,
            ByVal hasEmbeddedSubGrid As Boolean) As SolverStrategyKind

            If forceFootnote Then Return SolverStrategyKind.DensityTransitionSplitter
            If hasEmbeddedSubGrid Then Return SolverStrategyKind.KeyValueSubGridFlattener
            If vLines.Count >= 3 Then Return SolverStrategyKind.PlanarGridSolver

            Dim opXs = FindAlignedOperatorXs(spans)
            If opXs.Count >= 1 Then
                Dim hasWideH As Boolean = hLines.Any(Function(h) h.Width >= widthPt * 0.85)
                Return If(hasWideH, SolverStrategyKind.HLineOperatorSolver, SolverStrategyKind.KeyValueSubGridFlattener)
            End If

            If rowFills.Count >= 2 AndAlso vLines.Count >= 1 Then
                Return SolverStrategyKind.KeyValueSubGridFlattener
            End If

            Return SolverStrategyKind.IndentationClauseSolver
        End Function

        Private Shared Function ResolveBorderRule(
            ByVal strategy As SolverStrategyKind,
            ByVal hLines As List(Of LineSegmentIr),
            ByVal vLines As List(Of LineSegmentIr),
            ByVal widthPt As Double) As BorderRuleKind

            If strategy = SolverStrategyKind.PlanarGridSolver Then Return BorderRuleKind.Grid
            Dim hasTopH As Boolean = hLines.Any(Function(h) h.Width >= widthPt * 0.8)
            Dim hasLeftV As Boolean = vLines.Any(Function(v) v.X0 <= 6.0 AndAlso v.Height >= 24.0)
            Dim hasRightV As Boolean = vLines.Any(Function(v) v.X0 >= widthPt - 6.0 AndAlso v.Height >= 24.0)
            If hasTopH AndAlso hasLeftV AndAlso hasRightV AndAlso vLines.Count <= 3 Then Return BorderRuleKind.Box
            If hLines.Count >= 1 AndAlso vLines.Count = 0 Then Return BorderRuleKind.HLine
            Return BorderRuleKind.None
        End Function

        Private Function BuildPlanarGridRows(
            ByVal spans As List(Of TextSpanIr),
            ByVal hLines As List(Of LineSegmentIr),
            ByVal vLines As List(Of LineSegmentIr),
            ByVal rowFills As List(Of FillBoxIr),
            ByVal widthPt As Double,
            ByVal rules As HashSet(Of String)) As (ColWidthsPt As List(Of Double), Rows As List(Of CompiledRow))

            Dim rawXs As New List(Of Double) From {0.0, widthPt}
            rawXs.AddRange(vLines.Select(Function(v) Math.Clamp(v.X0, 0.0, widthPt)))
            Dim colBounds = PruneEmptyEdgeGhostColumns(DeduplicateGridBounds(ClusterValues(rawXs, BorderMatchTolPt), 8.0, widthPt), spans, vLines, widthPt)
            Dim numCols As Integer = Math.Max(1, colBounds.Count - 1)
            Dim colWidths = Enumerable.Range(0, numCols).Select(Function(c) Math.Round(colBounds(c + 1) - colBounds(c), 2)).ToList()

            Dim wideHLines = hLines.Where(Function(h) h.Width >= widthPt * 0.78).OrderBy(Function(h) h.Y0).ToList()
            Dim rawYs As New List(Of Double)()
            If vLines.Count >= 6 AndAlso wideHLines.Count >= 2 Then
                rules.Add("[R-OUTER-LOCK]")
                rawYs.AddRange(wideHLines.Select(Function(h) h.Y0))
            Else
                rawYs.AddRange(hLines.Select(Function(h) h.Y0))
                rawYs.AddRange(rowFills.SelectMany(Function(rf) New Double() {rf.Y0, rf.Y1}))
            End If

            Dim gridYs = ClusterValues(rawYs, DedupTolPt)
            If gridYs.Count < 2 AndAlso spans.Count > 0 Then
                gridYs = New List(Of Double) From {spans.Min(Function(s) s.Y0) - 2.0, spans.Max(Function(s) s.Y1) + 2.0}
            End If

            Dim rows As New List(Of CompiledRow)()
            For r As Integer = 0 To gridYs.Count - 2
                Dim yA As Double = gridYs(r)
                Dim yB As Double = gridYs(r + 1)
                If yB - yA < 4.0 Then Continue For
                Dim midY As Double = (yA + yB) / 2.0
                Dim rowSpans = spans.Where(Function(s) s.CenterY >= yA - 2.0 AndAlso s.CenterY <= yB + 2.0).ToList()
                Dim rowFill = rowFills.FirstOrDefault(Function(rf) midY >= rf.Y0 - 1.5 AndAlso midY <= rf.Y1 + 1.5)
                If rowSpans.Count = 0 AndAlso rowFill Is Nothing Then Continue For

                Dim activeBounds As New List(Of Integer) From {0}
                For c As Integer = 1 To numCols - 1
                    Dim bx As Double = colBounds(c)
                    If vLines.Any(Function(v) Math.Abs(v.X0 - bx) <= BorderMatchTolPt AndAlso v.Y0 - 2.0 <= midY AndAlso midY <= v.Y1 + 2.0) Then
                        activeBounds.Add(c)
                    End If
                Next
                activeBounds.Add(numCols)

                Dim cells As New List(Of CompiledCell)()
                For g As Integer = 0 To activeBounds.Count - 2
                    Dim sCol As Integer = activeBounds(g)
                    Dim eCol As Integer = activeBounds(g + 1) - 1
                    Dim spanCols As Integer = eCol - sCol + 1
                    Dim x0 As Double = colBounds(sCol)
                    Dim x1 As Double = colBounds(eCol + 1)
                    Dim cellSpans = rowSpans.Where(Function(s) s.CenterX >= x0 - 2.0 AndAlso s.CenterX <= x1 + 2.0).
                        OrderBy(Function(s) Math.Floor(s.Y0 / BaselineQuantPt) * BaselineQuantPt).
                        ThenBy(Function(s) s.X0).
                        ToList()
                    Dim primary = cellSpans.FirstOrDefault()
                    Dim fs As Double = If(primary IsNot Nothing, primary.FontSize, 8.5)
                    cells.Add(New CompiledCell With {
                        .ColSpan = spanCols,
                        .Name = NextName("Cell"),
                        .Text = JoinCellSpans(cellSpans),
                        .FontFamily = If(primary IsNot Nothing, primary.FontName, "Arial"),
                        .FontSizePt = fs,
                        .IsBold = If(primary IsNot Nothing, primary.IsBold, r = 0),
                        .IsItalic = If(primary IsNot Nothing, primary.IsItalic, False),
                        .TextColorHex = If(primary IsNot Nothing, primary.ColorHex, "#0F172A"),
                        .BackgroundHex = rowFill?.FillHex,
                        .TextAlign = InferCellAlign(cellSpans, x0, x1, r = 0),
                        .LineHeightPt = Math.Round(fs * 1.25, 2),
                        .SourceLineCount = Math.Max(1, cellSpans.Select(Function(s) Math.Round(s.Y0 / 2.0)).Distinct().Count()),
                        .SourceX0Pt = If(primary IsNot Nothing, primary.X0, x0)
                    })
                Next

                rows.Add(New CompiledRow With {
                    .HeightPt = Math.Max(Math.Round(yB - yA, 2), EstimateRowHeightPt(cells, colWidths)),
                    .IsHeaderRow = r = 0,
                    .SourceY0Pt = yA,
                    .SourceY1Pt = yB,
                    .Cells = cells
                })
            Next

            Return (colWidths, rows)
        End Function

        Private Function BuildStructuredTrackRows(
            ByVal strategy As SolverStrategyKind,
            ByVal spans As List(Of TextSpanIr),
            ByVal hLines As List(Of LineSegmentIr),
            ByVal vLines As List(Of LineSegmentIr),
            ByVal rowFills As List(Of FillBoxIr),
            ByVal widthPt As Double,
            ByVal rules As HashSet(Of String)) As (ColWidthsPt As List(Of Double), Rows As List(Of CompiledRow))

            Dim opXs = FindAlignedOperatorXs(spans)
            Dim yRows = ClusterSpansIntoRows(spans)
            Dim rawColBounds As New List(Of Double) From {0.0, widthPt}

            If strategy = SolverStrategyKind.HLineOperatorSolver OrElse strategy = SolverStrategyKind.KeyValueSubGridFlattener Then
                rules.Add("[R-COLON-GRID]")
                For Each opX In opXs
                    rawColBounds.Add(Math.Clamp(opX, 8.0, widthPt - 16.0))
                    rawColBounds.Add(Math.Clamp(opX + 9.0, 16.0, widthPt - 8.0))
                Next
            End If

            If strategy = SolverStrategyKind.IndentationClauseSolver Then
                rules.Add("[R-STAIRCASE]")
                For Each sp In spans
                    Dim t = sp.Text.Trim()
                    Dim m = InlineMarkerRegex.Match(t)
                    If m.Success Then
                        Dim mw As Double = Math.Clamp(m.Groups(1).Value.Length * sp.FontSize * 0.6 + 4.0, 10.0, 24.0)
                        rawColBounds.Add(sp.X0)
                        rawColBounds.Add(Math.Min(widthPt - 12.0, sp.X0 + mw))
                    ElseIf sp.X0 >= 8.0 AndAlso sp.X0 <= widthPt - 16.0 Then
                        rawColBounds.Add(sp.X0)
                    End If
                Next
            End If

            If vLines.Count >= 1 Then
                rules.Add("[R-SUBGRID-STACK]")
                rawColBounds.AddRange(vLines.Select(Function(v) Math.Clamp(v.X0, 0.0, widthPt)))
            End If

            Dim colBounds = PruneEmptyEdgeGhostColumns(DeduplicateGridBounds(ClusterValues(rawColBounds, 2.5), 8.0, widthPt), spans, vLines, widthPt)
            Dim numCols As Integer = Math.Max(1, colBounds.Count - 1)
            Dim colWidths = Enumerable.Range(0, numCols).Select(Function(c) Math.Round(colBounds(c + 1) - colBounds(c), 2)).ToList()

            Dim compiledRows As New List(Of CompiledRow)()
            For Each rSpans In yRows
                Dim expanded = SplitInlineMarkersAndOperators(rSpans, strategy, opXs)
                If expanded.Count = 0 Then Continue For

                Dim y0 As Double = rSpans.Min(Function(s) s.Y0)
                Dim y1 As Double = rSpans.Max(Function(s) s.Y1)
                Dim midY As Double = (y0 + y1) / 2.0
                Dim rowFill = rowFills.FirstOrDefault(Function(rf) midY >= rf.Y0 - 1.5 AndAlso midY <= rf.Y1 + 1.5)
                Dim primary = expanded(0)

                Dim cells As New List(Of CompiledCell)(numCols)
                For c As Integer = 0 To numCols - 1
                    cells.Add(New CompiledCell With {.ColSpan = 1, .Name = NextName("Empty"), .Text = String.Empty, .FontSizePt = primary.FontSize, .BackgroundHex = rowFill?.FillHex})
                Next

                For Each sp In expanded
                    Dim sCol As Integer = FindClosestStartCol(sp.X0, colBounds, numCols)
                    cells(sCol) = New CompiledCell With {
                        .ColSpan = 1,
                        .Name = NextName("Cell"),
                        .Text = sp.Text.Trim(),
                        .FontFamily = sp.FontName,
                        .FontSizePt = sp.FontSize,
                        .IsBold = sp.IsBold,
                        .IsItalic = sp.IsItalic,
                        .TextColorHex = sp.ColorHex,
                        .BackgroundHex = rowFill?.FillHex,
                        .TextAlign = If(sp.Text.Trim() = ":" OrElse sp.Text.Trim() = "=", "Center", "Left"),
                        .LineHeightPt = Math.Round(sp.FontSize * 1.3, 2),
                        .SourceLineCount = 1,
                        .SourceX0Pt = sp.X0
                    }
                Next

                ExpandColSpanAndRemoveEmpty(cells)

                compiledRows.Add(New CompiledRow With {
                    .HeightPt = EstimateRowHeightPt(cells, colWidths),
                    .IsBoldTitleRow = expanded.Count = 1 AndAlso primary.IsBold,
                    .IsSubTableRow = vLines.Any(Function(v) v.Y0 - 2.0 <= midY AndAlso midY <= v.Y1 + 2.0),
                    .SourceY0Pt = y0,
                    .SourceY1Pt = y1,
                    .Cells = cells
                })
            Next

            Return (colWidths, compiledRows)
        End Function

        ''' <summary>
        ''' Array Mutation Protocol: Updates cell.ColSpan AND calls RemoveAt on absorbed empty trailing cells
        ''' while tracking logical column index with accumulator (logicalCol += cell.ColSpan).
        ''' </summary>
        Public Shared Sub ExpandColSpanAndRemoveEmpty(ByVal cells As List(Of CompiledCell))
            Dim logicalCol As Integer = 0
            Dim i As Integer = 0
            While i < cells.Count
                Dim cur = cells(i)
                If String.IsNullOrWhiteSpace(cur.Text) AndAlso Not cur.IsNestedTablix Then
                    logicalCol += cur.ColSpan
                    i += 1
                    Continue While
                End If

                While i + 1 < cells.Count AndAlso String.IsNullOrWhiteSpace(cells(i + 1).Text) AndAlso Not cells(i + 1).IsNestedTablix
                    cur.ColSpan += cells(i + 1).ColSpan
                    cells.RemoveAt(i + 1)
                End While

                logicalCol += cur.ColSpan
                i += 1
            End While
        End Sub

        Private Shared Sub EnsureRowColSpanInvariants(ByVal rows As List(Of CompiledRow), ByVal numCols As Integer)
            For Each row In rows
                Dim sumSpan As Integer = row.Cells.Sum(Function(c) c.ColSpan)
                If sumSpan < numCols AndAlso row.Cells.Count > 0 Then
                    row.Cells(row.Cells.Count - 1).ColSpan += (numCols - sumSpan)
                End If
            Next
        End Sub

        ''' <summary>
        ''' [R-ROW-BOLD-MERGE] + [R-COLON-GRID]: Convergent while loop merging consecutive Regular
        ''' prose rows AND multi-line KV Label/Value continuations when no HLine/RowFillBand divider separates them.
        ''' </summary>
        Private Shared Sub ConvergeProseAndKvContinuationMerge(
            ByVal rows As List(Of CompiledRow),
            ByVal colWidthsPt As List(Of Double),
            ByVal hLines As List(Of LineSegmentIr),
            ByVal rowFills As List(Of FillBoxIr),
            ByVal hasBannerRow As Boolean,
            ByVal rules As HashSet(Of String))

            rules.Add("[R-ROW-BOLD-MERGE]")
            Dim startIdx As Integer = If(hasBannerRow, 1, 0)
            Dim changed As Boolean
            Do
                changed = False
                Dim i As Integer = startIdx
                While i + 1 < rows.Count
                    Dim r1 = rows(i)
                    Dim r2 = rows(i + 1)
                    If r1.IsHeaderRow OrElse r2.IsHeaderRow OrElse r1.IsBoldTitleRow OrElse r2.IsBoldTitleRow OrElse r1.IsSubTableRow OrElse r2.IsSubTableRow Then
                        i += 1
                        Continue While
                    End If

                    Dim dy As Double = r2.SourceY0Pt - r1.SourceY0Pt
                    Dim hasDivider As Boolean = hLines.Any(Function(h) h.Y0 >= r1.SourceY1Pt - 1.5 AndAlso h.Y0 <= r2.SourceY0Pt + 1.5) OrElse
                                                rowFills.Any(Function(rf) Math.Abs(rf.Y0 - r2.SourceY0Pt) <= 2.0 OrElse Math.Abs(rf.Y1 - r1.SourceY1Pt) <= 2.0)
                    If hasDivider OrElse dy <= 0 Then
                        i += 1
                        Continue While
                    End If

                    Dim map1 = MapCellsByLogicalCol(r1.Cells)
                    Dim map2 = MapCellsByLogicalCol(r2.Cells)
                    Dim nonEmpty2 = map2.Where(Function(kv) Not String.IsNullOrWhiteSpace(kv.Value.Text)).ToList()
                    If nonEmpty2.Count = 0 Then
                        i += 1
                        Continue While
                    End If

                    Dim r2HasNewKvOrMarker As Boolean = nonEmpty2.Any(Function(kv)
                                                                          Dim txt = kv.Value.Text.Trim()
                                                                          Return txt = ":" OrElse txt = "=" OrElse InlineMarkerRegex.IsMatch(txt) OrElse StandaloneMarkerRegex.IsMatch(txt)
                                                                      End Function)
                    If r2HasNewKvOrMarker Then
                        i += 1
                        Continue While
                    End If

                    Dim canAlignAll As Boolean = nonEmpty2.All(Function(kv)
                                                                   Dim targetCell As CompiledCell = Nothing
                                                                   If Not map1.TryGetValue(kv.Key, targetCell) Then Return False
                                                                   If String.IsNullOrWhiteSpace(targetCell.Text) Then Return False
                                                                   Dim targetTrim As String = targetCell.Text.Trim()
                                                                   If targetTrim = ":" OrElse targetTrim = "=" OrElse StandaloneMarkerRegex.IsMatch(targetTrim) Then Return False
                                                                   If targetCell.IsBold OrElse kv.Value.IsBold OrElse targetCell.ColSpan <> kv.Value.ColSpan Then Return False
                                                                   Dim maxLead As Double = Math.Max(8.5, targetCell.FontSizePt) * LeadingRatioMax
                                                                   Return dy <= maxLead AndAlso Math.Abs(targetCell.SourceX0Pt - kv.Value.SourceX0Pt) <= BoldMergeXTolPt AndAlso If(targetCell.BackgroundHex, "") = If(kv.Value.BackgroundHex, "")
                                                               End Function)

                    If canAlignAll Then
                        For Each kv In nonEmpty2
                            Dim targetCell = map1(kv.Key)
                            Dim sep As String = If(targetCell.Text.Trim().EndsWith(":"), Environment.NewLine, " ")
                            targetCell.Text = $"{targetCell.Text.Trim()}{sep}{kv.Value.Text.Trim()}"
                            targetCell.SourceLineCount += kv.Value.SourceLineCount
                        Next
                        r1.SourceY1Pt = Math.Max(r1.SourceY1Pt, r2.SourceY1Pt)
                        r1.HeightPt = EstimateRowHeightPt(r1.Cells, colWidthsPt)
                        rows.RemoveAt(i + 1)
                        changed = True
                        Continue While
                    End If

                    i += 1
                End While
            Loop While changed
        End Sub

        Private Shared Function MapCellsByLogicalCol(ByVal cells As List(Of CompiledCell)) As Dictionary(Of Integer, CompiledCell)
            Dim dict As New Dictionary(Of Integer, CompiledCell)()
            Dim col As Integer = 0
            For Each c In cells
                dict(col) = c
                col += c.ColSpan
            Next
            Return dict
        End Function

        Private Shared Sub ApplyBorderRules(
            ByVal rows As List(Of CompiledRow),
            ByVal colWidthsPt As List(Of Double),
            ByVal borderMode As BorderRuleKind,
            ByVal hLines As List(Of LineSegmentIr),
            ByVal vLines As List(Of LineSegmentIr),
            ByVal widthPt As Double,
            ByVal hasBannerRow As Boolean,
            ByVal rules As HashSet(Of String))

            Dim startIdx As Integer = If(hasBannerRow, 1, 0)
            If borderMode = BorderRuleKind.None Then
                rules.Add("[R-B-NONE]")
                Return
            End If

            rules.Add($"[R-B-{borderMode.ToString().ToUpperInvariant()}]")
            Dim colBounds As New List(Of Double) From {0.0}
            For Each w In colWidthsPt
                colBounds.Add(colBounds(colBounds.Count - 1) + w)
            Next

            For r As Integer = startIdx To rows.Count - 1
                Dim row = rows(r)
                Dim logicalCol As Integer = 0
                For Each cell In row.Cells
                    Dim x0 As Double = colBounds(Math.Min(logicalCol, colBounds.Count - 1))
                    Dim x1 As Double = colBounds(Math.Min(logicalCol + cell.ColSpan, colBounds.Count - 1))
                    logicalCol += cell.ColSpan

                    If borderMode = BorderRuleKind.Grid OrElse row.IsSubTableRow Then
                        cell.BorderTopStyle = If(HasHLineCoverage(hLines, row.SourceY0Pt, x0, x1), "Solid", "None")
                        cell.BorderBottomStyle = If(HasHLineCoverage(hLines, row.SourceY1Pt, x0, x1), "Solid", "None")
                        cell.BorderLeftStyle = If(HasVLineCoverage(vLines, x0, row.SourceY0Pt, row.SourceY1Pt), "Solid", "None")
                        cell.BorderRightStyle = If(HasVLineCoverage(vLines, x1, row.SourceY0Pt, row.SourceY1Pt), "Solid", "None")
                    ElseIf borderMode = BorderRuleKind.Box Then
                        cell.BorderTopStyle = If(r = startIdx OrElse HasHLineCoverage(hLines, row.SourceY0Pt, x0, x1), "Solid", "None")
                        cell.BorderBottomStyle = If(r = rows.Count - 1, "Solid", "None")
                        cell.BorderLeftStyle = If(logicalCol - cell.ColSpan = 0, "Solid", "None")
                        cell.BorderRightStyle = If(logicalCol >= colWidthsPt.Count, "Solid", "None")
                    ElseIf borderMode = BorderRuleKind.HLine Then
                        cell.BorderTopStyle = If(HasHLineCoverage(hLines, row.SourceY0Pt, x0, x1), "Solid", "None")
                        cell.BorderBottomStyle = If(HasHLineCoverage(hLines, row.SourceY1Pt, x0, x1), "Solid", "None")
                    End If
                Next
            Next
        End Sub

        Private Shared Function HasHLineCoverage(ByVal hLines As List(Of LineSegmentIr), ByVal yTarget As Double, ByVal x0 As Double, ByVal x1 As Double) As Boolean
            Dim spanW As Double = Math.Max(4.0, x1 - x0)
            Return hLines.Any(Function(h) Math.Abs(h.Y0 - yTarget) <= BorderMatchTolPt AndAlso (Math.Min(x1, h.X1) - Math.Max(x0, h.X0)) >= spanW * 0.7)
        End Function

        Private Shared Function HasVLineCoverage(ByVal vLines As List(Of LineSegmentIr), ByVal xTarget As Double, ByVal y0 As Double, ByVal y1 As Double) As Boolean
            Dim spanH As Double = Math.Max(4.0, y1 - y0)
            Return vLines.Any(Function(v) Math.Abs(v.X0 - xTarget) <= BorderMatchTolPt AndAlso (Math.Min(y1, v.Y1) - Math.Max(y0, v.Y0)) >= spanH * 0.7)
        End Function

        Private Shared Sub EnforceSinglePageBreakRule(ByVal tablixes As List(Of CompiledTablix), ByVal rules As HashSet(Of String))
            rules.Add("[R-PB]")
            For Each tbl In tablixes
                tbl.PageBreakStart = False
            Next
            For Each grp In tablixes.GroupBy(Function(t) t.SourcePageIndex).Where(Function(g) g.Key > 0)
                Dim topMost = grp.Where(Function(t) Not t.IsRightTrack AndAlso Not t.IsNested).OrderBy(Function(t) t.TopPt).FirstOrDefault()
                If topMost Is Nothing Then
                    topMost = grp.OrderBy(Function(t) t.TopPt).FirstOrDefault()
                End If
                If topMost IsNot Nothing Then topMost.PageBreakStart = True
            Next
        End Sub

        Private Shared Function FindAlignedOperatorXs(ByVal spans As List(Of TextSpanIr)) As List(Of Double)
            Dim candXs As New List(Of Double)()
            For Each sp In spans
                Dim t As String = sp.Text.Trim()
                If t = ":" OrElse t = "=" Then
                    candXs.Add(sp.X0)
                Else
                    Dim pm = PrefixColonRegex.Match(t)
                    If pm.Success Then
                        candXs.Add(sp.X0)
                    Else
                        Dim im = InlineColonRegex.Match(t)
                        If im.Success Then
                            Dim ratio As Double = (im.Groups(1).Value.Length + 0.5) / Math.Max(1, t.Length)
                            candXs.Add(sp.X0 + sp.Width * ratio)
                        End If
                    End If
                End If
            Next
            Dim clustered = ClusterValues(candXs, ColonClusterTolPt)
            Return clustered.Where(Function(cx) candXs.Count(Function(x) Math.Abs(x - cx) <= ColonClusterTolPt) >= 2).ToList()
        End Function

        Private Shared Function SplitInlineMarkersAndOperators(ByVal rowSpans As List(Of TextSpanIr), ByVal strategy As SolverStrategyKind, ByVal alignedOpXs As List(Of Double)) As List(Of TextSpanIr)
            Dim result As New List(Of TextSpanIr)()
            For Each sp In rowSpans
                Dim t As String = sp.Text.Trim()
                If strategy = SolverStrategyKind.IndentationClauseSolver Then
                    Dim mm = InlineMarkerRegex.Match(t)
                    If mm.Success Then
                        Dim mw As Double = Math.Clamp(mm.Groups(1).Value.Length * sp.FontSize * 0.6 + 4.0, 10.0, 24.0)
                        result.Add(CloneSpan(sp, mm.Groups(1).Value, sp.X0, sp.X0 + mw))
                        result.Add(CloneSpan(sp, mm.Groups(2).Value, sp.X0 + mw, Math.Max(sp.X0 + mw + 10.0, sp.X1)))
                        Continue For
                    End If
                End If

                If strategy = SolverStrategyKind.HLineOperatorSolver OrElse strategy = SolverStrategyKind.KeyValueSubGridFlattener Then
                    Dim pm = PrefixColonRegex.Match(t)
                    If pm.Success Then
                        Dim matchedOpX As Double = If(alignedOpXs.Any(Function(ax) Math.Abs(ax - sp.X0) <= 4.0), alignedOpXs.First(Function(ax) Math.Abs(ax - sp.X0) <= 4.0), sp.X0)
                        result.Add(CloneSpan(sp, pm.Groups(1).Value, matchedOpX, matchedOpX + 9.0))
                        result.Add(CloneSpan(sp, pm.Groups(2).Value.Trim(), matchedOpX + 11.0, Math.Max(matchedOpX + 20.0, sp.X1)))
                        Continue For
                    End If

                    Dim im = InlineColonRegex.Match(t)
                    If im.Success Then
                        Dim ratio As Double = (im.Groups(1).Value.Length + 0.5) / Math.Max(1, t.Length)
                        Dim estOpX As Double = sp.X0 + sp.Width * ratio
                        Dim snapped = alignedOpXs.Where(Function(ax) Math.Abs(ax - estOpX) <= 18.0 AndAlso ax > sp.X0 + 10.0).OrderBy(Function(ax) Math.Abs(ax - estOpX)).ToList()
                        Dim opX As Double = If(snapped.Count > 0, snapped(0), estOpX)
                        result.Add(CloneSpan(sp, im.Groups(1).Value.Trim(), sp.X0, Math.Max(sp.X0 + 8.0, opX - 2.0)))
                        result.Add(CloneSpan(sp, im.Groups(2).Value, opX, opX + 9.0))
                        result.Add(CloneSpan(sp, im.Groups(3).Value.Trim(), opX + 11.0, Math.Max(opX + 20.0, sp.X1)))
                        Continue For
                    End If
                End If
                result.Add(sp)
            Next
            Return result
        End Function

        Private Shared Function PruneEmptyEdgeGhostColumns(
            ByVal bounds As List(Of Double),
            ByVal spans As List(Of TextSpanIr),
            ByVal vLines As List(Of LineSegmentIr),
            ByVal widthPt As Double) As List(Of Double)

            Dim pruned = New List(Of Double)(bounds)
            If pruned.Count >= 3 Then
                Dim b1 As Double = pruned(1)
                Dim anyLeftContent As Boolean = spans.Any(Function(s) s.X0 < b1 - 2.0) OrElse vLines.Any(Function(v) v.X0 < b1 - 2.0)
                If Not anyLeftContent AndAlso b1 <= 18.0 Then
                    pruned.RemoveAt(1)
                End If
            End If
            If pruned.Count >= 3 Then
                Dim bLast As Double = pruned(pruned.Count - 2)
                Dim anyRightContent As Boolean = spans.Any(Function(s) s.X1 > bLast + 2.0) OrElse vLines.Any(Function(v) v.X0 > bLast + 2.0)
                If Not anyRightContent AndAlso widthPt - bLast <= 14.0 Then
                    pruned.RemoveAt(pruned.Count - 2)
                End If
            End If
            Return pruned
        End Function

        Private Shared Function BuildBannerCell(ByVal banner As FillBoxIr, ByVal titleText As String, ByVal colSpan As Integer) As CompiledCell
            Dim isDark As Boolean = banner.Luminance < 0.45
            Return New CompiledCell With {
                .ColSpan = Math.Max(1, colSpan),
                .Name = "BannerCell",
                .Text = titleText,
                .FontFamily = "Arial",
                .FontSizePt = 9.5,
                .IsBold = True,
                .TextColorHex = If(isDark, "#FFFFFF", "#0F172A"),
                .BackgroundHex = banner.FillHex,
                .TextAlign = "Left",
                .VerticalAlign = "Middle",
                .PadTopPt = 2.0,
                .PadBottomPt = 2.0,
                .PadLeftPt = 5.0,
                .PadRightPt = 5.0,
                .LineHeightPt = 12.5
            }
        End Function

        Private Shared Function ClusterSpansIntoRows(ByVal spans As List(Of TextSpanIr)) As List(Of List(Of TextSpanIr))
            Dim sorted = spans.OrderBy(Function(s) Math.Floor(s.Y0 / BaselineQuantPt) * BaselineQuantPt).ThenBy(Function(s) s.X0).ToList()
            Dim rows As New List(Of List(Of TextSpanIr))()
            For Each sp In sorted
                If rows.Count > 0 AndAlso Math.Abs(sp.Y0 - rows(rows.Count - 1)(0).Y0) <= Math.Min(3.5, sp.FontSize * 0.45) Then
                    rows(rows.Count - 1).Add(sp)
                Else
                    rows.Add(New List(Of TextSpanIr) From {sp})
                End If
            Next
            For Each r In rows
                r.Sort(Function(a, b) a.X0.CompareTo(b.X0))
            Next
            Return rows
        End Function

        Private Shared Function DedupSegments(ByVal items As List(Of LineSegmentIr), ByVal horizontal As Boolean) As List(Of LineSegmentIr)
            If items.Count = 0 Then Return items
            Dim sorted = If(horizontal, items.OrderBy(Function(l) l.Y0).ThenBy(Function(l) l.X0).ToList(), items.OrderBy(Function(l) l.X0).ThenBy(Function(l) l.Y0).ToList())
            Dim merged As New List(Of LineSegmentIr) From {sorted(0)}
            For i As Integer = 1 To sorted.Count - 1
                Dim cur = sorted(i)
                Dim prev = merged(merged.Count - 1)
                If horizontal AndAlso Math.Abs(cur.Y0 - prev.Y0) <= DedupTolPt AndAlso cur.X0 <= prev.X1 + 3.0 Then
                    prev.X0 = Math.Min(prev.X0, cur.X0)
                    prev.X1 = Math.Max(prev.X1, cur.X1)
                ElseIf Not horizontal AndAlso Math.Abs(cur.X0 - prev.X0) <= DedupTolPt AndAlso cur.Y0 <= prev.Y1 + 3.0 Then
                    prev.Y0 = Math.Min(prev.Y0, cur.Y0)
                    prev.Y1 = Math.Max(prev.Y1, cur.Y1)
                Else
                    merged.Add(cur)
                End If
            Next
            Return merged
        End Function

        Private Shared Function ClusterValues(ByVal vals As List(Of Double), ByVal tol As Double) As List(Of Double)
            If vals.Count = 0 Then Return New List(Of Double)()
            Dim sorted = vals.OrderBy(Function(v) v).ToList()
            Dim groups As New List(Of List(Of Double)) From {New List(Of Double) From {sorted(0)}}
            For i As Integer = 1 To sorted.Count - 1
                Dim avg As Double = groups(groups.Count - 1).Average()
                If Math.Abs(sorted(i) - avg) <= tol Then
                    groups(groups.Count - 1).Add(sorted(i))
                Else
                    groups.Add(New List(Of Double) From {sorted(i)})
                End If
            Next
            Return groups.Select(Function(g) Math.Round(g.Average(), 2)).ToList()
        End Function

        Private Shared Function DeduplicateGridBounds(ByVal clustered As List(Of Double), ByVal minColW As Double, ByVal widthPt As Double) As List(Of Double)
            Dim bounds As New List(Of Double) From {0.0}
            For Each x In clustered
                If x - bounds(bounds.Count - 1) >= minColW AndAlso widthPt - x >= minColW Then
                    bounds.Add(x)
                End If
            Next
            bounds.Add(widthPt)
            Return bounds
        End Function

        Private Shared Function FindClosestStartCol(ByVal x0 As Double, ByVal colBounds As List(Of Double), ByVal numCols As Integer) As Integer
            Dim bestCol As Integer = 0
            Dim bestDist As Double = Double.MaxValue
            For c As Integer = 0 To numCols - 1
                Dim dist As Double = Math.Abs(x0 - colBounds(c))
                If dist <= 4.5 AndAlso dist < bestDist Then
                    bestDist = dist
                    bestCol = c
                End If
            Next
            If bestDist < Double.MaxValue Then Return bestCol
            For c As Integer = 0 To numCols - 1
                If x0 >= colBounds(c) Then bestCol = c
            Next
            Return Math.Clamp(bestCol, 0, Math.Max(0, numCols - 1))
        End Function

        Private Shared Function JoinCellSpans(ByVal cellSpans As List(Of TextSpanIr)) As String
            If cellSpans.Count = 0 Then Return String.Empty
            Dim sb As New System.Text.StringBuilder()
            For i As Integer = 0 To cellSpans.Count - 1
                If i > 0 Then
                    Dim sameLine As Boolean = Math.Abs(cellSpans(i).Y0 - cellSpans(i - 1).Y0) <= 3.0
                    sb.Append(If(sameLine, " ", Environment.NewLine))
                End If
                sb.Append(cellSpans(i).Text.Trim())
            Next
            Return sb.ToString()
        End Function

        Private Shared Function InferCellAlign(ByVal cellSpans As List(Of TextSpanIr), ByVal x0 As Double, ByVal x1 As Double, ByVal isHeader As Boolean) As String
            If cellSpans.Count = 0 Then Return "Left"
            Dim colMid As Double = (x0 + x1) / 2.0
            Dim textMid As Double = (cellSpans.Min(Function(s) s.X0) + cellSpans.Max(Function(s) s.X1)) / 2.0
            If Math.Abs(textMid - colMid) <= 4.0 Then Return "Center"
            Dim txt As String = String.Join(" ", cellSpans.Select(Function(s) s.Text.Trim()))
            If Not isHeader AndAlso Regex.IsMatch(txt, "^(?:\(?\s*-?\d[\d.,]*\s*%?\s*\)?|Rp\s*[\d.,-]+|-)$", RegexOptions.IgnoreCase) Then
                Return "Right"
            End If
            Return "Left"
        End Function

        Private Shared Function EstimateRowHeightPt(ByVal cells As List(Of CompiledCell), ByVal colWidthsPt As List(Of Double)) As Double
            Dim maxH As Double = 13.0
            Dim col As Integer = 0
            For Each cell In cells
                Dim spanW As Double = 0.0
                For k As Integer = 0 To cell.ColSpan - 1
                    If col + k < colWidthsPt.Count Then spanW += colWidthsPt(col + k)
                Next
                col += cell.ColSpan
                Dim innerW As Double = Math.Max(12.0, spanW - cell.PadLeftPt - cell.PadRightPt)
                Dim charW As Double = Math.Max(3.2, cell.FontSizePt * 0.5)
                Dim lines As Integer = 0
                For Each seg In If(cell.Text, String.Empty).Split(New String() {vbCrLf, vbLf}, StringSplitOptions.None)
                    If String.IsNullOrWhiteSpace(seg) Then
                        lines += 1
                    Else
                        lines += Math.Max(1, CInt(Math.Ceiling((seg.Length * charW) / innerW)))
                    End If
                Next
                Dim h As Double = lines * Math.Max(cell.LineHeightPt, cell.FontSizePt * 1.25) + cell.PadTopPt + cell.PadBottomPt
                If h > maxH Then maxH = h
            Next
            Return Math.Round(maxH, 2)
        End Function

        Private Shared Function CloneSpan(ByVal src As TextSpanIr, ByVal text As String, ByVal x0 As Double, ByVal x1 As Double) As TextSpanIr
            Return New TextSpanIr With {
                .Text = text, .X0 = x0, .Y0 = src.Y0, .X1 = x1, .Y1 = src.Y1,
                .FontSize = src.FontSize, .FontName = src.FontName,
                .IsBold = src.IsBold, .IsItalic = src.IsItalic, .ColorHex = src.ColorHex
            }
        End Function

        Private Shared Function ShiftSpanOrigin(ByVal s As TextSpanIr, ByVal dx As Double, ByVal dy As Double) As TextSpanIr
            Return New TextSpanIr With {
                .Text = s.Text, .X0 = Math.Max(0.0, s.X0 + dx), .Y0 = Math.Max(0.0, s.Y0 + dy),
                .X1 = Math.Max(1.0, s.X1 + dx), .Y1 = Math.Max(1.0, s.Y1 + dy),
                .FontSize = s.FontSize, .FontName = s.FontName, .IsBold = s.IsBold, .IsItalic = s.IsItalic, .ColorHex = s.ColorHex
            }
        End Function

        Private Shared Function ShiftLineOrigin(ByVal l As LineSegmentIr, ByVal dx As Double, ByVal dy As Double) As LineSegmentIr
            Return New LineSegmentIr With {
                .X0 = Math.Max(0.0, l.X0 + dx), .Y0 = Math.Max(0.0, l.Y0 + dy),
                .X1 = Math.Max(0.0, l.X1 + dx), .Y1 = Math.Max(0.0, l.Y1 + dy)
            }
        End Function

        Private Shared Function ShiftFillOrigin(ByVal f As FillBoxIr, ByVal dx As Double, ByVal dy As Double) As FillBoxIr
            Return New FillBoxIr With {
                .X0 = Math.Max(0.0, f.X0 + dx), .Y0 = Math.Max(0.0, f.Y0 + dy),
                .X1 = Math.Max(0.0, f.X1 + dx), .Y1 = Math.Max(0.0, f.Y1 + dy),
                .FillHex = f.FillHex, .Luminance = f.Luminance, .BorderHex = f.BorderHex
            }
        End Function

        Private Function NextName(ByVal prefix As String) As String
            Dim n = _nameSeq
            _nameSeq += 1
            Return $"{prefix}_{n}"
        End Function
    End Class

End Namespace
