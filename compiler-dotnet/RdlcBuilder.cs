using System.Globalization;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using ReportGen.Compiler.Models;

namespace ReportGen.Compiler;

/// <summary>
/// Deterministic PDF-to-RDLC 2008 Compiler (Rules v3.3 — Page 1 &amp; Multi-Stream Patch).
/// Strictly zero hardcoding: all structure, splits, spans, and borders derive
/// purely from geometric primitives, fill luminance, typography, and generic markers.
/// </summary>
public sealed class RdlcBuilder
{
    public static readonly XNamespace Rdl2008Ns =
        "http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition";

    public static readonly XNamespace RdNs =
        "http://schemas.microsoft.com/SQLServer/reporting/reportdesigner";

    private const double MarginPt = 21.26; // ~0.75cm
    private const double MinGutterPt = 6.0;
    private const double BaselineQuantPt = 1.5;
    private const double DedupTolPt = 2.0;
    private const double BorderMatchTolPt = 2.5;
    private const double BorderCoverageMin = 0.70;
    private const double ColonClusterTolPt = 2.5;
    private const double StaircaseClusterTolPt = 3.0;
    private const double BoldMergeXTolPt = 4.5;
    private const double LeadingRatioMax = 1.65;

    private static readonly Regex MarkerRegex = new(
        @"^(?:\d+(?:\.\d+)*\.|[a-z]\.|(?:i{1,3}|iv|vi{0,3}|ix|x)\.|(?:\(\d+\)|\([a-z]{1,2}\))|[•\u2022\-–*])$",
        RegexOptions.Compiled);

    private static readonly Regex InlineMarkerRegex = new(
        @"^(\d+(?:\.\d+)*\.|[a-z]\.|(?:i{1,3}|iv|vi{0,3}|ix|x)\.|(?:\(\d+\)|\([a-z]{1,2}\))|[•\u2022\-–*])\s+(.+)$",
        RegexOptions.Compiled);

    private static readonly Regex InlineColonRegex = new(
        @"^(.{2,42}?)\s*([:=])\s+(.+)$",
        RegexOptions.Compiled);

    private static readonly Regex PrefixColonRegex = new(
        @"^([:=])\s+(.+)$",
        RegexOptions.Compiled);

    private int _nameCounter = 1;

    public RdlcBuildResult Build(LayoutIrDocument ir)
    {
        _nameCounter = 1;
        var pages = ir.Pages.OrderBy(p => p.PageIndex).ToList();
        if (pages.Count == 0)
        {
            throw new InvalidOperationException("Layout IR contains zero pages.");
        }

        double pageWidthPt = pages[0].WidthPt > 72 ? pages[0].WidthPt : 595.32;
        double pageHeightPt = pages[0].HeightPt > 72 ? pages[0].HeightPt : 841.92;
        double printableWidthPt = Math.Max(144.0, pageWidthPt - 2.0 * MarginPt);

        var (headerHeightPt, footerHeightPt) = EstimateChromeHeightsPt(pages);
        double printableHeightPt = Math.Max(144.0, pageHeightPt - 2.0 * MarginPt - headerHeightPt - footerHeightPt);

        var allTablixes = new List<CompiledTablix>();
        var compiledHeights = new Dictionary<int, double>();
        double globalTopCursorPt = 0.0;

        foreach (var page in pages)
        {
            var pageTablixes = CompilePage(page, printableWidthPt, MarginPt, globalTopCursorPt);
            CompactPageToPrintableHeight(pageTablixes, printableHeightPt);

            // [R-PB]: Emit <PageBreak><BreakLocation>Start</BreakLocation></PageBreak> ONLY
            // on the single top-most outer <Tablix> (min(Top)) when sourcePageIndex > 0.
            foreach (var t in pageTablixes)
            {
                t.PageBreakBefore = false;
            }
            if (page.PageIndex > 0 && pageTablixes.Count > 0)
            {
                var anchor = pageTablixes
                    .Where(t => !t.IsNested && !t.IsRightTrack)
                    .OrderBy(t => t.TopPt)
                    .FirstOrDefault() ?? pageTablixes.Where(t => !t.IsNested).OrderBy(t => t.TopPt).FirstOrDefault();
                if (anchor is not null)
                {
                    anchor.PageBreakBefore = true;
                }
            }

            double pageMinTop = pageTablixes.Count > 0 ? pageTablixes.Min(t => t.TopPt) : globalTopCursorPt;
            double pageMaxBottom = pageTablixes.Count > 0 ? pageTablixes.Max(t => t.TopPt + t.HeightPt) : globalTopCursorPt;
            compiledHeights[page.PageIndex] = Math.Max(0.0, pageMaxBottom - pageMinTop);
            globalTopCursorPt = pageMaxBottom + 6.0;

            allTablixes.AddRange(pageTablixes);
        }

        var xdoc = SerializeRdlc2008(pages, allTablixes, pageWidthPt, pageHeightPt, headerHeightPt, footerHeightPt);
        var xml = xdoc.Declaration is not null
            ? $"{xdoc.Declaration}{Environment.NewLine}{xdoc}"
            : xdoc.ToString();

        var validationErrors = ValidateRdlc2008(xdoc);
        bool paritySatisfied = compiledHeights.Values.All(h => h <= printableHeightPt + 0.5) && validationErrors.Count == 0;

        return new RdlcBuildResult
        {
            RdlcXml = xml,
            Tablixes = allTablixes,
            ValidationErrors = validationErrors,
            SourcePageCount = pages.Count,
            PageParitySatisfied = paritySatisfied,
            PageCompiledHeightsPt = compiledHeights
        };
    }

    private static (double headerHeightPt, double footerHeightPt) EstimateChromeHeightsPt(List<LayoutIrPage> pages)
    {
        double hdrH = 0.0;
        var p0 = pages[0];
        if (p0.HeaderSpans.Count > 0 || !string.IsNullOrWhiteSpace(p0.HeaderLogoBase64))
        {
            double maxLogoY = p0.HeaderLogoRect?.Y1 ?? 48.0;
            double maxSpanY = p0.HeaderSpans.Count > 0 ? p0.HeaderSpans.Max(s => s.Y1) : 0.0;
            hdrH = Math.Clamp(Math.Max(maxLogoY, maxSpanY) - MarginPt + 6.0, 24.0, 86.0);
        }

        double ftrH = 0.0;
        var ftrSpans = pages.SelectMany(p => p.FooterSpans).ToList();
        if (ftrSpans.Count > 0)
        {
            double minY = ftrSpans.Min(s => s.Y0);
            double maxY = ftrSpans.Max(s => s.Y1);
            ftrH = Math.Clamp((maxY - minY) + 12.0, 18.0, 56.0);
        }

        return (hdrH, ftrH);
    }

    private List<CompiledTablix> CompilePage(
        LayoutIrPage page,
        double printableWidthPt,
        double leftOriginPt,
        double initialTopPt)
    {
        // Enforce Visual (Y, X) coordinate re-sorting (Zero OCR on digital PDFs)
        var spans = page.BodySpans
            .Where(s => !string.IsNullOrWhiteSpace(s.Text))
            .Select(s => new TextSpan
            {
                Text = s.Text,
                X0 = Math.Clamp(s.X0 - leftOriginPt, 0.0, printableWidthPt),
                Y0 = s.Y0,
                X1 = Math.Clamp(s.X1 - leftOriginPt, 0.0, printableWidthPt),
                Y1 = s.Y1,
                FontSize = s.FontSize > 0 ? s.FontSize : 8.5,
                FontName = string.IsNullOrWhiteSpace(s.FontName) ? "Arial" : s.FontName,
                IsBold = s.IsBold,
                IsItalic = s.IsItalic,
                ColorHex = string.IsNullOrWhiteSpace(s.ColorHex) ? "#0F172A" : s.ColorHex
            })
            .OrderBy(s => Math.Floor(s.Y0 / BaselineQuantPt) * BaselineQuantPt)
            .ThenBy(s => s.X0)
            .ToList();

        var hLines = DedupLines(
            page.HLines.Select(h => new LineSegment
            {
                X0 = Math.Clamp(h.X0 - leftOriginPt, 0.0, printableWidthPt),
                Y0 = h.Y0,
                X1 = Math.Clamp(h.X1 - leftOriginPt, 0.0, printableWidthPt),
                Y1 = h.Y1
            }).ToList(),
            horizontal: true);

        var vLines = DedupLines(
            page.VLines.Select(v => new LineSegment
            {
                X0 = Math.Clamp(v.X0 - leftOriginPt, 0.0, printableWidthPt),
                Y0 = v.Y0,
                X1 = Math.Clamp(v.X1 - leftOriginPt, 0.0, printableWidthPt),
                Y1 = v.Y1
            }).ToList(),
            horizontal: false);

        var banners = page.FillBanners
            .Where(b => b.Luminance < 0.72 && b.Width >= printableWidthPt * 0.25)
            .Select(b => new FillBox
            {
                X0 = Math.Clamp(b.X0 - leftOriginPt, 0.0, printableWidthPt),
                Y0 = b.Y0,
                X1 = Math.Clamp(b.X1 - leftOriginPt, 0.0, printableWidthPt),
                Y1 = b.Y1,
                FillHex = b.FillHex,
                Luminance = b.Luminance
            })
            .OrderBy(b => b.Y0)
            .ThenBy(b => b.X0)
            .ToList();

        var rowFills = page.RowFills
            .Select(r => new FillBox
            {
                X0 = Math.Clamp(r.X0 - leftOriginPt, 0.0, printableWidthPt),
                Y0 = r.Y0,
                X1 = Math.Clamp(r.X1 - leftOriginPt, 0.0, printableWidthPt),
                Y1 = r.Y1,
                FillHex = r.FillHex,
                Luminance = r.Luminance
            })
            .OrderBy(r => r.Y0)
            .ThenBy(r => r.X0)
            .ToList();

        var result = new List<CompiledTablix>();
        double cursorTopPt = initialTopPt;

        // Partition spans at hard FillBanner vertical fences
        var bannerBands = PartitionByBanners(spans, hLines, vLines, rowFills, banners, printableWidthPt);

        foreach (var band in bannerBands)
        {
            // [R-PARENT-NESTED]: Single full-width dark FillBanner over dual side-by-side groups / twin sub-grids
            if (band.TopBanner is not null &&
                band.TopBanner.Luminance < 0.72 &&
                band.TopBanner.Width >= printableWidthPt * 0.85 &&
                TryDetectVerticalGutter(band.Spans, band.VLines, band.HLines, printableWidthPt, out double parentGutterX))
            {
                var nestedOuter = BuildParentNestedTablix(
                    page.PageIndex,
                    band.TopBanner,
                    band.BannerText,
                    band.Spans,
                    band.HLines,
                    band.VLines,
                    band.RowFills,
                    printableWidthPt,
                    parentGutterX,
                    cursorTopPt);
                result.Add(nestedOuter);
                cursorTopPt = nestedOuter.TopPt + nestedOuter.HeightPt + 4.0;
                continue;
            }

            // [R-DUAL-TRACK]: Side-by-side paired headers or twin sub-grids separated by >= 6pt gutter
            if (band.PairedBanners is not null)
            {
                var (leftBanner, leftTitle, rightBanner, rightTitle) = band.PairedBanners.Value;
                double gutterX = (leftBanner.X1 + rightBanner.X0) / 2.0;
                var (leftTbl, rightTbl) = BuildDualTrackPair(
                    page.PageIndex,
                    leftBanner,
                    leftTitle,
                    rightBanner,
                    rightTitle,
                    band.Spans,
                    band.HLines,
                    band.VLines,
                    band.RowFills,
                    printableWidthPt,
                    gutterX,
                    cursorTopPt);
                result.Add(leftTbl);
                result.Add(rightTbl);
                cursorTopPt = Math.Max(leftTbl.TopPt + leftTbl.HeightPt, rightTbl.TopPt + rightTbl.HeightPt) + 4.0;
                continue;
            }

            if (band.TopBanner is null &&
                TryDetectVerticalGutter(band.Spans, band.VLines, band.HLines, printableWidthPt, out double dualGutterX))
            {
                var (leftTbl, rightTbl) = BuildDualTrackPair(
                    page.PageIndex,
                    null,
                    string.Empty,
                    null,
                    string.Empty,
                    band.Spans,
                    band.HLines,
                    band.VLines,
                    band.RowFills,
                    printableWidthPt,
                    dualGutterX,
                    cursorTopPt);
                result.Add(leftTbl);
                result.Add(rightTbl);
                cursorTopPt = Math.Max(leftTbl.TopPt + leftTbl.HeightPt, rightTbl.TopPt + rightTbl.HeightPt) + 4.0;
                continue;
            }

            // [R-DENSITY-SPLIT]: Split dense grid (>= 4 cols) from trailing wide footnote (<= 2 cols, >= 75% width)
            var splitSegments = SplitOnDensityTransition(
                band.TopBanner,
                band.BannerText,
                band.Spans,
                band.HLines,
                band.VLines,
                band.RowFills,
                printableWidthPt);

            foreach (var seg in splitSegments)
            {
                var tbl = CompileContainerTablix(
                    page.PageIndex,
                    seg.Banner,
                    seg.BannerText,
                    seg.Spans,
                    seg.HLines,
                    seg.VLines,
                    seg.RowFills,
                    0.0,
                    printableWidthPt,
                    cursorTopPt,
                    isNested: false,
                    isRightTrack: false,
                    forceFootnote: seg.IsFootnote);
                if (tbl.Rows.Count > 0)
                {
                    result.Add(tbl);
                    cursorTopPt = tbl.TopPt + tbl.HeightPt + 4.0;
                }
            }
        }

        return result;
    }

