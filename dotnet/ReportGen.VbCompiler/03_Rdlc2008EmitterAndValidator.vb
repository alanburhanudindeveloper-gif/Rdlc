Option Strict On
Option Explicit On

Imports System
Imports System.Collections.Generic
Imports System.Globalization
Imports System.IO
Imports System.Linq
Imports System.Xml
Imports System.Xml.Linq
Imports System.Xml.Schema
Imports ReportGen.VbCompiler.Contracts

Namespace ReportGen.VbCompiler.Emitter

    ''' <summary>
    ''' Gate 4: Strict RDLC 2008 XML Emitter & Validator.
    ''' Enforces 2008/01/reportdefinition namespace, DummyDataSource/dsReport,
    ''' CanGrow=true, CanShrink=false, and forbids RowSpan, LeftIndent, Visibility,
    ''' ReportSections, ReportParameters, and ReportParametersLayout.
    ''' </summary>
    Public NotInheritable Class Rdlc2008EmitterAndValidator
        Private Shared ReadOnly RdlNs As XNamespace = "http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition"
        Private Shared ReadOnly RdNs As XNamespace = "http://schemas.microsoft.com/SQLServer/reporting/reportdesigner"

        Private Shared ReadOnly ForbiddenTags As String() = {
            "RowSpan", "Visibility", "ReportSections", "ReportSection",
            "ReportParameters", "ReportParametersLayout", "LeftIndent", "AutoRefresh"
        }

        Public Function EmitAndValidate(ByVal state As PipelineState) As String
            If state Is Nothing Then Throw New ArgumentNullException(NameOf(state))
            state.CurrentGate = GateStage.Gate4RdlcXsd

            Dim doc As XDocument = BuildDocument(state)
            Dim xmlString As String
            Using sw As New StringWriter()
                Dim settings As New XmlWriterSettings With {
                    .Indent = True,
                    .OmitXmlDeclaration = False
                }
                Using xw As XmlWriter = XmlWriter.Create(sw, settings)
                    doc.Save(xw)
                End Using
                xmlString = sw.ToString()
            End Using

            state.RdlcXml = xmlString
            Dim errors = ValidateStrict2008(xmlString)
            state.ValidationErrors = errors
            state.XsdValidationPassed = (errors.Count = 0)
            state.TraceLog.Add($"Gate4: Emitted RDLC 2008 XML ({xmlString.Length} chars), ValidationErrors={errors.Count}.")
            Return xmlString
        End Function

        Public Function BuildDocument(ByVal state As PipelineState) As XDocument
            Dim firstPage = If(state.SourceDocument.Pages.Count > 0, state.SourceDocument.Pages(0), New LayoutPageIr())
            Dim pageW As Double = firstPage.WidthPt
            Dim pageH As Double = firstPage.HeightPt
            Dim bodyW As Double = Math.Max(144.0, pageW - state.MarginLeftPt - state.MarginRightPt)
            Dim bodyH As Double = Math.Max(144.0, If(state.CompiledTablixes.Count > 0, state.CompiledTablixes.Max(Function(t) t.TopPt + t.HeightPt) + 6.0, 72.0))

            Dim reportItems As New XElement(RdlNs + "ReportItems")
            For Each tbl In state.CompiledTablixes
                reportItems.Add(BuildTablixElement(tbl))
            Next

            Dim fieldElements = BuildDatasetFieldElements(state)

            Dim root As New XElement(RdlNs + "Report",
                New XAttribute(XNamespace.Xmlns + "rd", RdNs.NamespaceName),
                New XElement(RdlNs + "DataSources",
                    New XElement(RdlNs + "DataSource",
                        New XAttribute("Name", "DummyDataSource"),
                        New XElement(RdlNs + "ConnectionProperties",
                            New XElement(RdlNs + "DataProvider", "System.Data.DataSet"),
                            New XElement(RdlNs + "ConnectString", "/* Local Connection */")
                        )
                    )
                ),
                New XElement(RdlNs + "DataSets",
                    New XElement(RdlNs + "DataSet",
                        New XAttribute("Name", "dsReport"),
                        New XElement(RdlNs + "Query",
                            New XElement(RdlNs + "DataSourceName", "DummyDataSource"),
                            New XElement(RdlNs + "CommandText", "/* Local Query */")
                        ),
                        New XElement(RdlNs + "Fields", fieldElements)
                    )
                ),
                New XElement(RdlNs + "Body",
                    reportItems,
                    New XElement(RdlNs + "Height", FmtCmFromPt(bodyH)),
                    New XElement(RdlNs + "Style")
                ),
                New XElement(RdlNs + "Width", FmtCmFromPt(bodyW)),
                New XElement(RdlNs + "Page",
                    New XElement(RdlNs + "PageHeight", FmtCmFromPt(pageH)),
                    New XElement(RdlNs + "PageWidth", FmtCmFromPt(pageW)),
                    New XElement(RdlNs + "LeftMargin", FmtCmFromPt(state.MarginLeftPt)),
                    New XElement(RdlNs + "RightMargin", FmtCmFromPt(state.MarginRightPt)),
                    New XElement(RdlNs + "TopMargin", FmtCmFromPt(state.MarginTopPt)),
                    New XElement(RdlNs + "BottomMargin", FmtCmFromPt(state.MarginBottomPt)),
                    New XElement(RdlNs + "Style")
                )
            )

            Return New XDocument(New XDeclaration("1.0", "utf-8", Nothing), root)
        End Function

        Private Shared Function BuildDatasetFieldElements(ByVal state As PipelineState) As IEnumerable(Of XElement)
            Dim fieldNames As New HashSet(Of String)(StringComparer.OrdinalIgnoreCase) From {
                "PolicyYear", "InsuredAge", "AnnualPremiumDisplay", "TopUpPremiumDisplay",
                "AllocationRateDisplay", "SurrenderValueDisplay", "DeathBenefitDisplay",
                "TotalPremiumDisplay", "DocumentTitle"
            }
            If state.LogicalFillResult IsNot Nothing AndAlso state.LogicalFillResult.FieldRows.Count > 0 Then
                For Each k In state.LogicalFillResult.FieldRows(0).Keys
                    fieldNames.Add(k)
                Next
            End If
            Return fieldNames.Select(Function(fn) New XElement(RdlNs + "Field",
                New XAttribute("Name", fn),
                New XElement(RdlNs + "DataField", fn)))
        End Function

        Private Function BuildTablixElement(ByVal tbl As CompiledTablix) As XElement
            Dim tablixColumns As New XElement(RdlNs + "TablixColumns")
            Dim colMembers As New XElement(RdlNs + "TablixMembers")
            For Each colW In tbl.ColumnWidthsPt
                tablixColumns.Add(New XElement(RdlNs + "TablixColumn", New XElement(RdlNs + "Width", FmtCmFromPt(Math.Max(8.0, colW)))))
                colMembers.Add(New XElement(RdlNs + "TablixMember"))
            Next

            Dim tablixRows As New XElement(RdlNs + "TablixRows")
            Dim rowMembers As New XElement(RdlNs + "TablixMembers")

            For Each row In tbl.Rows
                Dim cellsEl As New XElement(RdlNs + "TablixCells")
                Dim totalLogicalCols As Integer = 0

                For Each cell In row.Cells
                    totalLogicalCols += cell.ColSpan
                    Dim cellContents As XElement
                    If cell.IsNestedTablix AndAlso cell.NestedTablix IsNot Nothing Then
                        cellContents = New XElement(RdlNs + "CellContents", BuildTablixElement(cell.NestedTablix))
                    Else
                        cellContents = New XElement(RdlNs + "CellContents", BuildTextboxElement(cell))
                    End If
                    If cell.ColSpan > 1 Then
                        cellContents.Add(New XElement(RdlNs + "ColSpan", cell.ColSpan))
                    End If
                    cellsEl.Add(New XElement(RdlNs + "TablixCell", cellContents))

                    ' RDLC XML requires 1 <TablixCell/> placeholder per covered spanned column after the lead cell
                    For m As Integer = 1 To cell.ColSpan - 1
                        cellsEl.Add(New XElement(RdlNs + "TablixCell"))
                    Next
                Next

                ' Pad missing trailing columns safely if needed
                While totalLogicalCols < tbl.ColumnWidthsPt.Count
                    totalLogicalCols += 1
                    cellsEl.Add(New XElement(RdlNs + "TablixCell"))
                End While

                tablixRows.Add(New XElement(RdlNs + "TablixRow",
                    New XElement(RdlNs + "Height", FmtCmFromPt(Math.Max(10.0, row.HeightPt))),
                    cellsEl))
                rowMembers.Add(New XElement(RdlNs + "TablixMember"))
            Next

            Dim tablixEl As New XElement(RdlNs + "Tablix",
                New XAttribute("Name", tbl.Name),
                New XElement(RdlNs + "TablixBody",
                    tablixColumns,
                    tablixRows),
                New XElement(RdlNs + "TablixColumnHierarchy", colMembers),
                New XElement(RdlNs + "TablixRowHierarchy", rowMembers),
                New XElement(RdlNs + "DataSetName", "dsReport")
            )

            If Not tbl.IsNested Then
                tablixEl.Add(
                    New XElement(RdlNs + "Top", FmtCmFromPt(tbl.TopPt)),
                    New XElement(RdlNs + "Left", FmtCmFromPt(tbl.LeftPt))
                )
            End If

            tablixEl.Add(
                New XElement(RdlNs + "Height", FmtCmFromPt(tbl.HeightPt)),
                New XElement(RdlNs + "Width", FmtCmFromPt(tbl.WidthPt)),
                New XElement(RdlNs + "Style")
            )

            ' [R-PB]: PageBreak ONLY on outer top-most Tablix for pages > 0
            If tbl.PageBreakStart AndAlso Not tbl.IsNested AndAlso Not tbl.IsRightTrack Then
                tablixEl.Add(New XElement(RdlNs + "PageBreak",
                    New XElement(RdlNs + "BreakLocation", "Start")))
            End If

            Return tablixEl
        End Function

        Private Shared Function BuildTextboxElement(ByVal cell As CompiledCell) As XElement
            Dim styleEl As New XElement(RdlNs + "Style",
                New XElement(RdlNs + "Border", New XElement(RdlNs + "Style", "None"))
            )
            AddBorderEdgeElements(styleEl, cell)
            styleEl.Add(
                New XElement(RdlNs + "PaddingLeft", $"{cell.PadLeftPt.ToString("0.##", CultureInfo.InvariantCulture)}pt"),
                New XElement(RdlNs + "PaddingRight", $"{cell.PadRightPt.ToString("0.##", CultureInfo.InvariantCulture)}pt"),
                New XElement(RdlNs + "PaddingTop", $"{cell.PadTopPt.ToString("0.##", CultureInfo.InvariantCulture)}pt"),
                New XElement(RdlNs + "PaddingBottom", $"{cell.PadBottomPt.ToString("0.##", CultureInfo.InvariantCulture)}pt"),
                New XElement(RdlNs + "VerticalAlign", cell.VerticalAlign)
            )
            If Not String.IsNullOrWhiteSpace(cell.BackgroundHex) Then
                styleEl.Add(New XElement(RdlNs + "BackgroundColor", cell.BackgroundHex))
            End If

            Dim runStyle As New XElement(RdlNs + "Style",
                New XElement(RdlNs + "FontFamily", cell.FontFamily),
                New XElement(RdlNs + "FontSize", $"{cell.FontSizePt.ToString("0.##", CultureInfo.InvariantCulture)}pt"),
                New XElement(RdlNs + "FontWeight", If(cell.IsBold, "Bold", "Normal")),
                New XElement(RdlNs + "FontStyle", If(cell.IsItalic, "Italic", "Normal")),
                New XElement(RdlNs + "Color", cell.TextColorHex)
            )

            Return New XElement(RdlNs + "Textbox",
                New XAttribute("Name", cell.Name),
                New XElement(RdlNs + "CanGrow", "true"),
                New XElement(RdlNs + "CanShrink", "false"),
                New XElement(RdlNs + "KeepTogether", "true"),
                New XElement(RdlNs + "Paragraphs",
                    New XElement(RdlNs + "Paragraph",
                        New XElement(RdlNs + "TextRuns",
                            New XElement(RdlNs + "TextRun",
                                New XElement(RdlNs + "Value", cell.Text),
                                runStyle
                            )
                        ),
                        New XElement(RdlNs + "Style",
                            New XElement(RdlNs + "TextAlign", cell.TextAlign)
                        )
                    )
                ),
                styleEl
            )
        End Function

        Private Shared Sub AddBorderEdgeElements(ByVal styleEl As XElement, ByVal cell As CompiledCell)
            Dim wStr As String = $"{Math.Max(0.5, cell.BorderWidthPt).ToString("0.##", CultureInfo.InvariantCulture)}pt"
            If cell.BorderTopStyle = "Solid" Then
                styleEl.Add(New XElement(RdlNs + "TopBorder", New XElement(RdlNs + "Color", cell.BorderColorHex), New XElement(RdlNs + "Style", "Solid"), New XElement(RdlNs + "Width", wStr)))
            End If
            If cell.BorderBottomStyle = "Solid" Then
                styleEl.Add(New XElement(RdlNs + "BottomBorder", New XElement(RdlNs + "Color", cell.BorderColorHex), New XElement(RdlNs + "Style", "Solid"), New XElement(RdlNs + "Width", wStr)))
            End If
            If cell.BorderLeftStyle = "Solid" Then
                styleEl.Add(New XElement(RdlNs + "LeftBorder", New XElement(RdlNs + "Color", cell.BorderColorHex), New XElement(RdlNs + "Style", "Solid"), New XElement(RdlNs + "Width", wStr)))
            End If
            If cell.BorderRightStyle = "Solid" Then
                styleEl.Add(New XElement(RdlNs + "RightBorder", New XElement(RdlNs + "Color", cell.BorderColorHex), New XElement(RdlNs + "Style", "Solid"), New XElement(RdlNs + "Width", wStr)))
            End If
        End Sub

        ''' <summary>
        ''' Validates strict RDLC 2008 compliance: XML well-formedness, namespace, forbidden elements,
        ''' TablixMember == TablixColumn/TablixRow parity, DataSet presence, and CanGrow/CanShrink.
        ''' </summary>
        Public Shared Function ValidateStrict2008(ByVal rdlcXml As String, Optional ByVal xsdFilePath As String = Nothing) As List(Of String)
            Dim errors As New List(Of String)()
            If String.IsNullOrWhiteSpace(rdlcXml) Then
                errors.Add("RDLC XML is empty.")
                Return errors
            End If

            Dim xdoc As XDocument
            Try
                xdoc = XDocument.Parse(rdlcXml)
            Catch ex As Exception
                errors.Add($"XML Parse Error: {ex.Message}")
                Return errors
            End Try

            Dim root = xdoc.Root
            If root Is Nothing OrElse root.Name <> (RdlNs + "Report") Then
                errors.Add("Root element must be <Report> in namespace http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition.")
                Return errors
            End If

            For Each tag In ForbiddenTags
                If xdoc.Descendants().Any(Function(e) String.Equals(e.Name.LocalName, tag, StringComparison.OrdinalIgnoreCase)) Then
                    errors.Add($"Forbidden RDLC 2008 element <{tag}> found.")
                End If
            Next

            If root.Element(RdlNs + "DataSources")?.Element(RdlNs + "DataSource") Is Nothing Then
                errors.Add("Missing <DataSources>/<DataSource>.")
            End If
            If root.Element(RdlNs + "DataSets")?.Element(RdlNs + "DataSet") Is Nothing Then
                errors.Add("Missing <DataSets>/<DataSet>.")
            End If

            If Not String.IsNullOrWhiteSpace(xsdFilePath) AndAlso File.Exists(xsdFilePath) Then
                Dim schemas As New XmlSchemaSet()
                schemas.Add(RdlNs.NamespaceName, xsdFilePath)
                xdoc.Validate(schemas, Sub(sender, e) errors.Add($"XSD {e.Severity}: {e.Message}"))
            End If

            For Each tbl In xdoc.Descendants(RdlNs + "Tablix")
                Dim tName = CStr(tbl.Attribute("Name"))
                Dim cols = tbl.Element(RdlNs + "TablixBody")?.Element(RdlNs + "TablixColumns")?.Elements(RdlNs + "TablixColumn").ToList()
                Dim rows = tbl.Element(RdlNs + "TablixBody")?.Element(RdlNs + "TablixRows")?.Elements(RdlNs + "TablixRow").ToList()
                Dim colMem = tbl.Element(RdlNs + "TablixColumnHierarchy")?.Element(RdlNs + "TablixMembers")?.Elements(RdlNs + "TablixMember").ToList()
                Dim rowMem = tbl.Element(RdlNs + "TablixRowHierarchy")?.Element(RdlNs + "TablixMembers")?.Elements(RdlNs + "TablixMember").ToList()

                If cols Is Nothing OrElse colMem Is Nothing OrElse cols.Count <> colMem.Count Then
                    errors.Add($"Tablix '{tName}' column hierarchy count mismatch.")
                End If
                If rows Is Nothing OrElse rowMem Is Nothing OrElse rows.Count <> rowMem.Count Then
                    errors.Add($"Tablix '{tName}' row hierarchy count mismatch.")
                End If
                If rows IsNot Nothing AndAlso cols IsNot Nothing Then
                    For rIdx As Integer = 0 To rows.Count - 1
                        Dim cells = rows(rIdx).Element(RdlNs + "TablixCells")?.Elements(RdlNs + "TablixCell").ToList()
                        If cells Is Nothing OrElse cells.Count <> cols.Count Then
                            errors.Add($"Tablix '{tName}' row {rIdx} cell count {If(cells?.Count, 0)} != {cols.Count}.")
                        End If
                    Next
                End If
            Next

            For Each tb In xdoc.Descendants(RdlNs + "Textbox")
                Dim cg = tb.Element(RdlNs + "CanGrow")?.Value
                Dim cs = tb.Element(RdlNs + "CanShrink")?.Value
                If cg <> "true" OrElse cs <> "false" Then
                    errors.Add($"Textbox '{CStr(tb.Attribute("Name"))}' must enforce CanGrow=true and CanShrink=false.")
                End If
            Next

            Return errors
        End Function

        Private Shared Function FmtCmFromPt(ByVal pt As Double) As String
            Dim cm As Double = Math.Max(0.0, (pt / 72.0) * 2.54)
            Return cm.ToString("0.0000", CultureInfo.InvariantCulture) & "cm"
        End Function
    End Class

End Namespace
