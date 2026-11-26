using System.Text.Json.Serialization;

namespace ReportGen.Compiler.Models;

public sealed class LayoutIrDocument
{
    [JsonPropertyName("pageCount")]
    public int PageCount { get; set; }

    [JsonPropertyName("pages")]
    public List<LayoutIrPage> Pages { get; set; } = new();
}

public sealed class LayoutIrPage
{
    [JsonPropertyName("pageIndex")]
    public int PageIndex { get; set; }

    [JsonPropertyName("widthPt")]
    public double WidthPt { get; set; } = 595.32;

    [JsonPropertyName("heightPt")]
    public double HeightPt { get; set; } = 841.92;

    [JsonPropertyName("headerLogoBase64")]
    public string? HeaderLogoBase64 { get; set; }

    [JsonPropertyName("headerLogoRect")]
    public RectBox? HeaderLogoRect { get; set; }

    [JsonPropertyName("headerSpans")]
    public List<TextSpan> HeaderSpans { get; set; } = new();

    [JsonPropertyName("footerSpans")]
    public List<TextSpan> FooterSpans { get; set; } = new();

    [JsonPropertyName("bodySpans")]
    public List<TextSpan> BodySpans { get; set; } = new();

    [JsonPropertyName("hLines")]
    public List<LineSegment> HLines { get; set; } = new();

    [JsonPropertyName("vLines")]
    public List<LineSegment> VLines { get; set; } = new();

    [JsonPropertyName("fillBanners")]
    public List<FillBox> FillBanners { get; set; } = new();

    [JsonPropertyName("rowFills")]
    public List<FillBox> RowFills { get; set; } = new();
}

public sealed class RectBox
{
    [JsonPropertyName("x0")]
    public double X0 { get; set; }

    [JsonPropertyName("y0")]
    public double Y0 { get; set; }

    [JsonPropertyName("x1")]
    public double X1 { get; set; }

    [JsonPropertyName("y1")]
    public double Y1 { get; set; }
}

public sealed class TextSpan
{
    [JsonPropertyName("text")]
    public string Text { get; set; } = string.Empty;

    [JsonPropertyName("x0")]
    public double X0 { get; set; }

    [JsonPropertyName("y0")]
    public double Y0 { get; set; }

    [JsonPropertyName("x1")]
    public double X1 { get; set; }

    [JsonPropertyName("y1")]
    public double Y1 { get; set; }

    [JsonPropertyName("fontSize")]
    public double FontSize { get; set; } = 9.0;

    [JsonPropertyName("fontName")]
    public string FontName { get; set; } = "Arial";

    [JsonPropertyName("isBold")]
    public bool IsBold { get; set; }

    [JsonPropertyName("isItalic")]
    public bool IsItalic { get; set; }

    [JsonPropertyName("colorHex")]
    public string ColorHex { get; set; } = "#0F172A";

    public double Width => Math.Max(1.0, X1 - X0);
    public double Height => Math.Max(1.0, Y1 - Y0);
    public double CenterX => (X0 + X1) / 2.0;
    public double CenterY => (Y0 + Y1) / 2.0;
}

public sealed class LineSegment
{
    [JsonPropertyName("x0")]
    public double X0 { get; set; }

    [JsonPropertyName("y0")]
    public double Y0 { get; set; }

    [JsonPropertyName("x1")]
    public double X1 { get; set; }

    [JsonPropertyName("y1")]
    public double Y1 { get; set; }

    public double Width => Math.Max(0.0, X1 - X0);
    public double Height => Math.Max(0.0, Y1 - Y0);
}

public sealed class FillBox
{
    [JsonPropertyName("x0")]
    public double X0 { get; set; }

    [JsonPropertyName("y0")]
    public double Y0 { get; set; }

    [JsonPropertyName("x1")]
    public double X1 { get; set; }

    [JsonPropertyName("y1")]
    public double Y1 { get; set; }