    private sealed record BannerBand(
        FillBox? TopBanner,
        string BannerText,
        (FillBox Left, string LeftTitle, FillBox Right, string RightTitle)? PairedBanners,
        List<TextSpan> Spans,
        List<LineSegment> HLines,
        List<LineSegment> VLines,
        List<FillBox> RowFills);

    private List<BannerBand> PartitionByBanners(
        List<TextSpan> allSpans,
        List<LineSegment> allHLines,
        List<LineSegment> allVLines,
        List<FillBox> allRowFills,
        List<FillBox> banners,
        double printableWidthPt)
    {
        var bands = new List<BannerBand>();
        var consumedSpanIds = new HashSet<TextSpan>();

        string ExtractBannerTitle(FillBox b)
        {
            var enclosed = allSpans
                .Where(s => s.CenterY >= b.Y0 - 2.0 && s.CenterY <= b.Y1 + 2.0 &&
                            s.CenterX >= b.X0 - 3.0 && s.CenterX <= b.X1 + 3.0)
                .OrderBy(s => s.X0)
                .ToList();
            foreach (var s in enclosed) consumedSpanIds.Add(s);
            return string.Join(" ", enclosed.Select(s => s.Text.Trim()).Where(t => t.Length > 0));
        }

        // Pair side-by-side banners (|dy| <= 4pt)
        var events = new List<(double Y0, double Y1, FillBox? Full, string FullText, (FillBox Left, string LeftTitle, FillBox Right, string RightTitle)? Pair)>();
        var usedBanner = new bool[banners.Count];
        for (int i = 0; i < banners.Count; i++)
        {
            if (usedBanner[i]) continue;
            var b = banners[i];
            if (b.Width >= printableWidthPt * 0.70)
            {
                usedBanner[i] = true;
                events.Add((b.Y0, b.Y1, b, ExtractBannerTitle(b), null));
            }
            else
            {
                int partnerIdx = -1;
                for (int j = i + 1; j < banners.Count; j++)
                {
                    if (usedBanner[j]) continue;
                    var ob = banners[j];
                    if (ob.Width < printableWidthPt * 0.65 &&
                        Math.Abs(ob.Y0 - b.Y0) <= 4.0 &&
                        (ob.X0 >= b.X1 - 2.0 || b.X0 >= ob.X1 - 2.0))
                    {
                        partnerIdx = j;
                        break;
                    }
                }
                if (partnerIdx >= 0)
                {
                    usedBanner[i] = true;
                    usedBanner[partnerIdx] = true;
                    var p = banners[partnerIdx];
                    var (left, right) = b.X0 <= p.X0 ? (b, p) : (p, b);
                    events.Add((Math.Min(left.Y0, right.Y0), Math.Max(left.Y1, right.Y1),
                        null, string.Empty, (left, ExtractBannerTitle(left), right, ExtractBannerTitle(right))));
                }
                else
                {
                    usedBanner[i] = true;
                    events.Add((b.Y0, b.Y1, b, ExtractBannerTitle(b), null));
                }
            }
        }

        events = events.OrderBy(e => e.Y0).ToList();
        var bodySpans = allSpans.Where(s => !consumedSpanIds.Contains(s)).ToList();

        double prevY = double.NegativeInfinity;
        FillBox? activeFull = null;
        string activeTitle = string.Empty;
        (FillBox Left, string LeftTitle, FillBox Right, string RightTitle)? activePair = null;

        void EmitSlice(double cutY)
        {
            var sliceSpans = bodySpans.Where(s => s.CenterY >= prevY && s.CenterY < cutY).ToList();
            if (sliceSpans.Count == 0 && activeFull is null && activePair is null) return;
            var sliceH = allHLines.Where(h => h.Y0 >= prevY - 1.0 && h.Y0 < cutY + 1.0).ToList();
            var sliceV = allVLines.Where(v => v.Y1 >= prevY - 1.0 && v.Y0 < cutY + 1.0).ToList();
            var sliceR = allRowFills.Where(r => r.Y0 >= prevY - 1.0 && r.Y0 < cutY + 1.0).ToList();
            bands.Add(new BannerBand(activeFull, activeTitle, activePair, sliceSpans, sliceH, sliceV, sliceR));
        }

        foreach (var ev in events)
        {
            EmitSlice(ev.Y0 - 0.5);
            prevY = ev.Y1 + 0.5;
            activeFull = ev.Full;
            activeTitle = ev.FullText;
            activePair = ev.Pair;
        }
        EmitSlice(double.PositiveInfinity);

        return bands;
    }

    private bool TryDetectVerticalGutter(
        List<TextSpan> spans,
        List<LineSegment> vLines,
        List<LineSegment> hLines,
        double widthPt,
        out double gutterXPt)
    {
        gutterXPt = widthPt / 2.0;
        if (spans.Count < 4) return false;

        // Wide spanning elements prevent a clean vertical gutter
        if (spans.Any(s => s.Width >= widthPt * 0.68) || hLines.Any(h => h.Width >= widthPt * 0.68))
        {
            return false;
        }

        var intervals = spans.Select(s => (X0: s.X0, X1: s.X1)).OrderBy(iv => iv.X0).ToList();
        var merged = new List<(double X0, double X1)> { intervals[0] };
        for (int i = 1; i < intervals.Count; i++)
        {
            var cur = intervals[i];
            var last = merged[^1];
            if (cur.X0 <= last.X1 + 3.0)
            {
                merged[^1] = (last.X0, Math.Max(last.X1, cur.X1));
            }
            else
            {
                merged.Add(cur);
            }
        }

        double bestScore = double.NegativeInfinity;
        double bestCenter = 0.0;
        for (int i = 0; i < merged.Count - 1; i++)
        {
            double gap = merged[i + 1].X0 - merged[i].X1;
            double center = (merged[i].X1 + merged[i + 1].X0) / 2.0;
            if (gap < MinGutterPt || center < widthPt * 0.25 || center > widthPt * 0.75) continue;

            bool anyCrossing = spans.Any(s => s.X0 < center - 1.5 && s.X1 > center + 1.5);
            if (anyCrossing) continue;

            var leftSpans = spans.Where(s => s.CenterX < center).ToList();
            var rightSpans = spans.Where(s => s.CenterX >= center).ToList();
            if (leftSpans.Count < 2 || rightSpans.Count < 2) continue;

            // Require genuinely overlapping vertical bands so vertically stacked blocks aren't split horizontally
            double overlapY = Math.Min(leftSpans.Max(s => s.Y1), rightSpans.Max(s => s.Y1)) -
                              Math.Max(leftSpans.Min(s => s.Y0), rightSpans.Min(s => s.Y0));
            if (overlapY <= -10.0) continue;

            int leftV = vLines.Count(v => v.X0 < center);
            int rightV = vLines.Count(v => v.X0 > center);
            var leftOps = FindAlignedOperatorXs(leftSpans);
            var rightOps = FindAlignedOperatorXs(rightSpans);

            bool leftHasLabel = leftOps.Count == 0 || leftSpans.Any(s => s.X1 <= leftOps[0] - 2.0 && !PrefixColonRegex.IsMatch(s.Text.Trim()));
            bool rightHasLabel = rightOps.Count == 0 || rightSpans.Any(s => s.X1 <= rightOps[0] - 2.0 && !PrefixColonRegex.IsMatch(s.Text.Trim()));

            // Reject intra-KV splits where rightSide begins directly at ':'/'=' with no labels left of ':'
            if (rightOps.Count >= 1 && !rightHasLabel && !(leftV >= 2 && rightV >= 2))
            {
                continue;
            }

            bool hasPairedGridOrKv =
                (leftV >= 2 && rightV >= 2) ||
                (leftOps.Count >= 1 && rightOps.Count >= 1 && leftHasLabel && rightHasLabel) ||
                (leftSpans.Count >= 3 && rightSpans.Count >= 3);
            if (!hasPairedGridOrKv) continue;

            double bothKvBonus = (leftOps.Count >= 1 && rightOps.Count >= 1 && leftHasLabel && rightHasLabel) ? 60.0 : 0.0;
            double bothGridBonus = (leftV >= 2 && rightV >= 2) ? 50.0 : 0.0;
            double centralityPenalty = Math.Abs(center - widthPt / 2.0) * 1.4;
            double score = gap + bothKvBonus + bothGridBonus + Math.Min(leftSpans.Count, rightSpans.Count) * 3.0 - centralityPenalty;

            if (score > bestScore)
            {
                bestScore = score;
                bestCenter = center;
            }
        }

        if (bestScore > double.NegativeInfinity && bestCenter > 0.0)
        {
            gutterXPt = Math.Round(bestCenter, 2);
            return true;
        }
        return false;
    }

