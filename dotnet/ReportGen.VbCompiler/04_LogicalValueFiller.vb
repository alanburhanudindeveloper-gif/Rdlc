Option Strict On
Option Explicit On

Imports System
Imports System.Collections.Generic
Imports System.Data
Imports System.Globalization
Imports ReportGen.VbCompiler.Contracts

Namespace ReportGen.VbCompiler.ValueFill

    ''' <summary>
    ''' Gate 5: Deterministic Logical Value-Filler ([R-VBFILL-01]).
    ''' Keeps RDLC Textbox expressions strictly simple (=Fields!Name.Value / =Parameters!Name.Value).
    ''' Performs all Decimal financial arithmetic, currency/percentage formatting,
    ''' zero-to-dash coercion, and section/row visibility booleans cleanly in VB.NET.
    ''' Zero hardcoded product names or sample policy numbers.
    ''' </summary>
    Public NotInheritable Class LogicalValueFiller

        Public Function FillLogicalValues(
            ByVal state As PipelineState,
            ByVal input As LogicalFillRuleInput) As LogicalFillOutput

            If state Is Nothing Then Throw New ArgumentNullException(NameOf(state))
            If input Is Nothing Then Throw New ArgumentNullException(NameOf(input))

            state.CurrentGate = GateStage.Gate5ValueFill
            state.AppliedRules.Add("[R-VBFILL-01]")

            Dim culture As CultureInfo = ResolveCulture(input.LocaleCode)
            Dim result As New LogicalFillOutput With {
                .DataSetName = "dsReport"
            }

            ' 1. Header / Contract Parameters (bound via =Parameters!<Name>.Value in RDLC)
            For Each kv In input.HeaderParams
                result.ReportParameters(kv.Key) = If(kv.Value, String.Empty).Trim()
            Next
            result.ReportParameters("CurrencyCode") = input.CurrencyCode
            result.ReportParameters("FormattedBaseSumAssured") = FormatCurrencyOrDash(input.BaseSumAssured, input.CurrencyCode, culture, zeroAsDash:=False)
            result.ReportParameters("FormattedBasePremium") = FormatCurrencyOrDash(input.BasePremium, input.CurrencyCode, culture, zeroAsDash:=False)
            result.ReportParameters("ShowRiderSection") = If(input.IncludeRiderSection, "true", "false")
            result.ReportParameters("ShowTopUpSection") = If(input.IncludeTopUpSection, "true", "false")
            result.ReportParameters("MeetsMinimumPremium") = If(input.BasePremium >= input.MinimumAllowedPremium, "true", "false")

            If input.IncludeRiderSection Then result.AppliedFlags.Add("RIDER_SECTION_ENABLED")
            If input.IncludeTopUpSection Then result.AppliedFlags.Add("TOPUP_SECTION_ENABLED")

            ' 2. Projection / Schedule Rows with exact Decimal arithmetic
            Dim runningTotalPremium As Decimal = 0D
            Dim runningTotalTopUp As Decimal = 0D
            Dim runningNetPrincipal As Decimal = 0D

            For Each row In input.Rows
                Dim effectiveTopUp As Decimal = If(input.IncludeTopUpSection, row.TopUpPremium, 0D)
                Dim totalRowPremium As Decimal = row.AnnualPremium + effectiveTopUp
                Dim allocFactor As Decimal = Math.Clamp(row.AllocationRate, 0D, 1D)
                Dim allocatedValue As Decimal = Decimal.Round(totalRowPremium * allocFactor, 2, MidpointRounding.AwayFromZero)

                runningTotalPremium += row.AnnualPremium
                runningTotalTopUp += effectiveTopUp
                runningNetPrincipal += allocatedValue

                Dim rowDict As New Dictionary(Of String, Object)(StringComparer.OrdinalIgnoreCase) From {
                    {"PolicyYear", row.PolicyYear.ToString(CultureInfo.InvariantCulture)},
                    {"InsuredAge", row.InsuredAge.ToString(CultureInfo.InvariantCulture)},
                    {"AnnualPremiumRaw", row.AnnualPremium},
                    {"AnnualPremiumDisplay", FormatCurrencyOrDash(row.AnnualPremium, input.CurrencyCode, culture, row.ShowZeroAsDash)},
                    {"TopUpPremiumRaw", effectiveTopUp},
                    {"TopUpPremiumDisplay", FormatCurrencyOrDash(effectiveTopUp, input.CurrencyCode, culture, row.ShowZeroAsDash)},
                    {"TotalPremiumRaw", totalRowPremium},
                    {"TotalPremiumDisplay", FormatCurrencyOrDash(totalRowPremium, input.CurrencyCode, culture, row.ShowZeroAsDash)},
                    {"AllocationRateDisplay", FormatPercentOrDash(allocFactor, row.ShowZeroAsDash)},
                    {"SurrenderValueDisplay", FormatCurrencyOrDash(row.ProjectedSurrenderValue, input.CurrencyCode, culture, row.ShowZeroAsDash)},
                    {"DeathBenefitDisplay", FormatCurrencyOrDash(row.ProjectedDeathBenefit, input.CurrencyCode, culture, row.ShowZeroAsDash)},
                    {"RowHasTopUp", effectiveTopUp > 0D}
                }
                result.FieldRows.Add(rowDict)
            Next

            result.TotalPremium = runningTotalPremium
            result.TotalTopUp = runningTotalTopUp
            result.NetInvestedPrincipal = runningNetPrincipal
            result.ReportParameters("TotalPremiumSummary") = FormatCurrencyOrDash(runningTotalPremium, input.CurrencyCode, culture, zeroAsDash:=False)
            result.ReportParameters("TotalTopUpSummary") = FormatCurrencyOrDash(runningTotalTopUp, input.CurrencyCode, culture, zeroAsDash:=True)
            result.ReportParameters("NetInvestedSummary") = FormatCurrencyOrDash(runningNetPrincipal, input.CurrencyCode, culture, zeroAsDash:=False)

            state.LogicalFillResult = result
            state.TraceLog.Add($"Gate5: Filled {result.FieldRows.Count} dataset rows & {result.ReportParameters.Count} parameters deterministically.")
            Return result
        End Function

        Public Shared Function ToReportDataTable(ByVal output As LogicalFillOutput) As DataTable
            If output Is Nothing Then Throw New ArgumentNullException(NameOf(output))
            Dim dt As New DataTable(output.DataSetName)
            If output.FieldRows.Count = 0 Then
                dt.Columns.Add("DocumentTitle", GetType(String))
                Dim emptyRow = dt.NewRow()
                emptyRow("DocumentTitle") = String.Empty
                dt.Rows.Add(emptyRow)
                Return dt
            End If

            For Each kv In output.FieldRows(0)
                If TypeOf kv.Value Is Decimal Then
                    dt.Columns.Add(kv.Key, GetType(Decimal))
                ElseIf TypeOf kv.Value Is Boolean Then
                    dt.Columns.Add(kv.Key, GetType(Boolean))
                Else
                    dt.Columns.Add(kv.Key, GetType(String))
                End If
            Next

            For Each rDict In output.FieldRows
                Dim dr = dt.NewRow()
                For Each kv In rDict
                    dr(kv.Key) = If(kv.Value, DBNull.Value)
                Next
                dt.Rows.Add(dr)
            Next
            Return dt
        End Function

        Private Shared Function FormatCurrencyOrDash(
            ByVal amount As Decimal,
            ByVal currencyCode As String,
            ByVal culture As CultureInfo,
            ByVal zeroAsDash As Boolean) As String

            If zeroAsDash AndAlso amount = 0D Then Return "-"
            Dim rounded As Decimal = Decimal.Round(amount, 0, MidpointRounding.AwayFromZero)
            Dim formattedNum As String = rounded.ToString("#,##0", culture)
            Dim prefix As String = If(String.Equals(currencyCode, "IDR", StringComparison.OrdinalIgnoreCase), "Rp ", $"{currencyCode} ")
            Return prefix & formattedNum
        End Function

        Private Shared Function FormatPercentOrDash(ByVal rate As Decimal, ByVal zeroAsDash As Boolean) As String
            If zeroAsDash AndAlso rate = 0D Then Return "-"
            Return $"{Decimal.Round(rate * 100D, 2, MidpointRounding.AwayFromZero).ToString("0.##", CultureInfo.InvariantCulture)}%"
        End Function

        Private Shared Function ResolveCulture(ByVal localeCode As String) As CultureInfo
            Try
                If Not String.IsNullOrWhiteSpace(localeCode) Then
                    Return CultureInfo.GetCultureInfo(localeCode)
                End If
            Catch
            End Try
            Return CultureInfo.InvariantCulture
        End Function
    End Class

End Namespace
