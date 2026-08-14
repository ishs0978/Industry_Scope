import ExcelJS from "exceljs";
import JSZip from "jszip";
import { compsRows } from "./comps";
import { exportableHoldings } from "./holdings";
import { holdingsOverlap } from "./metrics";
import type { IndustryPayload } from "./types";

/**
 * Every other date in this file is built as `${d}T00:00:00Z`. Headlines were
 * parsed with a bare `new Date(value)`, which is timezone-dependent and drifted
 * a day. Normalises both shapes to UTC.
 */
function utcDate(value: string): Date {
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(`${text}T00:00:00Z`);
  const normalized = text.replace(" ", "T");
  return new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`);
}

const green = "1D6B4D";
const light = "E8ECE5";
const ink = "17221D";

function columnLetter(index: number): string {
  let value = index;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

async function injectNativeChart(source: ArrayBuffer, tickers: string[], rows: number, sheetNumber: number): Promise<ArrayBuffer> {
  if (rows < 2) return source;
  const zip = await JSZip.loadAsync(source);
  const sheetPath = `xl/worksheets/sheet${sheetNumber}.xml`;
  const sheet = await zip.file(sheetPath)!.async("string");
  const withNamespaces = sheet.includes("xmlns:r=") ? sheet : sheet.replace("<worksheet ", '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  zip.file(sheetPath, withNamespaces.replace("</worksheet>", '<drawing r:id="rId1"/></worksheet>'));
  zip.file(`xl/worksheets/_rels/sheet${sheetNumber}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`);
  zip.file("xl/drawings/drawing1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>6</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>25</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
  <xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Industry performance"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
</xdr:wsDr>`);
  zip.file("xl/drawings/_rels/drawing1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`);
  const series = tickers.map((ticker, index) => {
    const column = columnLetter(index + 2);
    return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:v>${ticker}</c:v></c:tx><c:spPr><a:ln><a:solidFill><a:srgbClr val="${[green, "143142", "B97816", "7D5A91", "A4463F"][index % 5]}"/></a:solidFill></a:ln></c:spPr><c:cat><c:strRef><c:f>'Growth of 100'!$A$2:$A$${rows + 1}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>'Growth of 100'!$${column}$2:$${column}$${rows + 1}</c:f></c:numRef></c:val></c:ser>`;
  }).join("");
  zip.file("xl/charts/chart1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Growth of 100</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:axId val="100001"/><c:axId val="100002"/></c:lineChart><c:catAx><c:axId val="100001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="100002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="100002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:numFmt formatCode="0" sourceLinked="0"/><c:majorGridlines/><c:tickLblPos val="nextTo"/><c:crossAx val="100001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`);
  const contentTypesPath = "[Content_Types].xml";
  const contentTypes = await zip.file(contentTypesPath)!.async("string");
  zip.file(contentTypesPath, contentTypes.replace("</Types>", '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'));
  return (await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })) as ArrayBuffer;
}