    private CompiledTablix BuildParentNestedTablix(
        int pageIndex,
        FillBox banner,
        string bannerTitle,
        List<TextSpan> spans,
        List<LineSegment> hLines,
        List<LineSegment> vLines,
        List<FillBox> rowFills,
        double printableWidthPt,
        double gutterXPt,
        double topPt)
    {
        double halfGap = MinGutterPt / 2.0;
        double leftW = Math.Round(Math.Clamp(gutterXPt - halfGap, 72.0, printableWidthPt - 72.0 - MinGutterPt), 2);
        double rightW = Math.Round(Math.Max(72.0, printableWidthPt - leftW), 2);

        var leftSpans = spans.Where(s => s.CenterX < gutterXPt).ToList();
        var rightSpans = spans.Where(s => s.CenterX >= gutterXPt)
            .Select(s => ShiftSpanX(s, -(gutterXPt + halfGap)))
            .ToList();

        var leftHLines = hLines.Where(h => h.X1 <= gutterXPt + 2.0).ToList();
        var rightHLines = hLines.Where(h => h.X0 >= gutterXPt - 2.0)
            .Select(h => ShiftLineX(h, -(gutterXPt + halfGap))).ToList();

        var leftVLines = vLines.Where(v => v.X0 < gutterXPt).ToList();
        var rightVLines = vLines.Where(v => v.X0 >= gutterXPt)
            .Select(v => ShiftLineX(v, -(gutterXPt + halfGap))).ToList();

        var leftFills = rowFills.Where(r => r.X1 <= gutterXPt + 2.0).ToList();
        var rightFills = rowFills.Where(r => r.X0 >= gutterXPt - 2.0)
            .Select(r => ShiftFillX(r, -(gutterXPt + halfGap))).ToList();

        var leftChild = CompileContainerTablix(
            pageIndex, null, string.Empty, leftSpans, leftHLines, leftVLines, leftFills,
            0.0, leftW, 0.0, isNested: true, isRightTrack: false, forceFootnote: false);
        var rightChild = CompileContainerTablix(
            pageIndex, null, string.Empty, rightSpans, rightHLines, rightVLines, rightFills,
            0.0, Math.Max(72.0, printableWidthPt - (gutterXPt + halfGap)), 0.0,
            isNested: true, isRightTrack: true, forceFootnote: false);

        double bannerH = Math.Max(16.0, Math.Round(banner.Height, 2));
        double bodyRowH = Math.Max(18.0, Math.Max(leftChild.HeightPt, rightChild.HeightPt));

        var r0 = new CompiledRow
        {
            HeightPt = bannerH,
            IsHeaderRow = true,
            Cells = new List<CompiledCell>
            {
                BuildBannerCell(banner, bannerTitle, colSpan: 2)
            }
        };

        var r1 = new CompiledRow
        {
            HeightPt = bodyRowH,
            Cells = new List<CompiledCell>
            {
                new CompiledCell
                {
                    ColSpan = 1,
                    Name = NextName("NestedLeft"),
                    NestedTablix = leftChild
                },
                new CompiledCell
                {
                    ColSpan = 1,
                    Name = NextName("NestedRight"),
                    NestedTablix = rightChild
                }
            }
        };

        return new CompiledTablix
        {
            Name = NextName($"Tablix_P{pageIndex + 1}_ParentNested"),
            SourcePageIndex = pageIndex,
            Strategy = SolverStrategyKind.ParentNestedBannerGrid,
            BorderMode = BorderRuleKind.None,
            TopPt = topPt,
            LeftPt = 0.0,
            WidthPt = printableWidthPt,
            HeightPt = bannerH + bodyRowH,
            ColumnWidthsPt = new List<double> { leftW, rightW },
            Rows = new List<CompiledRow> { r0, r1 }
        };
    }

    private (CompiledTablix Left, CompiledTablix Right) BuildDualTrackPair(
        int pageIndex,
        FillBox? leftBanner,
        string leftTitle,
        FillBox? rightBanner,
        string rightTitle,
        List<TextSpan> spans,
        List<LineSegment> hLines,
        List<LineSegment> vLines,
        List<FillBox> rowFills,
        double printableWidthPt,
        double gutterXPt,
        double topPt)
    {
        double halfGap = MinGutterPt / 2.0;
        double leftW = Math.Round(Math.Clamp(gutterXPt - halfGap, 72.0, printableWidthPt - 72.0 - MinGutterPt), 2);
        double rightLeft = Math.Round(leftW + MinGutterPt, 2);
        double rightW = Math.Round(Math.Max(72.0, printableWidthPt - rightLeft), 2);

        var leftSpans = spans.Where(s => s.CenterX < gutterXPt).ToList();
        var rightSpans = spans.Where(s => s.CenterX >= gutterXPt).Select(s => ShiftSpanX(s, -rightLeft)).ToList();

        var leftH = hLines.Where(h => h.X1 <= gutterXPt + 2.0).ToList();
        var rightH = hLines.Where(h => h.X0 >= gutterXPt - 2.0).Select(h => ShiftLineX(h, -rightLeft)).ToList();

        var leftV = vLines.Where(v => v.X0 < gutterXPt).ToList();
        var rightV = vLines.Where(v => v.X0 >= gutterXPt).Select(v => ShiftLineX(v, -rightLeft)).ToList();

        var leftF = rowFills.Where(r => r.X1 <= gutterXPt + 2.0).ToList();
        var rightF = rowFills.Where(r => r.X0 >= gutterXPt - 2.0).Select(r => ShiftFillX(r, -rightLeft)).ToList();

        var leftTbl = CompileContainerTablix(
            pageIndex, leftBanner, leftTitle, leftSpans, leftH, leftV, leftF,
            0.0, leftW, topPt, isNested: false, isRightTrack: false, forceFootnote: false);
        var rightTbl = CompileContainerTablix(
            pageIndex, rightBanner, rightTitle, rightSpans, rightH, rightV, rightF,
            rightLeft, rightW, topPt, isNested: false, isRightTrack: true, forceFootnote: false);

        return (leftTbl, rightTbl);
    }

    private sealed record DensitySegment(
        FillBox? Banner,
        string BannerText,
        List<TextSpan> Spans,
        List<LineSegment> HLines,
        List<LineSegment> VLines,
        List<FillBox> RowFills,
        bool IsFootnote);

    private List<DensitySegment> SplitOnDensityTransition(
        FillBox? banner,
        string bannerText,
        List<TextSpan> spans,
        List<LineSegment> hLines,
        List<LineSegment> vLines,
        List<FillBox> rowFills,
        double widthPt)
    {
        var yRows = ClusterSpansIntoRows(spans);
        int denseRowCount = yRows.Count(r => r.Count >= 4);
        if (denseRowCount >= 3)
        {
            for (int r = 3; r < yRows.Count; r++)
            {
                var tail = yRows.Skip(r).ToList();
                bool allWide = tail.All(tr =>
                {
                    if (tr.Count == 0 || tr.Count > 2) return false;
                    double minX = tr.Min(s => s.X0);
                    double maxX = tr.Max(s => s.X1);
                    return (maxX - minX) >= widthPt * 0.75 || (tr.Count == 1 && tr[0].IsBold);
                });
                if (!allWide) continue;

                double cutY = tail[0].Min(s => s.Y0) - 2.0;
                bool hasDividerAbove = hLines.Any(h => h.Width >= widthPt * 0.75 && h.Y0 >= yRows[r - 1].Max(s => s.Y1) - 2.0 && h.Y0 <= cutY + 4.0);
                if (!hasDividerAbove && vLines.Count < 3) continue;

                var topSpans = spans.Where(s => s.CenterY < cutY).ToList();
                var botSpans = spans.Where(s => s.CenterY >= cutY).ToList();
                return new List<DensitySegment>
                {
                    new(banner, bannerText, topSpans,
                        hLines.Where(h => h.Y0 <= cutY + 1.0).ToList(),
                        vLines.Where(v => v.Y0 < cutY + 1.0).ToList(),
                        rowFills.Where(rf => rf.Y0 < cutY + 1.0).ToList(),
                        false),
                    new(null, string.Empty, botSpans,
                        hLines.Where(h => h.Y0 > cutY + 1.0).ToList(),
                        new List<LineSegment>(),
                        rowFills.Where(rf => rf.Y0 >= cutY).ToList(),
                        true)
                };
            }
        }

        return new List<DensitySegment>
        {
            new(banner, bannerText, spans, hLines, vLines, rowFills, false)
        };
    }

    private CompiledTablix CompileContainerTablix(
        int pageIndex,
        FillBox? banner,
        string bannerText,
        List<TextSpan> spans,
        List<LineSegment> hLines,
        List<LineSegment> vLines,
        List<FillBox> rowFills,
        double leftPt,
        double widthPt,
        double topPt,
        bool isNested,
        bool isRightTrack,
        bool forceFootnote)
    {
        var strategy = SelectStrategy(spans, hLines, vLines, rowFills, widthPt, forceFootnote);
        BorderRuleKind borderMode = ResolveBorderRule(strategy, hLines, vLines, widthPt);

        var (colWidthsPt, rows) = strategy == SolverStrategyKind.PlanarGridSolver
            ? BuildPlanarGridRows(spans, hLines, vLines, rowFills, widthPt)
            : BuildFlowOrStructuredRows(strategy, spans, hLines, vLines, rowFills, widthPt);

        if (banner is not null)
        {
            var bannerRow = new CompiledRow
            {
                HeightPt = Math.Max(16.0, Math.Round(banner.Height, 2)),
                IsHeaderRow = true,
                SourceY0Pt = banner.Y0,
                SourceY1Pt = banner.Y1,
                Cells = new List<CompiledCell> { BuildBannerCell(banner, bannerText, colWidthsPt.Count) }
            };
            rows.Insert(0, bannerRow);
        }

        // [R-ROW-BOLD-MERGE]: While convergence loop merging over-split consecutive Regular rows
        if (strategy != SolverStrategyKind.PlanarGridSolver)
        {
            ConvergeRegularProseMerge(rows, colWidthsPt, hLines, rowFills, banner is not null);
        }

        // Apply v3.2 border rules ([R-B-NONE], [R-B-GRID], [R-B-BOX], [R-B-HLINE])
        ApplyBorderRule(rows, colWidthsPt, borderMode, hLines, vLines, widthPt, banner is not null);

        // Enforce sum(ColSpan) == N_columns invariant on every row
        EnsureRowColSpanInvariants(rows, colWidthsPt.Count);

        double totalHeightPt = Math.Max(14.0, rows.Sum(r => r.HeightPt));

        return new CompiledTablix
        {
            Name = NextName(isNested
                ? (isRightTrack ? $"NestedRight_P{pageIndex + 1}" : $"NestedLeft_P{pageIndex + 1}")
                : (isRightTrack ? $"Tablix_Right_P{pageIndex + 1}" : $"Tablix_P{pageIndex + 1}")),
            SourcePageIndex = pageIndex,
            Strategy = strategy,
            BorderMode = borderMode,
            IsNested = isNested,
            IsRightTrack = isRightTrack,
            TopPt = topPt,
            LeftPt = leftPt,
            WidthPt = widthPt,
            HeightPt = totalHeightPt,
            ColumnWidthsPt = colWidthsPt,
            Rows = rows
        };
    }

    private static bool HasEmbeddedSubGridZone(
        List<TextSpan> spans,
        List<LineSegment> vLines,
        List<LineSegment> hLines)
    {
        if (vLines.Count < 2 || spans.Count < 2) return false;
        double spanY = spans.Max(s => s.Y1) - spans.Min(s => s.Y0);
        if (spanY <= 0.0) return false;
        double minVY = vLines.Min(v => v.Y0);
        double maxVY = vLines.Max(v => v.Y1);
        double minVX = vLines.Min(v => v.X0);
        int outsideCount = spans.Count(s => s.CenterY < minVY - 4.0 || s.CenterY > maxVY + 4.0 || s.X1 < minVX - 4.0);
        return outsideCount >= 2 || (maxVY - minVY) < spanY * 0.72 || minVX >= 60.0;
    }