    [JsonPropertyName("fillHex")]
    public string FillHex { get; set; } = "#FFFFFF";

    [JsonPropertyName("luminance")]
    public double Luminance { get; set; } = 1.0;

    public double Width => Math.Max(0.0, X1 - X0);
    public double Height => Math.Max(0.0, Y1 - Y0);
}

public enum SolverStrategyKind
{
    PlanarGridSolver,
    KeyValueSubGridFlattener,
    DualTrackStreamSolver,
    IndentationClauseSolver,
    HLineOperatorSolver,
    DensityTransitionSplitter,
    ParentNestedBannerGrid
}

public enum BorderRuleKind
{
    None,   // [R-B-NONE]
    Grid,   // [R-B-GRID]
    Box,    // [R-B-BOX]
    HLine   // [R-B-HLINE]
}

public sealed class EdgeBorder
{
    public string Style { get; set; } = "None"; // "None" | "Solid"
    public string ColorHex { get; set; } = "#CBD5E1";
    public double WidthPt { get; set; } = 0.5;
}

public sealed class CellBorders
{
    public EdgeBorder Top { get; set; } = new();
    public EdgeBorder Bottom { get; set; } = new();
    public EdgeBorder Left { get; set; } = new();
    public EdgeBorder Right { get; set; } = new();
}

public sealed class CompiledCell
{
    public int ColSpan { get; set; } = 1;
    public bool IsNestedTablix => NestedTablix is not null;
    public CompiledTablix? NestedTablix { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Text { get; set; } = string.Empty;
    public string FontFamily { get; set; } = "Arial";
    public double FontSizePt { get; set; } = 8.5;
    public bool IsBold { get; set; }
    public bool IsItalic { get; set; }
    public string TextColorHex { get; set; } = "#0F172A";
    public string? BackgroundHex { get; set; }
    public string TextAlign { get; set; } = "Left";
    public string VerticalAlign { get; set; } = "Middle";
    public double PadTopPt { get; set; } = 1.5;
    public double PadBottomPt { get; set; } = 1.5;
    public double PadLeftPt { get; set; } = 3.0;
    public double PadRightPt { get; set; } = 3.0;
    public double LineHeightPt { get; set; } = 11.5;
    public CellBorders Borders { get; set; } = new();
    public BorderRuleKind AppliedBorderRule { get; set; } = BorderRuleKind.None;
    public int SourceLineCount { get; set; } = 1;
    public double SourceX0Pt { get; set; }
}

public sealed class CompiledRow
{
    public double HeightPt { get; set; } = 14.0;
    public bool IsHeaderRow { get; set; }
    public bool IsBoldTitleRow { get; set; }
    public double SourceY0Pt { get; set; }
    public double SourceY1Pt { get; set; }
    public List<CompiledCell> Cells { get; set; } = new();
}

public sealed class CompiledTablix
{
    public string Name { get; set; } = string.Empty;
    public int SourcePageIndex { get; set; }
    public SolverStrategyKind Strategy { get; set; }
    public BorderRuleKind BorderMode { get; set; } = BorderRuleKind.None;
    public bool PageBreakBefore { get; set; }
    public bool IsNested { get; set; }
    public bool IsRightTrack { get; set; }
    public double TopPt { get; set; }
    public double LeftPt { get; set; }
    public double WidthPt { get; set; }
    public double HeightPt { get; set; }
    public List<double> ColumnWidthsPt { get; set; } = new();
    public List<CompiledRow> Rows { get; set; } = new();
}

public sealed class RdlcBuildResult
{
    public string RdlcXml { get; set; } = string.Empty;
    public List<CompiledTablix> Tablixes { get; set; } = new();
    public List<string> ValidationErrors { get; set; } = new();
    public int SourcePageCount { get; set; }
    public bool PageParitySatisfied { get; set; }
    public Dictionary<int, double> PageCompiledHeightsPt { get; set; } = new();
}
