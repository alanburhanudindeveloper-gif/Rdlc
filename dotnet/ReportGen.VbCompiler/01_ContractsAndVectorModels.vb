Option Strict On
Option Explicit On

Imports System
Imports System.Collections.Generic
Imports System.Text.Json.Serialization

Namespace ReportGen.VbCompiler.Contracts

    Public Enum GateStage
        Gate1Extraction = 1
        Gate2Segmentation = 2
        Gate3Solver = 3
        Gate4RdlcXsd = 4
        Gate5ValueFill = 5
        Gate6ParityRender = 6
    End Enum

    Public Enum SolverStrategyKind
        PlanarGridSolver = 0
        KeyValueSubGridFlattener = 1
        DualTrackStreamSolver = 2
        IndentationClauseSolver = 3
        HLineOperatorSolver = 4
        DensityTransitionSplitter = 5
        ParentNestedBannerGrid = 6
    End Enum

    Public Enum BorderRuleKind
        None = 0
        Grid = 1
        Box = 2
        HLine = 3
    End Enum

    Public NotInheritable Class RectBoxIr
        <JsonPropertyName("x0")> Public Property X0 As Double
        <JsonPropertyName("y0")> Public Property Y0 As Double
        <JsonPropertyName("x1")> Public Property X1 As Double
        <JsonPropertyName("y1")> Public Property Y1 As Double

        Public ReadOnly Property Width As Double
            Get
                Return Math.Max(0.0, X1 - X0)
            End Get
        End Property

        Public ReadOnly Property Height As Double
            Get
                Return Math.Max(0.0, Y1 - Y0)
            End Get
        End Property
    End Class

    Public NotInheritable Class TextSpanIr
        <JsonPropertyName("text")> Public Property Text As String = String.Empty
        <JsonPropertyName("x0")> Public Property X0 As Double
        <JsonPropertyName("y0")> Public Property Y0 As Double
        <JsonPropertyName("x1")> Public Property X1 As Double
        <JsonPropertyName("y1")> Public Property Y1 As Double
        <JsonPropertyName("fontSize")> Public Property FontSize As Double = 9.0
        <JsonPropertyName("fontName")> Public Property FontName As String = "Arial"
        <JsonPropertyName("isBold")> Public Property IsBold As Boolean
        <JsonPropertyName("isItalic")> Public Property IsItalic As Boolean
        <JsonPropertyName("colorHex")> Public Property ColorHex As String = "#0F172A"

        Public ReadOnly Property Width As Double
            Get
                Return Math.Max(0.0, X1 - X0)
            End Get
        End Property

        Public ReadOnly Property Height As Double
            Get
                Return Math.Max(0.0, Y1 - Y0)
            End Get
        End Property

        Public ReadOnly Property CenterX As Double
            Get
                Return (X0 + X1) / 2.0
            End Get
        End Property

        Public ReadOnly Property CenterY As Double
            Get
                Return (Y0 + Y1) / 2.0
            End Get
        End Property
    End Class

    Public NotInheritable Class LineSegmentIr
        <JsonPropertyName("x0")> Public Property X0 As Double
        <JsonPropertyName("y0")> Public Property Y0 As Double
        <JsonPropertyName("x1")> Public Property X1 As Double
        <JsonPropertyName("y1")> Public Property Y1 As Double

        Public ReadOnly Property Width As Double
            Get
                Return Math.Max(0.0, X1 - X0)
            End Get
        End Property

        Public ReadOnly Property Height As Double
            Get
                Return Math.Max(0.0, Y1 - Y0)
            End Get
        End Property
    End Class

    Public NotInheritable Class FillBoxIr
        <JsonPropertyName("x0")> Public Property X0 As Double
        <JsonPropertyName("y0")> Public Property Y0 As Double
        <JsonPropertyName("x1")> Public Property X1 As Double
        <JsonPropertyName("y1")> Public Property Y1 As Double
        <JsonPropertyName("fillHex")> Public Property FillHex As String = "#FFFFFF"
        <JsonPropertyName("luminance")> Public Property Luminance As Double = 1.0
        <JsonPropertyName("borderHex")> Public Property BorderHex As String = String.Empty

        Public ReadOnly Property Width As Double
            Get
                Return Math.Max(0.0, X1 - X0)
            End Get
        End Property

        Public ReadOnly Property Height As Double
            Get
                Return Math.Max(0.0, Y1 - Y0)
            End Get
        End Property
    End Class

    Public NotInheritable Class LayoutPageIr
        <JsonPropertyName("pageIndex")> Public Property PageIndex As Integer
        <JsonPropertyName("widthPt")> Public Property WidthPt As Double = 595.32
        <JsonPropertyName("heightPt")> Public Property HeightPt As Double = 841.92
        <JsonPropertyName("headerLogoBase64")> Public Property HeaderLogoBase64 As String = String.Empty
        <JsonPropertyName("headerLogoRect")> Public Property HeaderLogoRect As RectBoxIr
        <JsonPropertyName("headerSpans")> Public Property HeaderSpans As List(Of TextSpanIr) = New List(Of TextSpanIr)()
        <JsonPropertyName("footerSpans")> Public Property FooterSpans As List(Of TextSpanIr) = New List(Of TextSpanIr)()
        <JsonPropertyName("bodySpans")> Public Property BodySpans As List(Of TextSpanIr) = New List(Of TextSpanIr)()
        <JsonPropertyName("hLines")> Public Property HLines As List(Of LineSegmentIr) = New List(Of LineSegmentIr)()
        <JsonPropertyName("vLines")> Public Property VLines As List(Of LineSegmentIr) = New List(Of LineSegmentIr)()
        <JsonPropertyName("fillBanners")> Public Property FillBanners As List(Of FillBoxIr) = New List(Of FillBoxIr)()
        <JsonPropertyName("rowFills")> Public Property RowFills As List(Of FillBoxIr) = New List(Of FillBoxIr)()
    End Class

    Public NotInheritable Class LayoutIrDocument
        <JsonPropertyName("documentTemplate")> Public Property DocumentTemplate As String = "GenericFinancialDocument"
        <JsonPropertyName("pageCount")> Public Property PageCount As Integer
        <JsonPropertyName("pages")> Public Property Pages As List(Of LayoutPageIr) = New List(Of LayoutPageIr)()
    End Class

    Public NotInheritable Class CompiledCell
        Public Property Name As String = String.Empty
        Public Property ColSpan As Integer = 1
        Public Property Text As String = String.Empty
        Public Property IsExpression As Boolean
        Public Property FontFamily As String = "Arial"
        Public Property FontSizePt As Double = 8.5
        Public Property IsBold As Boolean
        Public Property IsItalic As Boolean
        Public Property TextColorHex As String = "#0F172A"
        Public Property BackgroundHex As String
        Public Property TextAlign As String = "Left"
        Public Property VerticalAlign As String = "Middle"
        Public Property PadTopPt As Double = 1.5
        Public Property PadBottomPt As Double = 1.5
        Public Property PadLeftPt As Double = 3.0
        Public Property PadRightPt As Double = 3.0
        Public Property LineHeightPt As Double = 11.0
        Public Property BorderTopStyle As String = "None"
        Public Property BorderBottomStyle As String = "None"
        Public Property BorderLeftStyle As String = "None"
        Public Property BorderRightStyle As String = "None"
        Public Property BorderColorHex As String = "#CBD5E1"
        Public Property BorderWidthPt As Double = 0.5
        Public Property SourceLineCount As Integer = 1
        Public Property SourceX0Pt As Double
        Public Property NestedTablix As CompiledTablix

        Public ReadOnly Property IsNestedTablix As Boolean
            Get
                Return NestedTablix IsNot Nothing
            End Get
        End Property
    End Class

    Public NotInheritable Class CompiledRow
        Public Property HeightPt As Double = 14.0
        Public Property IsHeaderRow As Boolean
        Public Property IsBoldTitleRow As Boolean
        Public Property IsSubTableRow As Boolean
        Public Property SourceY0Pt As Double
        Public Property SourceY1Pt As Double
        Public Property Cells As List(Of CompiledCell) = New List(Of CompiledCell)()
    End Class

    Public NotInheritable Class CompiledTablix
        Public Property Name As String = String.Empty
        Public Property SourcePageIndex As Integer
        Public Property Strategy As SolverStrategyKind
        Public Property BorderMode As BorderRuleKind
        Public Property IsNested As Boolean
        Public Property IsRightTrack As Boolean
        Public Property PageBreakStart As Boolean
        Public Property TopPt As Double
        Public Property LeftPt As Double
        Public Property WidthPt As Double
        Public Property HeightPt As Double
        Public Property ColumnWidthsPt As List(Of Double) = New List(Of Double)()
        Public Property Rows As List(Of CompiledRow) = New List(Of CompiledRow)()
    End Class

    Public NotInheritable Class GeometricContainerSnapshot
        Public Property ContainerKey As String = String.Empty
        Public Property Strategy As String = String.Empty
        Public Property TopPt As Double
        Public Property LeftPt As Double
        Public Property WidthPt As Double
        Public Property HeightPt As Double
        Public Property ColCount As Integer
        Public Property RowCount As Integer
        Public Property ColumnWidthsPt As List(Of Double) = New List(Of Double)()
    End Class

    Public NotInheritable Class VectorArtifactMetadata
        Public Property DocumentTemplate As String = String.Empty
        Public Property PageIndex As Integer
        Public Property GateStage As String = "GATE_4_RDLC_XSD"
        Public Property AppliedRules As List(Of String) = New List(Of String)()
        Public Property HasDualTrackStream As Boolean
        Public Property HasNestedTablix As Boolean
        Public Property HasStaircaseIndent As Boolean
        Public Property XsdValidationPassed As Boolean
        Public Property RenderedPageCount As Integer
        Public Property SourcePageCount As Integer
    End Class

    Public NotInheritable Class VectorArtifactRecord
        Public Property Id As String = String.Empty
        Public Property Metadata As VectorArtifactMetadata = New VectorArtifactMetadata()
        Public Property Embedding As List(Of Double) = New List(Of Double)()
        Public Property RawFeatures As List(Of Double) = New List(Of Double)()
        Public Property Containers As List(Of GeometricContainerSnapshot) = New List(Of GeometricContainerSnapshot)()
        Public Property Diagnostics As List(Of String) = New List(Of String)()
        Public Property CreatedAtIso As String = String.Empty
    End Class

    Public NotInheritable Class VectorSearchResult
        Public Property Artifact As VectorArtifactRecord = New VectorArtifactRecord()
        Public Property Similarity As Double
    End Class

    Public NotInheritable Class RegressionDiffReport
        Public Property BaselineId As String = String.Empty
        Public Property CandidateId As String = String.Empty
        Public Property PageParityDelta As Integer
        Public Property TablixCountDelta As Integer
        Public Property XsdRegressed As Boolean
        Public Property AddedRules As List(Of String) = New List(Of String)()
        Public Property RemovedRules As List(Of String) = New List(Of String)()
        Public Property EmbeddingCosineSimilarity As Double
        Public Property Notes As List(Of String) = New List(Of String)()
    End Class

    Public NotInheritable Class LogicalIllustrationRowInput
        Public Property PolicyYear As Integer
        Public Property InsuredAge As Integer
        Public Property AnnualPremium As Decimal
        Public Property TopUpPremium As Decimal
        Public Property AllocationRate As Decimal
        Public Property ProjectedSurrenderValue As Decimal
        Public Property ProjectedDeathBenefit As Decimal
        Public Property ShowZeroAsDash As Boolean = True
    End Class

    Public NotInheritable Class LogicalFillRuleInput
        Public Property CurrencyCode As String = "IDR"
        Public Property LocaleCode As String = "id-ID"
        Public Property IncludeRiderSection As Boolean
        Public Property IncludeTopUpSection As Boolean = True
        Public Property BaseSumAssured As Decimal
        Public Property BasePremium As Decimal
        Public Property MinimumAllowedPremium As Decimal = 1000000D
        Public Property HeaderParams As Dictionary(Of String, String) = New Dictionary(Of String, String)(StringComparer.OrdinalIgnoreCase)
        Public Property Rows As List(Of LogicalIllustrationRowInput) = New List(Of LogicalIllustrationRowInput)()
    End Class

    Public NotInheritable Class LogicalFillOutput
        Public Property DataSetName As String = "dsReport"
        Public Property FieldRows As List(Of Dictionary(Of String, Object)) = New List(Of Dictionary(Of String, Object))()
        Public Property ReportParameters As Dictionary(Of String, String) = New Dictionary(Of String, String)(StringComparer.OrdinalIgnoreCase)
        Public Property TotalPremium As Decimal
        Public Property TotalTopUp As Decimal
        Public Property NetInvestedPrincipal As Decimal
        Public Property AppliedFlags As List(Of String) = New List(Of String)()
    End Class

    Public NotInheritable Class PipelineState
        Public Property DocumentTemplate As String = String.Empty
        Public Property CurrentGate As GateStage = GateStage.Gate1Extraction
        Public Property SourceDocument As LayoutIrDocument = New LayoutIrDocument()
        Public Property CompiledTablixes As List(Of CompiledTablix) = New List(Of CompiledTablix)()
        Public Property AppliedRules As HashSet(Of String) = New HashSet(Of String)(StringComparer.Ordinal)
        Public Property RdlcXml As String = String.Empty
        Public Property XsdValidationPassed As Boolean
        Public Property ValidationErrors As List(Of String) = New List(Of String)()
        Public Property LogicalFillResult As LogicalFillOutput
        Public Property RenderedPageCount As Integer
        Public Property RenderedPdfPath As String = String.Empty
        Public Property TraceLog As List(Of String) = New List(Of String)()
        Public Property MarginLeftPt As Double = 21.26
        Public Property MarginRightPt As Double = 21.26
        Public Property MarginTopPt As Double = 21.26
        Public Property MarginBottomPt As Double = 21.26
        Public Property HeaderHeightPt As Double = 42.0
        Public Property FooterHeightPt As Double = 28.0
    End Class

End Namespace