    private SolverStrategyKind SelectStrategy(
        List<TextSpan> spans,
        List<LineSegment> hLines,
        List<LineSegment> vLines,
        List<FillBox> rowFills,
        double widthPt,
        bool forceFootnote)
    {
        if (forceFootnote) return SolverStrategyKind.DensityTransitionSplitter;

        // [R-SUBGRID-STACK]: Embedded sub-grids inside KV/dual-track streams route to KeyValueSubGridFlattener BEFORE PlanarGridSolver
        if (HasEmbeddedSubGridZone(spans, vLines, hLines))
        {
            return SolverStrategyKind.KeyValueSubGridFlattener;
        }

        if (vLines.Count >= 3) return SolverStrategyKind.PlanarGridSolver;

        // Check for aligned ':' or '=' operators ([R-COLON-GRID])
        var opXs = FindAlignedOperatorXs(spans);
        if (opXs.Count >= 1)
        {
            bool hasWideH = hLines.Any(h => h.Width >= widthPt * 0.85);
            return hasWideH ? SolverStrategyKind.HLineOperatorSolver : SolverStrategyKind.KeyValueSubGridFlattener;
        }

        // Check for staircase indented hierarchy ([R-STAIRCASE])
        var indentXs = ClusterValues(spans.Select(s => s.X0).ToList(), StaircaseClusterTolPt);
        if (indentXs.Count >= 2 && spans.Any(s => MarkerRegex.IsMatch(s.Text.Trim()) || InlineMarkerRegex.IsMatch(s.Text.Trim())))
        {
            return SolverStrategyKind.IndentationClauseSolver;
        }

        if (rowFills.Count >= 2 && vLines.Count >= 1)
        {
            return SolverStrategyKind.KeyValueSubGridFlattener;
        }

        return SolverStrategyKind.IndentationClauseSolver;
    }

    private static BorderRuleKind ResolveBorderRule(
        SolverStrategyKind strategy,
        List<LineSegment> hLines,
        List<LineSegment> vLines,
        double widthPt)
    {
        if (strategy == SolverStrategyKind.PlanarGridSolver)
        {
            return BorderRuleKind.Grid;
        }

        bool hasTopH = hLines.Any(h => h.Width >= widthPt * 0.80);
        bool hasOuterLeft = vLines.Any(v => v.X0 <= 6.0 && v.Height >= 24.0);
        bool hasOuterRight = vLines.Any(v => v.X0 >= widthPt - 6.0 && v.Height >= 24.0);
        if (hasTopH && hasOuterLeft && hasOuterRight && vLines.Count <= 3)
        {
            return BorderRuleKind.Box; // [R-B-BOX]
        }

        if (hLines.Count >= 1 && vLines.Count == 0)
        {
            return BorderRuleKind.HLine; // [R-B-HLINE]
        }

        return BorderRuleKind.None; // [R-B-NONE]
    }

    private (List<double> ColWidthsPt, List<CompiledRow> Rows) BuildPlanarGridRows(
        List<TextSpan> spans,
        List<LineSegment> hLines,
        List<LineSegment> vLines,
        List<FillBox> rowFills,
        double widthPt)
    {
        var rawXs = new List<double> { 0.0, widthPt };
        rawXs.AddRange(vLines.Select(v => Math.Clamp(v.X0, 0.0, widthPt)));
        var colBounds = PruneEmptyEdgeGhostColumns(
            DeduplicateGridBounds(ClusterValues(rawXs, BorderMatchTolPt), 8.0, widthPt),
            spans,
            vLines,
            widthPt);
        int numCols = Math.Max(1, colBounds.Count - 1);
        var colWidths = Enumerable.Range(0, numCols).Select(c => Math.Round(colBounds[c + 1] - colBounds[c], 2)).ToList();

        // [R-OUTER-LOCK]: Wide ruled tables (VLine >= 6) cut outer rows ONLY on full-width HLine dividers
        var wideHLines = hLines.Where(h => h.Width >= widthPt * 0.78).OrderBy(h => h.Y0).ToList();
        var rawYs = new List<double>();
        if (vLines.Count >= 6 && wideHLines.Count >= 2)
        {
            rawYs.AddRange(wideHLines.Select(h => h.Y0));
        }
        else
        {
            rawYs.AddRange(hLines.Select(h => h.Y0));
            rawYs.AddRange(rowFills.SelectMany(rf => new[] { rf.Y0, rf.Y1 }));
        }
        var gridYs = ClusterValues(rawYs, DedupTolPt);
        if (gridYs.Count < 2 && spans.Count > 0)
        {
            gridYs = new List<double> { spans.Min(s => s.Y0) - 2.0, spans.Max(s => s.Y1) + 2.0 };
        }

        var rows = new List<CompiledRow>();
        for (int r = 0; r < gridYs.Count - 1; r++)
        {
            double yA = gridYs[r];
            double yB = gridYs[r + 1];
            if (yB - yA < 4.0) continue;
            double midY = (yA + yB) / 2.0;

            var rowSpans = spans.Where(s => s.CenterY >= yA - 2.0 && s.CenterY <= yB + 2.0).ToList();
            if (rowSpans.Count == 0 && !rowFills.Any(rf => midY >= rf.Y0 && midY <= rf.Y1)) continue;

            // Respect VLine vertical [y0, y1] spans for multi-tier headers ([R-B-GRID])
            var activeBoundaries = new List<int> { 0 };
            for (int c = 1; c < numCols; c++)
            {
                double bx = colBounds[c];
                bool hasVLineHere = vLines.Any(v =>
                    Math.Abs(v.X0 - bx) <= BorderMatchTolPt &&
                    v.Y0 - 2.0 <= midY &&
                    midY <= v.Y1 + 2.0);
                if (hasVLineHere) activeBoundaries.Add(c);
            }
            activeBoundaries.Add(numCols);

            var rowFill = rowFills.FirstOrDefault(rf => midY >= rf.Y0 - 1.5 && midY <= rf.Y1 + 1.5);
            var cells = new List<CompiledCell>();

            for (int g = 0; g < activeBoundaries.Count - 1; g++)
            {
                int startCol = activeBoundaries[g];
                int endCol = activeBoundaries[g + 1] - 1;
                int spanCols = endCol - startCol + 1;
                double x0 = colBounds[startCol];
                double x1 = colBounds[endCol + 1];
                double cellW = x1 - x0;

                var cellSpans = rowSpans
                    .Where(s => s.CenterX >= x0 - 2.0 && s.CenterX <= x1 + 2.0)
                    .OrderBy(s => Math.Floor(s.Y0 / BaselineQuantPt) * BaselineQuantPt)
                    .ThenBy(s => s.X0)
                    .ToList();

                string cellText = JoinCellSpans(cellSpans);
                var primary = cellSpans.FirstOrDefault();
                double fs = primary?.FontSize ?? 8.5;

                cells.Add(new CompiledCell
                {
                    ColSpan = spanCols,
                    Name = NextName("Cell"),
                    Text = cellText,
                    FontFamily = primary?.FontName ?? "Arial",
                    FontSizePt = fs,
                    IsBold = primary?.IsBold ?? (r == 0),
                    IsItalic = primary?.IsItalic ?? false,
                    TextColorHex = primary?.ColorHex ?? "#0F172A",
                    BackgroundHex = rowFill?.FillHex,
                    TextAlign = InferCellAlign(cellSpans, x0, x1, r == 0),
                    VerticalAlign = "Middle",
                    PadTopPt = 1.5,
                    PadBottomPt = 1.5,
                    PadLeftPt = 3.0,
                    PadRightPt = 3.0,
                    LineHeightPt = Math.Round(fs * 1.25, 2),
                    SourceLineCount = Math.Max(1, cellSpans.Select(s => Math.Round(s.Y0 / 2.0)).Distinct().Count()),
                    SourceX0Pt = primary?.X0 ?? x0
                });
            }

            double rowH = Math.Max(Math.Round(yB - yA, 2), EstimateRowHeightPt(cells, colWidths));
            rows.Add(new CompiledRow
            {
                HeightPt = rowH,
                IsHeaderRow = r == 0,
                SourceY0Pt = yA,
                SourceY1Pt = yB,
                Cells = cells
            });
        }

        return (colWidths, rows);
    }

    private (List<double> ColWidthsPt, List<CompiledRow> Rows) BuildFlowOrStructuredRows(
        SolverStrategyKind strategy,
        List<TextSpan> spans,
        List<LineSegment> hLines,
        List<LineSegment> vLines,
        List<FillBox> rowFills,
        double widthPt)
    {
        var opXs = FindAlignedOperatorXs(spans);
        var yRows = ClusterSpansIntoRows(spans);
        var rawColBounds = new List<double> { 0.0, widthPt };

        if (strategy == SolverStrategyKind.HLineOperatorSolver || strategy == SolverStrategyKind.KeyValueSubGridFlattener)
        {
            // [R-COLON-GRID]: Cluster ':' / '=' X positions within 2.5pt -> narrow operator column
            foreach (var opX in opXs)
            {
                rawColBounds.Add(Math.Clamp(opX, 8.0, widthPt - 16.0));
                rawColBounds.Add(Math.Clamp(opX + 9.0, 16.0, widthPt - 8.0));
            }
        }
        else if (strategy == SolverStrategyKind.IndentationClauseSolver)
        {
            // [R-STAIRCASE]: Cluster marker & body x0 positions within <= 3.0pt -> k narrow indent cols + 1 body col
            var xStarts = ClusterValues(
                spans.SelectMany(s =>
                {
                    var m = InlineMarkerRegex.Match(s.Text.Trim());
                    if (m.Success)
                    {
                        double markerW = Math.Clamp(m.Groups[1].Value.Length * s.FontSize * 0.6 + 4.0, 10.0, 24.0);
                        return new[] { s.X0, Math.Min(widthPt - 12.0, s.X0 + markerW) };
                    }
                    return new[] { s.X0 };
                }).ToList(),
                StaircaseClusterTolPt);

            foreach (var x in xStarts)
            {
                if (x >= 8.0 && x <= widthPt - 16.0) rawColBounds.Add(x);
            }
        }
        else if (strategy == SolverStrategyKind.DensityTransitionSplitter)
        {
            rawColBounds.Add(Math.Min(24.0, widthPt * 0.15));
        }

        rawColBounds.AddRange(vLines.Select(v => Math.Clamp(v.X0, 0.0, widthPt)));
        var colBounds = PruneEmptyEdgeGhostColumns(
            DeduplicateGridBounds(ClusterValues(rawColBounds, 2.5), 8.0, widthPt),
            spans,
            vLines,
            widthPt);
        int numCols = Math.Max(1, colBounds.Count - 1);
        var colWidths = Enumerable.Range(0, numCols).Select(c => Math.Round(colBounds[c + 1] - colBounds[c], 2)).ToList();

        var compiledRows = new List<CompiledRow>();
        foreach (var rowSpans in yRows)
        {
            var expanded = SplitInlineMarkersAndOperators(rowSpans, strategy, opXs);
            if (expanded.Count == 0) continue;
            var primary = expanded[0];
            double y0 = rowSpans.Min(s => s.Y0);
            double y1 = rowSpans.Max(s => s.Y1);
            double midY = (y0 + y1) / 2.0;
            var rowFill = rowFills.FirstOrDefault(rf => midY >= rf.Y0 - 1.5 && midY <= rf.Y1 + 1.5);

            // Build initial 1-col cells then merge empty trailing cells via ColSpan + RemoveAt
            var cells = new List<CompiledCell>(numCols);
            for (int c = 0; c < numCols; c++)
            {
                cells.Add(new CompiledCell
                {
                    ColSpan = 1,
                    Name = NextName("Empty"),
                    Text = string.Empty,
                    FontSizePt = primary.FontSize,
                    BackgroundHex = rowFill?.FillHex
                });
            }

            foreach (var sp in expanded)
            {
                int startCol = FindClosestStartCol(sp.X0, colBounds, numCols);
                cells[startCol] = new CompiledCell
                {
                    ColSpan = 1,
                    Name = NextName("Cell"),
                    Text = sp.Text.Trim(),
                    FontFamily = sp.FontName,
                    FontSizePt = sp.FontSize,
                    IsBold = sp.IsBold,
                    IsItalic = sp.IsItalic,
                    TextColorHex = sp.ColorHex,
                    BackgroundHex = rowFill?.FillHex,
                    TextAlign = sp.Text.Trim() is ":" or "=" ? "Center" : "Left",
                    VerticalAlign = "Middle",
                    PadTopPt = 1.5,
                    PadBottomPt = 1.5,
                    PadLeftPt = 3.0,
                    PadRightPt = 3.0,
                    LineHeightPt = Math.Round(sp.FontSize * 1.3, 2),
                    SourceLineCount = 1,
                    SourceX0Pt = sp.X0
                };
            }

            // [R-COLON-GRID] & [R-STAIRCASE]: Absorb trailing empty cells via ColSpan + RemoveAt
            ExpandColSpanAndRemoveEmpty(cells);

            bool isBoldOnlyRow = expanded.All(s => s.IsBold) && expanded.Count == 1;
            double rowH = EstimateRowHeightPt(cells, colWidths);
            compiledRows.Add(new CompiledRow
            {
                HeightPt = rowH,
                IsBoldTitleRow = isBoldOnlyRow,
                SourceY0Pt = y0,
                SourceY1Pt = y1,
                Cells = cells
            });
        }

        // [R-ROW-PHYS]: Ensure no physical HLine or RowFillBand is bridged
        return (colWidths, compiledRows);
    }

