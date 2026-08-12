Attribute VB_Name = "RefreshIndustryScope"
Option Explicit

Public Sub RefreshIndustryScope()
    Application.ScreenUpdating = False
    Application.StatusBar = "Refreshing IndustryScope..."
    ThisWorkbook.RefreshAll
    Application.CalculateUntilAsyncQueriesDone
    Application.CalculateFull
    ApplyIndustryScopeFormatting
    Application.StatusBar = False
    Application.ScreenUpdating = True
End Sub

Private Sub ApplyIndustryScopeFormatting()
    Dim ws As Worksheet
    For Each ws In ThisWorkbook.Worksheets
        ws.Rows(1).Font.Bold = True
        ws.Rows(1).Interior.Color = RGB(29, 107, 77)
        ws.Rows(1).Font.Color = RGB(255, 255, 255)
        ws.Rows(1).AutoFilter
        ws.Columns.AutoFit
        ws.Activate
        ActiveWindow.FreezePanes = False
        ws.Range("A2").Select
        ActiveWindow.FreezePanes = True
    Next ws
    ThisWorkbook.Worksheets("Summary").Activate
    ThisWorkbook.Worksheets("Summary").Range("A1").Select
End Sub

