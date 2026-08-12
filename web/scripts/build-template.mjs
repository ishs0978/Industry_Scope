import ExcelJS from "exceljs";
import path from "node:path";

const workbook = new ExcelJS.Workbook();
workbook.creator = "IndustryScope";
workbook.title = "IndustryScope Power Query Model";
const sheetNames = ["Summary", "Price History", "Returns", "Holdings", "Overlap", "Comps", "Private Capital", "Macro", "Events", "Headlines"];
for (const name of sheetNames) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  sheet.getRow(1).height = 24;
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D6B4D" } };
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
}

const summary = workbook.getWorksheet("Summary");
summary.getCell("A1").value = "IndustryScope Model";
summary.getCell("A3").value = "Industry slug";
summary.getCell("B3").value = "energy";
summary.getCell("A4").value = "API base URL";
summary.getCell("B4").value = "https://YOUR-VERCEL-DOMAIN";
summary.getCell("A6").value = "Refresh";
summary.getCell("B6").value = "Import excel/vba/RefreshIndustryScope.bas, assign RefreshIndustryScope to a button, then save as .xlsm.";
summary.getCell("A7").value = "Power Query";
summary.getCell("B7").value = "Create a blank query with excel/power-query/IndustryScope.pq, then create table queries from its record fields.";
summary.getCell("A9").value = "Color convention";
summary.getCell("B9").value = "Blue input · green same-workbook formula · black source value";
summary.getCell("B3").font = { color: { argb: "FF0000FF" } };
summary.getCell("B4").font = { color: { argb: "FF0000FF" } };
summary.getCell("B3").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
summary.getCell("B4").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
summary.columns = [{ width: 22 }, { width: 95 }];
summary.getColumn(2).alignment = { wrapText: true, vertical: "top" };
workbook.definedNames.add("'Summary'!$B$3", "IndustrySlug");
workbook.definedNames.add("'Summary'!$B$4", "ApiBaseUrl");

const headers = {
  "Price History": ["Date", "Ticker", "Adjusted Close", "Close", "Volume"],
  Returns: ["Ticker", "Cumulative Return", "Annualized Volatility", "Correlation to SPY"],
  Holdings: ["Fund", "As of", "Ticker", "Name", "Weight", "Sub-sector"],
  Overlap: ["Fund A", "Fund B", "Overlap"],
  Comps: ["Ticker", "Fiscal Period", "Metric", "Value", "Filed Date"],
  "Private Capital": ["Filed Date", "Issuer", "Offering Amount", "Amount Sold", "State"],
  Macro: ["Series ID", "Label", "Date", "Value", "Release Date", "Source"],
  Events: ["Start", "End", "Title", "Impact", "Blurb", "Source URL"],
  Headlines: ["Published", "Source", "Section", "Headline", "Abstract", "URL"],
};
for (const [name, values] of Object.entries(headers)) {
  const sheet = workbook.getWorksheet(name);
  sheet.getRow(1).values = values;
  sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(values.length).letter}1` };
  values.forEach((header, index) => { sheet.getColumn(index + 1).width = Math.max(14, Math.min(36, header.length + 6)); });
}

const output = path.resolve(process.cwd(), "..", "excel", "IndustryScope_Model.xlsx");
await workbook.xlsx.writeFile(output);
console.log(output);