    /// <summary>
    /// Mutates ColSpan and calls RemoveAt on absorbed empty trailing cell objects
    /// while tracking logical columns so sum(ColSpan) == N_columns always holds.
    /// </summary>
    private static void ExpandColSpanAndRemoveEmpty(List<CompiledCell> cells)
    {
        for (int i = 0; i < cells.Count; i++)
        {
            var cur = cells[i];
            if (string.IsNullOrWhiteSpace(cur.Text) && !cur.IsNestedTablix) continue;

            while (i + 1 < cells.Count && string.IsNullOrWhiteSpace(cells[i + 1].Text) && !cells[i + 1].IsNestedTablix)
            {
                cur.ColSpan += cells[i + 1].ColSpan;
                cells.RemoveAt(i + 1);
            }
        }
    }

    private static void EnsureRowColSpanInvariants(List<CompiledRow> rows, int numCols)
    {
        foreach (var row in rows)
        {
            int totalSpan = row.Cells.Sum(c => c.ColSpan);
            if (totalSpan == numCols) continue;
            if (totalSpan < numCols && row.Cells.Count > 0)
            {
                row.Cells[^1].ColSpan += (numCols - totalSpan);
            }
        }
    }

    /// <summary>
    /// [R-ROW-BOLD-MERGE] + [R-COLON-GRID]: Convergent while loop merging consecutive Regular
    /// prose rows AND multi-column KV Label/Value continuations when no HLine/RowFillBand divider separates them.
    /// </summary>
    private static void ConvergeRegularProseMerge(
        List<CompiledRow> rows,
        List<double> colWidthsPt,
        List<LineSegment> hLines,
        List<FillBox> rowFills,
        bool hasBannerRow)
    {
        int startIdx = hasBannerRow ? 1 : 0;
        bool changed;
        do
        {
            changed = false;
            int i = startIdx;
            while (i + 1 < rows.Count)
            {
                var r1 = rows[i];
                var r2 = rows[i + 1];
                if (r1.IsHeaderRow || r2.IsHeaderRow || r1.IsBoldTitleRow || r2.IsBoldTitleRow)
                {
                    i++;
                    continue;
                }

                double dy = r2.SourceY0Pt - r1.SourceY0Pt;
                bool hasPhysDivider =
                    hLines.Any(h => h.Y0 >= r1.SourceY1Pt - 1.5 && h.Y0 <= r2.SourceY0Pt + 1.5) ||
                    rowFills.Any(rf => Math.Abs(rf.Y0 - r2.SourceY0Pt) <= 2.0 || Math.Abs(rf.Y1 - r1.SourceY1Pt) <= 2.0);
                if (dy <= 0 || hasPhysDivider)
                {
                    i++;
                    continue;
                }

                var map1 = MapCellsByLogicalCol(r1.Cells);
                var map2 = MapCellsByLogicalCol(r2.Cells);
                var nonEmpty2 = map2.Where(kv => !string.IsNullOrWhiteSpace(kv.Value.Text)).ToList();
                if (nonEmpty2.Count == 0)
                {
                    i++;
                    continue;
                }

                bool r2HasNewOpOrMarker = nonEmpty2.Any(kv =>
                {
                    var t = kv.Value.Text.Trim();
                    return t is ":" or "=" || PrefixColonRegex.IsMatch(t) ||
                           MarkerRegex.IsMatch(t) || InlineMarkerRegex.IsMatch(t);
                });
                if (r2HasNewOpOrMarker)
                {
                    i++;
                    continue;
                }

                bool allMatched = nonEmpty2.All(kv =>
                {
                    if (!map1.TryGetValue(kv.Key, out var target) || string.IsNullOrWhiteSpace(target.Text)) return false;
                    var targetTrim = target.Text.Trim();
                    if (targetTrim is ":" or "=" || MarkerRegex.IsMatch(targetTrim)) return false;
                    if (target.IsBold || kv.Value.IsBold || target.ColSpan != kv.Value.ColSpan) return false;
                    double maxLeading = Math.Max(8.5, target.FontSizePt) * LeadingRatioMax;
                    return dy <= maxLeading &&
                           Math.Abs(target.SourceX0Pt - kv.Value.SourceX0Pt) <= BoldMergeXTolPt &&
                           (target.BackgroundHex ?? "") == (kv.Value.BackgroundHex ?? "");
                });

                if (allMatched)
                {
                    foreach (var kv in nonEmpty2)
                    {
                        var target = map1[kv.Key];
                        string prevTxt = target.Text.Trim();
                        string nextTxt = kv.Value.Text.Trim();
                        string sep = prevTxt.EndsWith(":", StringComparison.Ordinal) ? "\n" : " ";
                        target.Text = $"{prevTxt}{sep}{nextTxt}";
                        target.SourceLineCount += kv.Value.SourceLineCount;
                    }
                    r1.SourceY1Pt = Math.Max(r1.SourceY1Pt, r2.SourceY1Pt);
                    r1.HeightPt = EstimateRowHeightPt(r1.Cells, colWidthsPt);
                    rows.RemoveAt(i + 1);
                    changed = true;
                    continue;
                }

                i++;
            }
        } while (changed);
    }

    private static Dictionary<int, CompiledCell> MapCellsByLogicalCol(List<CompiledCell> cells)
    {
        var map = new Dictionary<int, CompiledCell>();
        int col = 0;
        foreach (var cell in cells)
        {
            map[col] = cell;
            col += cell.ColSpan;
        }
        return map;
    }

    private static void ApplyBorderRule(
        List<CompiledRow> rows,
        List<double> colWidthsPt,
        BorderRuleKind borderMode,
        List<LineSegment> hLines,
        List<LineSegment> vLines,
        double widthPt,
        bool hasBannerRow)
    {
        int firstBodyIdx = hasBannerRow ? 1 : 0;
        if (rows.Count <= firstBodyIdx) return;

        var colStarts = new List<double> { 0.0 };
        foreach (var w in colWidthsPt) colStarts.Add(colStarts[^1] + w);

        for (int rIdx = firstBodyIdx; rIdx < rows.Count; rIdx++)
        {
            var row = rows[rIdx];
            int logicalCol = 0;
            foreach (var cell in row.Cells)
            {
                double x0 = colStarts[Math.Min(logicalCol, colStarts.Count - 1)];
                double x1 = colStarts[Math.Min(logicalCol + cell.ColSpan, colStarts.Count - 1)];
                double cellW = Math.Max(1.0, x1 - x0);
                double y0 = row.SourceY0Pt;
                double y1 = row.SourceY1Pt > y0 ? row.SourceY1Pt : y0 + row.HeightPt;
                double cellH = Math.Max(1.0, y1 - y0);

                if (borderMode == BorderRuleKind.None)
                {
                    cell.Borders = new CellBorders();
                    cell.AppliedBorderRule = BorderRuleKind.None;
                }
                else if (borderMode == BorderRuleKind.Box)
                {
                    bool isTop = rIdx == firstBodyIdx;
                    bool isBot = rIdx == rows.Count - 1;
                    bool isLeft = logicalCol == 0;
                    bool isRight = logicalCol + cell.ColSpan >= colWidthsPt.Count;
                    cell.Borders = new CellBorders
                    {
                        Top = isTop ? SolidEdge() : NoneEdge(),
                        Bottom = isBot ? SolidEdge() : NoneEdge(),
                        Left = isLeft ? SolidEdge() : NoneEdge(),
                        Right = isRight ? SolidEdge() : NoneEdge()
                    };
                    cell.AppliedBorderRule = BorderRuleKind.Box;
                }
                else if (borderMode == BorderRuleKind.HLine)
                {
                    bool matchTop = MatchesHLine(hLines, y0, x0, x1, cellW);
                    bool matchBot = MatchesHLine(hLines, y1, x0, x1, cellW);
                    cell.Borders = new CellBorders
                    {
                        Top = matchTop ? SolidEdge() : NoneEdge(),
                        Bottom = matchBot ? SolidEdge() : NoneEdge(),
                        Left = NoneEdge(),
                        Right = NoneEdge()
                    };
                    cell.AppliedBorderRule = BorderRuleKind.HLine;
                }
                else if (borderMode == BorderRuleKind.Grid)
                {
                    bool matchTop = rIdx == firstBodyIdx
                        ? MatchesHLine(hLines, y0, x0, x1, cellW) || vLines.Count >= 3
                        : MatchesHLine(hLines, y0, x0, x1, cellW);
                    bool matchBot = MatchesHLine(hLines, y1, x0, x1, cellW);
                    bool matchLeft = MatchesVLine(vLines, x0, y0, y1, cellH);
                    bool matchRight = MatchesVLine(vLines, x1, y0, y1, cellH);
                    cell.Borders = new CellBorders
                    {
                        Top = matchTop ? SolidEdge() : NoneEdge(),
                        Bottom = matchBot ? SolidEdge() : NoneEdge(),
                        Left = matchLeft ? SolidEdge() : NoneEdge(),
                        Right = matchRight ? SolidEdge() : NoneEdge()
                    };
                    cell.AppliedBorderRule = BorderRuleKind.Grid;
                }

                logicalCol += cell.ColSpan;
            }
        }
    }

    private static bool MatchesHLine(List<LineSegment> hLines, double yEdge, double x0, double x1, double cellW)
    {
        return hLines.Any(h =>
        {
            if (Math.Abs(h.Y0 - yEdge) > BorderMatchTolPt) return false;
            double overlap = Math.Min(h.X1, x1) - Math.Max(h.X0, x0);
            return overlap / cellW >= BorderCoverageMin;
        });
    }

    private static bool MatchesVLine(List<LineSegment> vLines, double xEdge, double y0, double y1, double cellH)
    {
        return vLines.Any(v =>
        {
            if (Math.Abs(v.X0 - xEdge) > BorderMatchTolPt) return false;
            double overlap = Math.Min(v.Y1, y1) - Math.Max(v.Y0, y0);
            return overlap / cellH >= BorderCoverageMin;
        });
    }