function styleSheet(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${green}` } };
  sheet.getRow(1).height = 24;
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, sheet.columnCount) } };
  sheet.columns.forEach((column) => {
    let width = 12;
    column.eachCell?.({ includeEmpty: false }, (cell) => { width = Math.max(width, Math.min(42, String(cell.value ?? "").length + 2)); });
    column.width = width;
  });
}

function addRows(sheet: ExcelJS.Worksheet, headers: string[], rows: (string | number | Date | null)[][]) {
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  styleSheet(sheet);
}

export async function buildIndustryWorkbook(payload: IndustryPayload, start: string, end: string): Promise<Blob> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "IndustryScope";
  workbook.created = new Date();
  const tickers = [payload.sector.primary_etf, ...payload.sector.comparison_etfs, "SPY"];
  const filteredPrices = payload.prices.filter((row) => row.date >= start && row.date <= end);

  // Nine sheets with no orientation is where a recruiter closes the file.
  const readme = workbook.addWorksheet("Read me");
  readme.addRow(["IndustryScope workbook"]);
  readme.addRow([`${payload.sector.name} · ${payload.sector.primary_etf}`]);
  readme.addRow([`Date range ${start} to ${end}`]);
  readme.addRow([`Generated ${new Date().toISOString()}`]);
  readme.addRow([]);
  readme.addRow(["Returns are total returns with dividends reinvested."]);
  readme.addRow(["Every figure comes from a public source and is stored before it is shown. Blank means not reported, never zero."]);
  readme.addRow([]);
  readme.addRow(["Sheet", "What it contains"]);
  ([
    ["Summary", "Sector, ticker, date range and generation time."],
    ["Price History", "Dividend-adjusted closes for every ticker, one row per date."],
    ["Daily Returns", "One plain formula per row, so the volatility and correlation maths is visible."],
    ["Growth of 100", "Every ticker indexed to 100 at the first date. This is what the chart plots."],
    ["Returns", "Cumulative return, annualized volatility and correlation to SPY, as live formulas."],
    ["Holdings", "Constituents and weights for funds whose latest snapshot passed validation."],
    ["Overlap", "Share of any two funds' portfolios held in common, by weight."],
    ["Comps", "One row per company: revenue, growth, margins and market cap."],
    ["Comps (raw)", "The underlying XBRL facts, one row per tag per period."],
    ["Private Capital", "Form D filings. Submission Type marks amendments, which restate a cumulative total."],
    ["Macro", "FRED, EIA and BLS observations for this sector."],
    ["Events", "Curated events with sources."],
    ["Headlines", "NYT headline, abstract and link. No article text is stored."],
    ["Checks", "Validation actually run against this file."],
  ] as string[][]).forEach((row) => readme.addRow(row));
  readme.getCell("A1").font = { bold: true, size: 18, color: { argb: `FF${ink}` } };
  readme.getCell("A9").font = { bold: true };
  readme.getCell("B9").font = { bold: true };
  readme.views = [{ showGridLines: false }];
  readme.columns = [{ width: 22 }, { width: 88 }];

  const summary = workbook.addWorksheet("Summary");
  summary.addRow(["IndustryScope", payload.sector.name]);
  summary.addRow(["Date range", `${start} to ${end}`]);
  summary.addRow(["Primary ETF", payload.sector.primary_etf]);
  summary.addRow(["Generated", new Date()]);
  summary.getCell("A1").font = { bold: true, size: 18, color: { argb: `FF${ink}` } };
  summary.getCell("B1").font = { bold: true, size: 18, color: { argb: `FF${green}` } };
  summary.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  summary.columns = [{ width: 20 }, { width: 32 }];

  const price = workbook.addWorksheet("Price History");
  const dates = [...new Set(filteredPrices.map((row) => row.date))].sort();
  const byKey = new Map(filteredPrices.map((row) => [`${row.date}:${row.ticker}`, row.adj_close]));
  addRows(price, ["Date", ...tickers], dates.map((date) => [new Date(`${date}T00:00:00Z`), ...tickers.map((ticker) => byKey.get(`${date}:${ticker}`) ?? null)]));
  price.getColumn(1).numFmt = "yyyy-mm-dd";
  for (let column = 2; column <= price.columnCount; column += 1) price.getColumn(column).numFmt = "$#,##0.00";

  const lastPriceRow = dates.length + 1;

  const daily = workbook.addWorksheet("Daily Returns");
  daily.addRow(["Date", ...tickers]);
  dates.slice(1).forEach((date, index) => {
    const row = index + 2;
    daily.addRow([
      new Date(`${date}T00:00:00Z`),
      ...tickers.map((_, tickerIndex) => {
        const letter = price.getColumn(tickerIndex + 2).letter;
        return { formula: `IFERROR('Price History'!${letter}${row + 1}/'Price History'!${letter}${row}-1,"")` };
      }),
    ]);
  });
  styleSheet(daily);
  daily.getColumn(1).numFmt = "yyyy-mm-dd";
  for (let column = 2; column <= daily.columnCount; column += 1) daily.getColumn(column).numFmt = "0.00%";
  const lastDailyRow = Math.max(2, dates.length);

  // Indexed to 100 at the first date, as values rather than formulas so the
  // embedded chart renders before Excel recalculates.
  const growth = workbook.addWorksheet("Growth of 100");
  const firstClose = new Map(tickers.map((ticker) => {
    const first = dates.map((date) => byKey.get(`${date}:${ticker}`)).find((value) => typeof value === "number" && value > 0);
    return [ticker, first ?? null];
  }));
  addRows(growth, ["Date", ...tickers], dates.map((date) => [
    new Date(`${date}T00:00:00Z`),
    ...tickers.map((ticker) => {
      const base = firstClose.get(ticker);
      const value = byKey.get(`${date}:${ticker}`);
      return base && typeof value === "number" ? (value / base) * 100 : null;
    }),
  ]));
  growth.getColumn(1).numFmt = "yyyy-mm-dd";
  for (let column = 2; column <= growth.columnCount; column += 1) growth.getColumn(column).numFmt = "0.0";

  const returns = workbook.addWorksheet("Returns");
  returns.addRow(["Ticker", "Cumulative return", "Annualized volatility", "Correlation to SPY"]);
  tickers.forEach((ticker, index) => {
    const letter = price.getColumn(index + 2).letter;
    const dailyLetter = daily.getColumn(index + 2).letter;
    const spyDailyLetter = daily.getColumn(tickers.indexOf("SPY") + 2).letter;
    const column = `'Price History'!$${letter}$2:$${letter}$${lastPriceRow}`;
    returns.addRow([
      ticker,
      // First and last non-blank rather than fixed row 2 and row N, so a
      // boundary gap for one ticker does not silently blank the cell.
      { formula: `IFERROR(LOOKUP(2,1/(${column}<>""),${column})/INDEX(${column},MATCH(TRUE,INDEX(${column}<>"",0),0))-1,"")` },
      // Points at Daily Returns, so these are ordinary scalar formulas that
      // calculate in every version of Excel.
      { formula: `IFERROR(STDEV('Daily Returns'!${dailyLetter}2:${dailyLetter}${lastDailyRow})*SQRT(252),"")` },
      { formula: `IFERROR(CORREL('Daily Returns'!${dailyLetter}2:${dailyLetter}${lastDailyRow},'Daily Returns'!${spyDailyLetter}2:${spyDailyLetter}${lastDailyRow}),"")` },
    ]);
  });
  styleSheet(returns);
  returns.getColumn(2).numFmt = "0.0%";
  returns.getColumn(3).numFmt = "0.0%";

  const holdings = workbook.addWorksheet("Holdings");
  // Sub-sector is the only field that lets someone pivot a fund's holdings by
  // sector, which is much of the reason to open the workbook. Most issuers do
  // not publish it, so say that rather than leaving a blank cell that reads as
  // a bug.
  const shownHoldings = exportableHoldings(payload, end);
  addRows(holdings, ["Fund", "As of", "Ticker", "Name", "Weight", "Sub-sector"], shownHoldings.map((row) => [row.fund_ticker, new Date(`${row.as_of}T00:00:00Z`), row.constituent_ticker, row.constituent_name, row.weight, row.sub_sector ?? "Not provided by issuer"]));
  holdings.getColumn(2).numFmt = "yyyy-mm-dd";
  holdings.getColumn(5).numFmt = "0.0%";

  const funds = [...new Set(shownHoldings.map((row) => row.fund_ticker))];
  const matrix = holdingsOverlap(Object.fromEntries(funds.map((fund) => [fund, shownHoldings.filter((row) => row.fund_ticker === fund).map((row) => ({ ticker: row.constituent_ticker, weight: row.weight }))])));
  const overlap = workbook.addWorksheet("Overlap");
  addRows(overlap, ["Fund", ...funds], funds.map((row) => [row, ...funds.map((column) => matrix[row][column])]));
  for (let column = 2; column <= overlap.columnCount; column += 1) overlap.getColumn(column).numFmt = "0.0%";

  const comps = workbook.addWorksheet("Comps");
  const compRows = compsRows({
    companyFacts: payload.companyFacts.filter((fact) => fact.filed_date <= end),
    companyMeta: payload.companyMeta,
  });
  addRows(comps, ["Ticker", "Period", "Market cap (current)", "Revenue growth", "Gross margin", "Operating margin", "Net margin"],
    compRows.map((row) => [row.ticker, row.period, row.marketCap, row.revenueGrowth, row.grossMargin, row.operatingMargin, row.netMargin]));
  comps.getColumn(3).numFmt = "$#,##0";
  for (let column = 4; column <= 7; column += 1) comps.getColumn(column).numFmt = "0.0%";

  const facts = workbook.addWorksheet("Comps (raw)");
  addRows(facts, ["CIK", "Ticker", "Fiscal Period", "Metric", "Value", "Filed Date"], payload.companyFacts.map((row) => [row.cik, row.ticker, row.fiscal_period, row.metric, row.value, new Date(`${row.filed_date}T00:00:00Z`)]));
  facts.getColumn(5).numFmt = "$#,##0.00";
  facts.getColumn(6).numFmt = "yyyy-mm-dd";

  const capital = workbook.addWorksheet("Private Capital");
  // "Supersedes" marks an amendment, which restates an offering's cumulative
  // total. Without these two columns a reader summing Amount Sold in Excel
  // would double-count every amended offering.
  addRows(capital, ["Filed Date", "Issuer", "SIC", "Offering Amount", "Amount Sold", "State", "Accession", "Submission Type", "Supersedes"], payload.formD.map((row) => [new Date(`${row.filed_date}T00:00:00Z`), row.issuer_name, row.sic_code, row.total_offering_amount, row.amount_sold, row.state, row.accession_no, row.submission_type, row.previous_accession_no]));
  capital.getColumn(1).numFmt = "yyyy-mm-dd";
  capital.getColumn(4).numFmt = "$#,##0.00";
  capital.getColumn(5).numFmt = "$#,##0.00";

  const macro = workbook.addWorksheet("Macro");
  const labels = new Map(payload.macro.meta.map((row) => [row.series_id, row.label]));
  addRows(macro, ["Series ID", "Label", "Date", "Value"], payload.macro.series.map((row) => [row.series_id, labels.get(row.series_id) ?? row.series_id, new Date(`${row.date}T00:00:00Z`), row.value]));
  macro.getColumn(3).numFmt = "yyyy-mm-dd";

  const events = workbook.addWorksheet("Events");
  addRows(events, ["Start", "End", "Title", "Impact", "Blurb", "Source URL"], payload.events.filter((row) => row.blurb?.trim()).map((row) => [new Date(`${row.start_date}T00:00:00Z`), row.end_date ? new Date(`${row.end_date}T00:00:00Z`) : null, row.title, row.impact, row.blurb, row.source_url]));
  events.getColumn(1).numFmt = "yyyy-mm-dd";
  events.getColumn(2).numFmt = "yyyy-mm-dd";

  const headlines = workbook.addWorksheet("Headlines");
  addRows(headlines, ["Published", "Source", "Section", "Headline", "Abstract", "URL"], payload.headlines.map((row) => [utcDate(row.published_date), row.source, row.section, row.headline, row.abstract, row.url]));
  headlines.getColumn(1).numFmt = "yyyy-mm-dd hh:mm";

  // Every row below is computed from this workbook. The previous sheet asserted
  // "Formula sheets: OK" and "Missing values: OK" as hardcoded strings.
  const suppressedFunds = [...new Set(payload.holdings.map((row) => row.fund_ticker))]
    .filter((fund) => !funds.includes(fund));
  const blankPriceCells = dates.reduce((total, date) => total + tickers.filter((ticker) => byKey.get(`${date}:${ticker}`) == null).length, 0);
  const compsWithoutGrowth = compRows.filter((row) => row.revenueGrowth === null).length;
  const checks = workbook.addWorksheet("Checks");
  checks.addRow(["Check", "Status", "Notes"]);
  ([
    ["Price rows", filteredPrices.length ? "OK" : "REVIEW",
      filteredPrices.length ? `${filteredPrices.length} observations across ${dates.length} dates` : "No price data in the selected range"],
    ["Daily return rows", lastDailyRow - 1 === Math.max(0, dates.length - 1) ? "OK" : "REVIEW",
      `${Math.max(0, dates.length - 1)} rows, one per price row after the first`],
    ["Formula sheets", dates.length > 1 ? "OK" : "REVIEW",
      dates.length > 1 ? "Returns reads Daily Returns; no array formulas are used" : "Too few dates to build return formulas"],
    ["Blank price cells", blankPriceCells === 0 ? "OK" : "REVIEW",
      `${blankPriceCells} ticker/date cells have no observation. Blank is never zero-filled`],
    ["Holdings suppressed", suppressedFunds.length === 0 ? "OK" : "REVIEW",
      suppressedFunds.length ? `Excluded, matching the site: ${suppressedFunds.join(", ")}` : "Every fund's latest snapshot passed validation"],
    ["Comps coverage", compRows.length ? "OK" : "REVIEW",
      `${compRows.length} companies, ${compsWithoutGrowth} without a comparable prior period`],
    ["Events exported", "OK", `${payload.events.filter((row) => row.blurb?.trim()).length} of ${payload.events.length} events carry a description`],
  ] as string[][]).forEach((row) => checks.addRow(row));
  styleSheet(checks);

  const buffer = await workbook.xlsx.writeBuffer();
  const growthSheetNumber = workbook.worksheets.findIndex((sheet) => sheet.name === "Growth of 100") + 1;
  const charted = await injectNativeChart(buffer as ArrayBuffer, tickers, dates.length, growthSheetNumber);
  return new Blob([charted], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
