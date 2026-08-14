import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildIndustryWorkbook } from "./workbook";
import type { IndustryPayload } from "./types";

const DATES = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];
const CLOSES: Record<string, number[]> = { XLE: [100, 104, 102, 108], SPY: [600, 606, 603, 612] };

function payload(overrides: Partial<IndustryPayload> = {}): IndustryPayload {
  return {
    sector: {
      slug: "energy", name: "Energy", aliases: [], primary_etf: "XLE", comparison_etfs: [],
      news_keywords: [], sic_prefixes: ["13"], naics_code: "211",
    },
    prices: DATES.flatMap((date, index) => ["XLE", "SPY"].map((ticker) => ({
      ticker, date, adj_close: CLOSES[ticker][index], close: CLOSES[ticker][index], volume: 1,
    }))),
    etfMeta: [{
      ticker: "XLE", name: "Energy", expense_ratio: 0.0008, aum: 1e10, issuer: "SSGA",
      as_of: "2026-01-07", holdings_status: "ok", holdings_error: null,
    }],
    // Five rows summing to 1.0, so the snapshot passes the same validation the
    // site applies before it will render a fund.
    holdings: [
      { fund_ticker: "XLE", as_of: "2026-01-07", constituent_ticker: "XOM", constituent_name: "Exxon", weight: 0.3, sub_sector: "Integrated" },
      { fund_ticker: "XLE", as_of: "2026-01-07", constituent_ticker: "CVX", constituent_name: "Chevron", weight: 0.25, sub_sector: null },
      { fund_ticker: "XLE", as_of: "2026-01-07", constituent_ticker: "COP", constituent_name: "ConocoPhillips", weight: 0.2, sub_sector: "E&P" },
      { fund_ticker: "XLE", as_of: "2026-01-07", constituent_ticker: "MPC", constituent_name: "Marathon", weight: 0.15, sub_sector: "Refining" },
      { fund_ticker: "XLE", as_of: "2026-01-07", constituent_ticker: "SLB", constituent_name: "Schlumberger", weight: 0.1, sub_sector: null },
    ],
    macro: { meta: [], series: [] },
    companyFacts: [
      { cik: "1", ticker: "XOM", fiscal_period: "CY2025Q4", metric: "Revenues", value: 1200, filed_date: "2026-01-05" },
      { cik: "1", ticker: "XOM", fiscal_period: "CY2024Q4", metric: "Revenues", value: 1000, filed_date: "2025-01-05" },
      { cik: "1", ticker: "XOM", fiscal_period: "CY2025Q4", metric: "GrossProfit", value: 480, filed_date: "2026-01-05" },
    ],
    companyMeta: [{ ticker: "XOM", market_cap: 5e11, as_of: "2026-01-07" }],
    formD: [], headlines: [
      { id: "h1", sector_slug: "energy", published_date: "2026-01-06T14:31:00Z", source: "NYT", headline: "Pipeline news", abstract: null, section: "Business", url: "https://example.test" },
    ],
    newsVolume: [],
    events: [
      { id: "described", start_date: "2026-01-05", end_date: "2026-01-06", sectors: ["energy"], title: "Described", blurb: "Something happened. It reached this sector through a channel.", source_url: "https://example.test", impact: "mixed" },
      { id: "blank", start_date: "2026-01-05", end_date: null, sectors: ["energy"], title: "Blank", blurb: "", source_url: "https://example.test", impact: "mixed" },
    ],
    freshness: [], errors: [],
    ...overrides,
  };
}

async function build(input = payload()) {
  const blob = await buildIndustryWorkbook(input, DATES[0], DATES.at(-1)!);
  return JSZip.loadAsync(await blob.arrayBuffer());
}

async function sheetNames(zip: JSZip): Promise<string[]> {
  const xml = await zip.file("xl/workbook.xml")!.async("string");
  return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map((match) => match[1]);
}

describe("industry workbook", () => {
  it("puts Read me first and includes every documented sheet", async () => {
    const names = await sheetNames(await build());
    expect(names[0]).toBe("Read me");
    for (const sheet of ["Daily Returns", "Growth of 100", "Comps", "Comps (raw)", "Checks"]) {
      expect(names).toContain(sheet);
    }
  });

  it("uses plain per-row formulas instead of array expressions", async () => {
    const zip = await build();
    const names = await sheetNames(zip);
    const returns = await zip.file(`xl/worksheets/sheet${names.indexOf("Returns") + 1}.xml`)!.async("string");
    // STDEV and CORREL must read the Daily Returns column, not a division of two
    // ranges, which is an array formula that silently returns a wrong scalar in
    // older Excel unless entered with Ctrl+Shift+Enter.
    expect(returns).toContain("Daily Returns");
    expect(returns).not.toMatch(/STDEV\('Price History'/);
    expect(returns).not.toMatch(/CORREL\('Price History'/);
  });

  it("computes cumulative return from the first and last non-blank value", async () => {
    const zip = await build();
    const names = await sheetNames(zip);
    const returns = await zip.file(`xl/worksheets/sheet${names.indexOf("Returns") + 1}.xml`)!.async("string");
    expect(returns).toContain("LOOKUP(2,1/(");
    expect(returns).toContain("MATCH(TRUE,INDEX(");
  });

  it("indexes the embedded chart to 100 rather than plotting dollars", async () => {
    const zip = await build();
    const chart = await zip.file("xl/charts/chart1.xml")!.async("string");
    expect(chart).toContain("Growth of 100");
    expect(chart).not.toContain("Adjusted Close");
    // A dollar axis cannot compare a $600 benchmark with a $200 fund.
    expect(chart).not.toContain('formatCode="$#,##0.00"');
  });

  it("anchors the chart to the Growth of 100 sheet, not to sheet one", async () => {
    const zip = await build();
    const names = await sheetNames(zip);
    const growth = names.indexOf("Growth of 100") + 1;
    expect(await zip.file(`xl/worksheets/sheet${growth}.xml`)!.async("string")).toContain("<drawing");
    expect(await zip.file("xl/worksheets/sheet1.xml")!.async("string")).not.toContain("<drawing");
  });

  it("labels a missing sub-sector instead of leaving the cell blank", async () => {
    const zip = await build();
    const shared = await zip.file("xl/sharedStrings.xml")!.async("string");
    expect(shared).toContain("Not provided by issuer");
  });

  it("suppresses holdings the site would refuse to display", async () => {
    const suppressed = payload({
      freshness: [{
        source: "holdings:XLE", started_at: "2026-01-07T11:00:00Z", finished_at: "2026-01-07T11:01:00Z",
        status: "failed", rows_written: 0, error_message: "Issuer feed returned HTML", details: {},
      }],
    });
    const shared = await (await build(suppressed)).file("xl/sharedStrings.xml")!.async("string");
    expect(shared).not.toContain("Exxon");
    // And the Checks sheet says so rather than staying silent.
    expect(shared).toContain("Holdings suppressed");
  });

  it("does not export an event with no description", async () => {
    const shared = await (await build()).file("xl/sharedStrings.xml")!.async("string");
    expect(shared).toContain("Described");
    expect(shared).not.toContain("Editorial description pending human review");
  });

  it("reports checks it actually ran", async () => {
    const shared = await (await build()).file("xl/sharedStrings.xml")!.async("string");
    for (const check of ["Price rows", "Daily return rows", "Blank price cells", "Comps coverage"]) {
      expect(shared).toContain(check);
    }
  });

  it("states the return basis on the Read me sheet", async () => {
    const shared = await (await build()).file("xl/sharedStrings.xml")!.async("string");
    expect(shared).toContain("Returns are total returns with dividends reinvested.");
  });
});