    private static EdgeBorder SolidEdge() => new() { Style = "Solid", ColorHex = "#CBD5E1", WidthPt = 0.5 };
    private static EdgeBorder NoneEdge() => new() { Style = "None" };

    private static void CompactPageToPrintableHeight(List<CompiledTablix> pageTablixes, double printableHeightPt)
    {
        if (pageTablixes.Count == 0) return;

        double ComputePageHeight() =>
            pageTablixes.Max(t => t.TopPt + t.HeightPt) - pageTablixes.Min(t => t.TopPt);

        double compiledH = ComputePageHeight();
        if (compiledH <= printableHeightPt) return;

        double ratio = Math.Max(0.65, (printableHeightPt - 2.0) / compiledH);
        double minTop = pageTablixes.Min(t => t.TopPt);

        foreach (var tbl in pageTablixes)
        {
            CompactTablixRecursive(tbl, ratio);
        }

        // Re-flow non-right-track and right-track Top cursors proportionally
        double cursor = minTop;
        foreach (var tbl in pageTablixes.Where(t => !t.IsRightTrack))
        {
            tbl.TopPt = Math.Round(cursor, 2);
            cursor = tbl.TopPt + tbl.HeightPt + 2.0;
        }
    }

    private static void CompactTablixRecursive(CompiledTablix tbl, double ratio)
    {
        foreach (var row in tbl.Rows)
        {
            double minFont = row.Cells.Select(c => c.FontSizePt).DefaultIfEmpty(8.0).Min();
            double minRowH = Math.Max(9.5, minFont * 1.08);
            foreach (var cell in row.Cells)
            {
                if (cell.NestedTablix is not null)
                {
                    CompactTablixRecursive(cell.NestedTablix, ratio);
                }
                cell.PadTopPt = Math.Max(0.25, Math.Round(cell.PadTopPt * ratio, 2));
                cell.PadBottomPt = Math.Max(0.25, Math.Round(cell.PadBottomPt * ratio, 2));
            }
            double nestedMaxH = row.Cells.Where(c => c.NestedTablix is not null)
                .Select(c => c.NestedTablix!.HeightPt)
                .DefaultIfEmpty(0.0)
                .Max();
            row.HeightPt = Math.Max(nestedMaxH, Math.Max(minRowH, Math.Round(row.HeightPt * ratio, 2)));
        }
        tbl.HeightPt = Math.Round(tbl.Rows.Sum(r => r.HeightPt), 2);
    }

    public XDocument SerializeRdlc2008(
        List<LayoutIrPage> pages,
        List<CompiledTablix> bodyTablixes,
        double pageWidthPt,
        double pageHeightPt,
        double headerHeightPt,
        double footerHeightPt)
    {
        var embeddedImages = new List<XElement>();
        var firstLogo = pages.FirstOrDefault(p => !string.IsNullOrWhiteSpace(p.HeaderLogoBase64));
        if (firstLogo is not null)
        {
            embeddedImages.Add(new XElement(Rdl2008Ns + "EmbeddedImage",
                new XAttribute("Name", "HeaderLogo"),
                new XElement(Rdl2008Ns + "MIMEType", "image/png"),
                new XElement(Rdl2008Ns + "ImageData", firstLogo.HeaderLogoBase64!)));
        }

        double printableWidthPt = Math.Max(144.0, pageWidthPt - 2.0 * MarginPt);
        double bodyHeightPt = bodyTablixes.Count > 0
            ? bodyTablixes.Max(t => t.TopPt + t.HeightPt) + 6.0
            : 72.0;

        var report = new XElement(Rdl2008Ns + "Report",
            new XAttribute(XNamespace.Xmlns + "rd", RdNs),
            new XElement(Rdl2008Ns + "DataSources",
                new XElement(Rdl2008Ns + "DataSource",
                    new XAttribute("Name", "DummyDataSource"),
                    new XElement(Rdl2008Ns + "ConnectionProperties",
                        new XElement(Rdl2008Ns + "DataProvider", "System.Data.DataSet"),
                        new XElement(Rdl2008Ns + "ConnectString", "/* Local Connection */")
                    )
                )
            ),
            new XElement(Rdl2008Ns + "DataSets",
                new XElement(Rdl2008Ns + "DataSet",
                    new XAttribute("Name", "dsReport"),
                    new XElement(Rdl2008Ns + "Query",
                        new XElement(Rdl2008Ns + "DataSourceName", "DummyDataSource"),
                        new XElement(Rdl2008Ns + "CommandText", "/* Local Query */")
                    ),
                    new XElement(Rdl2008Ns + "Fields",
                        new XElement(Rdl2008Ns + "Field",
                            new XAttribute("Name", "Placeholder"),
                            new XElement(Rdl2008Ns + "DataField", "Placeholder"),
                            new XElement(RdNs + "TypeName", "System.String")
                        )
                    )
                )
            ),
            new XElement(Rdl2008Ns + "Body",
                new XElement(Rdl2008Ns + "ReportItems", bodyTablixes.Select(BuildTablixElement)),
                new XElement(Rdl2008Ns + "Height", FmtCmFromPt(bodyHeightPt))
            ),
            new XElement(Rdl2008Ns + "Width", FmtCmFromPt(printableWidthPt)),
            BuildPageElement(pages[0], pageWidthPt, pageHeightPt, headerHeightPt, footerHeightPt, firstLogo is not null)
        );

        if (embeddedImages.Count > 0)
        {
            report.Add(new XElement(Rdl2008Ns + "EmbeddedImages", embeddedImages));
        }

        return new XDocument(new XDeclaration("1.0", "utf-8", null), report);
    }

    private XElement BuildPageElement(
        LayoutIrPage firstPage,
        double pageWidthPt,
        double pageHeightPt,
        double headerHeightPt,
        double footerHeightPt,
        bool hasLogo)
    {
        var pageEl = new XElement(Rdl2008Ns + "Page");

        if (headerHeightPt > 0)
        {
            var hdrItems = new List<XElement>();
            if (hasLogo)
            {
                var r = firstPage.HeaderLogoRect;
                double wPt = r is not null ? Math.Max(18.0, r.X1 - r.X0) : 110.0;
                double hPt = r is not null ? Math.Max(12.0, r.Y1 - r.Y0) : 28.0;
                hdrItems.Add(new XElement(Rdl2008Ns + "Image",
                    new XAttribute("Name", "imgHeaderLogo"),
                    new XElement(Rdl2008Ns + "Source", "Embedded"),
                    new XElement(Rdl2008Ns + "Value", "HeaderLogo"),
                    new XElement(Rdl2008Ns + "Sizing", "FitProportional"),
                    new XElement(Rdl2008Ns + "Top", FmtCmFromPt(2.0)),
                    new XElement(Rdl2008Ns + "Left", FmtCmFromPt(0.0)),
                    new XElement(Rdl2008Ns + "Height", FmtCmFromPt(hPt)),
                    new XElement(Rdl2008Ns + "Width", FmtCmFromPt(wPt)),
                    new XElement(Rdl2008Ns + "Style", new XElement(Rdl2008Ns + "Border", new XElement(Rdl2008Ns + "Style", "None")))
                ));
            }
            pageEl.Add(new XElement(Rdl2008Ns + "PageHeader",
                new XElement(Rdl2008Ns + "Height", FmtCmFromPt(headerHeightPt)),
                new XElement(Rdl2008Ns + "PrintOnFirstPage", "true"),
                new XElement(Rdl2008Ns + "PrintOnLastPage", "true"),
                new XElement(Rdl2008Ns + "ReportItems", hdrItems),
                new XElement(Rdl2008Ns + "Style", new XElement(Rdl2008Ns + "Border", new XElement(Rdl2008Ns + "Style", "None")))
            ));
        }

        if (footerHeightPt > 0)
        {
            pageEl.Add(new XElement(Rdl2008Ns + "PageFooter",
                new XElement(Rdl2008Ns + "Height", FmtCmFromPt(footerHeightPt)),
                new XElement(Rdl2008Ns + "PrintOnFirstPage", "true"),
                new XElement(Rdl2008Ns + "PrintOnLastPage", "true"),
                new XElement(Rdl2008Ns + "ReportItems"),
                new XElement(Rdl2008Ns + "Style", new XElement(Rdl2008Ns + "Border", new XElement(Rdl2008Ns + "Style", "None")))
            ));
        }

        pageEl.Add(
            new XElement(Rdl2008Ns + "PageHeight", FmtCmFromPt(pageHeightPt)),
            new XElement(Rdl2008Ns + "PageWidth", FmtCmFromPt(pageWidthPt)),
            new XElement(Rdl2008Ns + "LeftMargin", FmtCmFromPt(MarginPt)),
            new XElement(Rdl2008Ns + "RightMargin", FmtCmFromPt(MarginPt)),
            new XElement(Rdl2008Ns + "TopMargin", FmtCmFromPt(MarginPt)),
            new XElement(Rdl2008Ns + "BottomMargin", FmtCmFromPt(MarginPt))
        );

        return pageEl;
    }

    private XElement BuildTablixElement(CompiledTablix tablix)
    {
        var el = new XElement(Rdl2008Ns + "Tablix",
            new XAttribute("Name", tablix.Name),
            new XElement(Rdl2008Ns + "TablixBody",
                new XElement(Rdl2008Ns + "TablixColumns",
                    tablix.ColumnWidthsPt.Select(w =>
                        new XElement(Rdl2008Ns + "TablixColumn",
                            new XElement(Rdl2008Ns + "Width", FmtCmFromPt(Math.Max(6.0, w)))
                        )
                    )
                ),
                new XElement(Rdl2008Ns + "TablixRows",
                    tablix.Rows.Select(r => BuildTablixRowElement(r))
                )
            ),
            new XElement(Rdl2008Ns + "TablixColumnHierarchy",
                new XElement(Rdl2008Ns + "TablixMembers",
                    tablix.ColumnWidthsPt.Select(_ => new XElement(Rdl2008Ns + "TablixMember"))
                )
            ),
            new XElement(Rdl2008Ns + "TablixRowHierarchy",
                new XElement(Rdl2008Ns + "TablixMembers",
                    tablix.Rows.Select(_ =>
                        new XElement(Rdl2008Ns + "TablixMember",
                            new XElement(Rdl2008Ns + "KeepWithGroup", "After")
                        )
                    )
                )
            ),
            new XElement(Rdl2008Ns + "DataSetName", "dsReport")
        );

        if (!tablix.IsNested && tablix.PageBreakBefore)
        {
            el.Add(new XElement(Rdl2008Ns + "PageBreak",
                new XElement(Rdl2008Ns + "BreakLocation", "Start")));
        }

        if (!tablix.IsNested)
        {
            el.Add(
                new XElement(Rdl2008Ns + "Top", FmtCmFromPt(tablix.TopPt)),
                new XElement(Rdl2008Ns + "Left", FmtCmFromPt(tablix.LeftPt))
            );
        }

        el.Add(
            new XElement(Rdl2008Ns + "Height", FmtCmFromPt(Math.Max(8.0, tablix.HeightPt))),
            new XElement(Rdl2008Ns + "Width", FmtCmFromPt(Math.Max(24.0, tablix.WidthPt)))
        );

        if (!tablix.IsNested)
        {
            el.Add(new XElement(Rdl2008Ns + "ZIndex", 1));
        }

        el.Add(new XElement(Rdl2008Ns + "Style",
            new XElement(Rdl2008Ns + "Border",
                new XElement(Rdl2008Ns + "Style", "None"))));

        return el;
    }

    private XElement BuildTablixRowElement(CompiledRow row)
    {
        var xmlCells = new List<XElement>();
        foreach (var cell in row.Cells)
        {
            var cellContents = new XElement(Rdl2008Ns + "CellContents");
            if (cell.NestedTablix is not null)
            {
                cellContents.Add(BuildTablixElement(cell.NestedTablix));
            }
            else
            {
                cellContents.Add(BuildTextboxElement(cell));
            }

            if (cell.ColSpan > 1)
            {
                cellContents.Add(new XElement(Rdl2008Ns + "ColSpan", cell.ColSpan));
            }

            xmlCells.Add(new XElement(Rdl2008Ns + "TablixCell", cellContents));

            // Strict RDLC 2008 XSD requires (ColSpan - 1) empty <TablixCell /> placeholders
            for (int k = 1; k < cell.ColSpan; k++)
            {
                xmlCells.Add(new XElement(Rdl2008Ns + "TablixCell"));
            }
        }

        return new XElement(Rdl2008Ns + "TablixRow",
            new XElement(Rdl2008Ns + "Height", FmtCmFromPt(Math.Max(8.0, row.HeightPt))),
            new XElement(Rdl2008Ns + "TablixCells", xmlCells));
    }

    private static XElement BuildTextboxElement(CompiledCell cell)
    {
        var styleEl = new XElement(Rdl2008Ns + "Style",
            new XElement(Rdl2008Ns + "Border", new XElement(Rdl2008Ns + "Style", "None")),
            BuildEdgeElement("TopBorder", cell.Borders.Top),
            BuildEdgeElement("BottomBorder", cell.Borders.Bottom),
            BuildEdgeElement("LeftBorder", cell.Borders.Left),
            BuildEdgeElement("RightBorder", cell.Borders.Right)
        );

        if (!string.IsNullOrWhiteSpace(cell.BackgroundHex))
        {
            styleEl.Add(new XElement(Rdl2008Ns + "BackgroundColor", cell.BackgroundHex));
        }

        styleEl.Add(
            new XElement(Rdl2008Ns + "VerticalAlign", cell.VerticalAlign),
            new XElement(Rdl2008Ns + "PaddingLeft", $"{cell.PadLeftPt:0.##}pt"),
            new XElement(Rdl2008Ns + "PaddingRight", $"{cell.PadRightPt:0.##}pt"),
            new XElement(Rdl2008Ns + "PaddingTop", $"{cell.PadTopPt:0.##}pt"),
            new XElement(Rdl2008Ns + "PaddingBottom", $"{cell.PadBottomPt:0.##}pt")
        );

        return new XElement(Rdl2008Ns + "Textbox",
            new XAttribute("Name", cell.Name),
            new XElement(Rdl2008Ns + "CanGrow", "true"),
            new XElement(Rdl2008Ns + "CanShrink", "false"),
            new XElement(Rdl2008Ns + "KeepTogether", "true"),
            new XElement(Rdl2008Ns + "Paragraphs",
                new XElement(Rdl2008Ns + "Paragraph",
                    new XElement(Rdl2008Ns + "TextRuns",
                        new XElement(Rdl2008Ns + "TextRun",
                            new XElement(Rdl2008Ns + "Value", cell.Text),
                            new XElement(Rdl2008Ns + "Style",
                                new XElement(Rdl2008Ns + "FontFamily", cell.FontFamily),
                                new XElement(Rdl2008Ns + "FontSize", $"{cell.FontSizePt:0.##}pt"),
                                new XElement(Rdl2008Ns + "FontWeight", cell.IsBold ? "Bold" : "Normal"),
                                new XElement(Rdl2008Ns + "FontStyle", cell.IsItalic ? "Italic" : "Normal"),
                                new XElement(Rdl2008Ns + "Color", cell.TextColorHex)
                            )
                        )
                    ),
                    new XElement(Rdl2008Ns + "Style",
                        new XElement(Rdl2008Ns + "TextAlign", cell.TextAlign),
                        new XElement(Rdl2008Ns + "LineHeight", $"{cell.LineHeightPt:0.##}pt")
                    )
                )
            ),
            styleEl
        );
    }

    private static XElement BuildEdgeElement(string tagName, EdgeBorder edge)
    {
        if (!string.Equals(edge.Style, "Solid", StringComparison.OrdinalIgnoreCase))
        {
            return new XElement(Rdl2008Ns + tagName, new XElement(Rdl2008Ns + "Style", "None"));
        }
        return new XElement(Rdl2008Ns + tagName,
            new XElement(Rdl2008Ns + "Color", edge.ColorHex),
            new XElement(Rdl2008Ns + "Style", "Solid"),
            new XElement(Rdl2008Ns + "Width", $"{Math.Max(0.5, edge.WidthPt):0.##}pt"));
    }

    public List<string> ValidateRdlc2008(XDocument doc)
    {
        var errors = new List<string>();
        var root = doc.Root;
        if (root is null || root.Name != Rdl2008Ns + "Report")
        {
            errors.Add("Root <Report> must use RDLC 2008 namespace.");
            return errors;
        }

        var forbidden = new[]
        {
            "RowSpan", "Visibility", "ReportSections", "ReportSection",
            "ReportParameters", "ReportParametersLayout", "AutoRefresh", "LeftIndent"
        };
        foreach (var el in root.Descendants())
        {
            if (forbidden.Contains(el.Name.LocalName))
            {
                errors.Add($"Forbidden RDLC 2008 element <{el.Name.LocalName}> detected.");
            }
        }

        void ValidateTablix(XElement tbl, int depth)
        {
            string tblName = (string?)tbl.Attribute("Name") ?? "(unnamed)";
            if (depth > 1)
            {
                errors.Add($"Tablix '{tblName}' exceeds allowed 1-level nesting for [R-PARENT-NESTED].");
            }
            if (depth > 0 && tbl.Descendants(Rdl2008Ns + "PageBreak").Any())
            {
                errors.Add($"Nested Tablix '{tblName}' must not declare <PageBreak>.");
            }

            var cols = tbl.Element(Rdl2008Ns + "TablixBody")?.Element(Rdl2008Ns + "TablixColumns")?.Elements(Rdl2008Ns + "TablixColumn").ToList() ?? new();
            var colMembers = tbl.Element(Rdl2008Ns + "TablixColumnHierarchy")?.Element(Rdl2008Ns + "TablixMembers")?.Elements(Rdl2008Ns + "TablixMember").ToList() ?? new();
            if (cols.Count != colMembers.Count)
            {
                errors.Add($"Tablix '{tblName}' TablixColumns ({cols.Count}) != TablixColumnHierarchy members ({colMembers.Count}).");
            }

            var rows = tbl.Element(Rdl2008Ns + "TablixBody")?.Element(Rdl2008Ns + "TablixRows")?.Elements(Rdl2008Ns + "TablixRow").ToList() ?? new();
            var rowMembers = tbl.Element(Rdl2008Ns + "TablixRowHierarchy")?.Element(Rdl2008Ns + "TablixMembers")?.Elements(Rdl2008Ns + "TablixMember").ToList() ?? new();
            if (rows.Count != rowMembers.Count)
            {
                errors.Add($"Tablix '{tblName}' TablixRows ({rows.Count}) != TablixRowHierarchy members ({rowMembers.Count}).");
            }

            for (int r = 0; r < rows.Count; r++)
            {
                var cells = rows[r].Element(Rdl2008Ns + "TablixCells")?.Elements(Rdl2008Ns + "TablixCell").ToList() ?? new();
                if (cells.Count != cols.Count)
                {
                    errors.Add($"Tablix '{tblName}' row {r} has {cells.Count} TablixCell elements, expected {cols.Count}.");
                }
                foreach (var cell in cells)
                {
                    var cc = cell.Element(Rdl2008Ns + "CellContents");
                    if (cc is null) continue;
                    var nested = cc.Element(Rdl2008Ns + "Tablix");
                    if (nested is not null)
                    {
                        ValidateTablix(nested, depth + 1);
                    }
                    var tb = cc.Element(Rdl2008Ns + "Textbox");
                    if (tb is not null)
                    {
                        if ((string?)tb.Element(Rdl2008Ns + "CanGrow") != "true" ||
                            (string?)tb.Element(Rdl2008Ns + "CanShrink") != "false")
                        {
                            errors.Add($"Textbox '{(string?)tb.Attribute("Name")}' must have CanGrow=true and CanShrink=false.");
                        }
                    }
                }
            }
        }

        var bodyItems = root.Element(Rdl2008Ns + "Body")?.Element(Rdl2008Ns + "ReportItems");
        if (bodyItems is not null)
        {
            foreach (var tbl in bodyItems.Elements(Rdl2008Ns + "Tablix"))
            {
                ValidateTablix(tbl, 0);
            }
        }

        return errors;
    }

    private CompiledCell BuildBannerCell(FillBox banner, string titleText, int colSpan)
    {
        bool isDark = banner.Luminance < 0.45;
        return new CompiledCell
        {
            ColSpan = Math.Max(1, colSpan),
            Name = NextName("Banner"),
            Text = titleText,
            FontFamily = "Arial",
            FontSizePt = 9.5,
            IsBold = true,
            TextColorHex = isDark ? "#FFFFFF" : "#0F172A",
            BackgroundHex = banner.FillHex,
            TextAlign = "Left",
            VerticalAlign = "Middle",
            PadTopPt = 2.0,
            PadBottomPt = 2.0,
            PadLeftPt = 5.0,
            PadRightPt = 5.0,
            LineHeightPt = 12.5
        };
    }

    private static List<List<TextSpan>> ClusterSpansIntoRows(List<TextSpan> spans)
    {
        var sorted = spans
            .OrderBy(s => Math.Floor(s.Y0 / BaselineQuantPt) * BaselineQuantPt)
            .ThenBy(s => s.X0)
            .ToList();
        var rows = new List<List<TextSpan>>();
        foreach (var sp in sorted)
        {
            if (rows.Count > 0 && Math.Abs(sp.Y0 - rows[^1][0].Y0) <= Math.Min(3.5, sp.FontSize * 0.45))
            {
                rows[^1].Add(sp);
            }
            else
            {
                rows.Add(new List<TextSpan> { sp });
            }
        }
        foreach (var r in rows) r.Sort((a, b) => a.X0.CompareTo(b.X0));
        return rows;
    }

    private static List<double> FindAlignedOperatorXs(List<TextSpan> spans)
    {
        var candXs = new List<double>();
        foreach (var sp in spans)
        {
            string t = sp.Text.Trim();
            if (t is ":" or "=")
            {
                candXs.Add(sp.X0);
            }
            else if (PrefixColonRegex.IsMatch(t))
            {
                candXs.Add(sp.X0);
            }
            else
            {
                var m = InlineColonRegex.Match(t);
                if (m.Success && !(m.Groups[2].Value == ":" && Regex.IsMatch(m.Groups[1].Value.Trim(), @"\d$") && Regex.IsMatch(m.Groups[3].Value.Trim(), @"^\d")))
                {
                    double ratio = (m.Groups[1].Value.Length + 0.5) / Math.Max(1, t.Length);
                    candXs.Add(sp.X0 + sp.Width * ratio);
                }
            }
        }

        var clustered = ClusterValues(candXs, ColonClusterTolPt);
        return clustered.Where(cx => candXs.Count(x => Math.Abs(x - cx) <= ColonClusterTolPt) >= 2).ToList();
    }

    private static List<TextSpan> SplitInlineMarkersAndOperators(
        List<TextSpan> rowSpans,
        SolverStrategyKind strategy,
        List<double> alignedOpXs)
    {
        var result = new List<TextSpan>();
        foreach (var sp in rowSpans)
        {
            string t = sp.Text.Trim();
            if (strategy == SolverStrategyKind.IndentationClauseSolver)
            {
                var m = InlineMarkerRegex.Match(t);
                if (m.Success)
                {
                    double markerW = Math.Clamp(m.Groups[1].Value.Length * sp.FontSize * 0.6 + 4.0, 10.0, 24.0);
                    result.Add(CloneSpan(sp, m.Groups[1].Value, sp.X0, sp.X0 + markerW));
                    result.Add(CloneSpan(sp, m.Groups[2].Value, sp.X0 + markerW, Math.Max(sp.X0 + markerW + 10.0, sp.X1)));
                    continue;
                }
            }

            if (strategy is SolverStrategyKind.HLineOperatorSolver or SolverStrategyKind.KeyValueSubGridFlattener)
            {
                var pm = PrefixColonRegex.Match(t);
                if (pm.Success)
                {
                    double matchedOpX = alignedOpXs.FirstOrDefault(ax => Math.Abs(ax - sp.X0) <= 4.0);
                    double opX = matchedOpX > 0 ? matchedOpX : sp.X0;
                    result.Add(CloneSpan(sp, pm.Groups[1].Value, opX, opX + 9.0));
                    result.Add(CloneSpan(sp, pm.Groups[2].Value.Trim(), opX + 11.0, Math.Max(opX + 20.0, sp.X1)));
                    continue;
                }

                var om = InlineColonRegex.Match(t);
                if (om.Success && !(om.Groups[2].Value == ":" && Regex.IsMatch(om.Groups[1].Value.Trim(), @"\d$") && Regex.IsMatch(om.Groups[3].Value.Trim(), @"^\d")))
                {
                    double estOpX = sp.X0 + Math.Min(sp.Width * 0.45, om.Groups[1].Value.Length * sp.FontSize * 0.52 + 4.0);
                    double snappedOpX = alignedOpXs
                        .Where(ax => ax > sp.X0 + 8.0 && Math.Abs(ax - estOpX) <= Math.Max(22.0, om.Groups[1].Value.Length * sp.FontSize * 0.65))
                        .OrderBy(ax => Math.Abs(ax - estOpX))
                        .FirstOrDefault();
                    double opX = snappedOpX > 0 ? snappedOpX : (sp.X0 + sp.Width * ((om.Groups[1].Value.Length + 0.5) / Math.Max(1, t.Length)));
                    result.Add(CloneSpan(sp, om.Groups[1].Value.Trim(), sp.X0, Math.Max(sp.X0 + 8.0, opX - 2.0)));
                    result.Add(CloneSpan(sp, om.Groups[2].Value, opX, opX + 9.0));
                    result.Add(CloneSpan(sp, om.Groups[3].Value.Trim(), opX + 11.0, Math.Max(opX + 20.0, sp.X1)));
                    continue;
                }
            }

            result.Add(sp);
        }
        return result;
    }

    private static TextSpan CloneSpan(TextSpan src, string text, double x0, double x1) => new()
    {
        Text = text,
        X0 = x0,
        Y0 = src.Y0,
        X1 = x1,
        Y1 = src.Y1,
        FontSize = src.FontSize,
        FontName = src.FontName,
        IsBold = src.IsBold,
        IsItalic = src.IsItalic,
        ColorHex = src.ColorHex
    };

    private static List<LineSegment> DedupLines(List<LineSegment> lines, bool horizontal)
    {
        if (lines.Count == 0) return lines;
        var sorted = horizontal
            ? lines.OrderBy(l => l.Y0).ThenBy(l => l.X0).ToList()
            : lines.OrderBy(l => l.X0).ThenBy(l => l.Y0).ToList();

        var merged = new List<LineSegment> { sorted[0] };
        for (int i = 1; i < sorted.Count; i++)
        {
            var cur = sorted[i];
            var prev = merged[^1];
            if (horizontal && Math.Abs(cur.Y0 - prev.Y0) <= DedupTolPt && cur.X0 <= prev.X1 + 3.0)
            {
                prev.X0 = Math.Min(prev.X0, cur.X0);
                prev.X1 = Math.Max(prev.X1, cur.X1);
            }
            else if (!horizontal && Math.Abs(cur.X0 - prev.X0) <= DedupTolPt && cur.Y0 <= prev.Y1 + 3.0)
            {
                prev.Y0 = Math.Min(prev.Y0, cur.Y0);
                prev.Y1 = Math.Max(prev.Y1, cur.Y1);
            }
            else
            {
                merged.Add(cur);
            }
        }
        return merged;
    }

    private static List<double> ClusterValues(List<double> vals, double tol)
    {
        if (vals.Count == 0) return new List<double>();
        var sorted = vals.OrderBy(v => v).ToList();
        var groups = new List<List<double>> { new() { sorted[0] } };
        for (int i = 1; i < sorted.Count; i++)
        {
            double avg = groups[^1].Average();
            if (Math.Abs(sorted[i] - avg) <= tol)
            {
                groups[^1].Add(sorted[i]);
            }
            else
            {
                groups.Add(new List<double> { sorted[i] });
            }
        }
        return groups.Select(g => Math.Round(g.Average(), 2)).ToList();
    }

    private static List<double> DeduplicateGridBounds(List<double> clustered, double minColW, double widthPt)
    {
        var bounds = new List<double> { 0.0 };
        foreach (var x in clustered)
        {
            if (x - bounds[^1] >= minColW && widthPt - x >= minColW)
            {
                bounds.Add(x);
            }
        }
        bounds.Add(widthPt);
        return bounds;
    }

    private static List<double> PruneEmptyEdgeGhostColumns(
        List<double> bounds,
        List<TextSpan> spans,
        List<LineSegment> vLines,
        double widthPt)
    {
        var pruned = new List<double>(bounds);
        if (pruned.Count >= 3)
        {
            double b1 = pruned[1];
            bool anyLeft = spans.Any(s => s.X0 < b1 - 2.0) || vLines.Any(v => v.X0 < b1 - 2.0);
            bool wallAtB1 = vLines.Any(v => Math.Abs(v.X0 - b1) <= BorderMatchTolPt);
            if (!anyLeft && !wallAtB1 && b1 <= 24.0)
            {
                pruned.RemoveAt(1);
            }
        }
        if (pruned.Count >= 3)
        {
            double bLast = pruned[^2];
            bool anyRight = spans.Any(s => s.X1 > bLast + 2.0) || vLines.Any(v => v.X0 > bLast + 2.0);
            bool wallAtLast = vLines.Any(v => Math.Abs(v.X0 - bLast) <= BorderMatchTolPt);
            if (!anyRight && !wallAtLast && widthPt - bLast <= 14.0)
            {
                pruned.RemoveAt(pruned.Count - 2);
            }
        }
        return pruned;
    }

    private static int FindClosestStartCol(double x0, List<double> colBounds, int numCols)
    {
        int bestCol = 0;
        double bestDist = double.MaxValue;
        for (int c = 0; c < numCols; c++)
        {
            double dist = Math.Abs(x0 - colBounds[c]);
            if (dist <= 4.5 && dist < bestDist)
            {
                bestDist = dist;
                bestCol = c;
            }
        }
        if (bestDist < double.MaxValue) return bestCol;

        for (int c = 0; c < numCols; c++)
        {
            if (x0 >= colBounds[c]) bestCol = c;
        }
        return Math.Clamp(bestCol, 0, Math.Max(0, numCols - 1));
    }

    private static string JoinCellSpans(List<TextSpan> cellSpans)
    {
        if (cellSpans.Count == 0) return string.Empty;
        var sb = new System.Text.StringBuilder();
        for (int i = 0; i < cellSpans.Count; i++)
        {
            var cur = cellSpans[i];
            if (i > 0)
            {
                var prev = cellSpans[i - 1];
                bool sameLine = Math.Abs(cur.Y0 - prev.Y0) <= 3.0;
                sb.Append(sameLine ? ' ' : '\n');
            }
            sb.Append(cur.Text.Trim());
        }
        return sb.ToString();
    }

    private static string InferCellAlign(List<TextSpan> cellSpans, double x0, double x1, bool isHeader)
    {
        if (cellSpans.Count == 0) return "Left";
        double colMid = (x0 + x1) / 2.0;
        double textMid = (cellSpans.Min(s => s.X0) + cellSpans.Max(s => s.X1)) / 2.0;
        if (Math.Abs(textMid - colMid) <= 4.0) return "Center";
        string txt = string.Join(" ", cellSpans.Select(s => s.Text.Trim()));
        if (!isHeader && Regex.IsMatch(txt, @"^(?:\(?\s*-?\d[\d.,]*\s*%?\s*\)?|Rp\s*[\d.,-]+|-)$", RegexOptions.IgnoreCase))
        {
            return "Right";
        }
        return "Left";
    }

    private static double EstimateRowHeightPt(List<CompiledCell> cells, List<double> colWidthsPt)
    {
        double maxH = 13.0;
        int col = 0;
        foreach (var cell in cells)
        {
            double spanW = 0.0;
            for (int k = 0; k < cell.ColSpan && col + k < colWidthsPt.Count; k++)
            {
                spanW += colWidthsPt[col + k];
            }
            col += cell.ColSpan;

            double innerW = Math.Max(12.0, spanW - cell.PadLeftPt - cell.PadRightPt);
            double charW = Math.Max(3.2, cell.FontSizePt * 0.50);
            int lines = 0;
            foreach (var seg in (cell.Text ?? string.Empty).Split('\n'))
            {
                if (string.IsNullOrWhiteSpace(seg))
                {
                    lines += 1;
                    continue;
                }
                lines += Math.Max(1, (int)Math.Ceiling((seg.Length * charW) / innerW));
            }
            double h = lines * Math.Max(cell.LineHeightPt, cell.FontSizePt * 1.25) + cell.PadTopPt + cell.PadBottomPt;
            if (h > maxH) maxH = h;
        }
        return Math.Round(maxH, 2);
    }

    private static TextSpan ShiftSpanX(TextSpan s, double dx) => new()
    {
        Text = s.Text,
        X0 = Math.Max(0.0, s.X0 + dx),
        Y0 = s.Y0,
        X1 = Math.Max(1.0, s.X1 + dx),
        Y1 = s.Y1,
        FontSize = s.FontSize,
        FontName = s.FontName,
        IsBold = s.IsBold,
        IsItalic = s.IsItalic,
        ColorHex = s.ColorHex
    };

    private static LineSegment ShiftLineX(LineSegment l, double dx) => new()
    {
        X0 = Math.Max(0.0, l.X0 + dx),
        Y0 = l.Y0,
        X1 = Math.Max(0.0, l.X1 + dx),
        Y1 = l.Y1
    };

    private static FillBox ShiftFillX(FillBox f, double dx) => new()
    {
        X0 = Math.Max(0.0, f.X0 + dx),
        Y0 = f.Y0,
        X1 = Math.Max(0.0, f.X1 + dx),
        Y1 = f.Y1,
        FillHex = f.FillHex,
        Luminance = f.Luminance
    };

    private static string FmtCmFromPt(double pt)
    {
        double cm = Math.Max(0.0, (pt / 72.0) * 2.54);
        return cm.ToString("0.0000", CultureInfo.InvariantCulture) + "cm";
    }

    private string NextName(string prefix) => $"{prefix}_{_nameCounter++}";
}
