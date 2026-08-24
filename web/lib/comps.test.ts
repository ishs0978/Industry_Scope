import { describe, expect, it } from "vitest";
import { compsRows, type CompsSource, factsCoverage, plausibleMargin, mergeShareClasses, primaryShareClass } from "./comps";
import type { CompanyFact } from "./types";

const fact = (period: string, metric: string, value: number | null): CompanyFact => ({
  cik: "0000000001", ticker: "TEST", fiscal_period: period, metric, value, filed_date: "2026-01-01",
});

const source = (companyFacts: CompanyFact[]): CompsSource => ({ companyFacts, companyMeta: [] });

describe("comps revenue growth", () => {
  it("returns null when the two periods report different revenue tags", () => {
    const rows = compsRows(source([
      fact("CY2025Q2", "Revenues", 1_200),
      fact("CY2024Q2", "RevenueFromContractWithCustomerExcludingAssessedTax", 1_000),
    ]));
    expect(rows).toHaveLength(1);
    // Pairing the two tags would fabricate +20%.
    expect(rows[0].revenueGrowth).toBeNull();
  });

  it("computes growth when both periods report the same tag", () => {
    const rows = compsRows(source([
      fact("CY2025Q2", "Revenues", 1_200),
      fact("CY2024Q2", "Revenues", 1_000),
    ]));
    expect(rows[0].revenueGrowth).toBeCloseTo(0.2);
  });

  it("prefers the resolved tag over another tag present in the prior period", () => {
    const rows = compsRows(source([
      fact("CY2025Q2", "Revenues", 1_200),
      fact("CY2024Q2", "Revenues", 800),
      fact("CY2024Q2", "RevenueFromContractWithCustomerExcludingAssessedTax", 1_000),
    ]));
    expect(rows[0].revenueGrowth).toBeCloseTo(0.5);
  });

  it("returns null instead of guessing a prior period by index", () => {
    // Five mixed periods with no matching fiscal suffix. The old `?? periods[4]`
    // fallback would have paired CY2025Q3 against whatever sorted fifth.
    const rows = compsRows(source([
      fact("CY2025Q3", "Revenues", 1_500),
      fact("CY2025Q2", "Revenues", 1_400),
      fact("CY2025Q1", "Revenues", 1_300),
      fact("CY2024", "Revenues", 1_200),
      fact("CY2023", "Revenues", 1_100),
    ]));
    expect(rows[0].period).toBe("CY2025Q3");
    expect(rows[0].revenueGrowth).toBeNull();
  });

  it("keeps margins on the resolved revenue tag", () => {
    const rows = compsRows(source([
      fact("CY2025Q2", "Revenues", 1_000),
      fact("CY2025Q2", "GrossProfit", 400),
      fact("CY2025Q2", "NetIncomeLoss", 100),
    ]));
    expect(rows[0].grossMargin).toBeCloseTo(0.4);
    expect(rows[0].netMargin).toBeCloseTo(0.1);
    expect(rows[0].operatingMargin).toBeNull();
  });
});

describe("fundamentals coverage", () => {
  const holdings = [
    { constituent_ticker: "XOM", weight: 0.206 },
    { constituent_ticker: "CVX", weight: 0.18 },
    { constituent_ticker: "COP", weight: 0.08 },
    { constituent_ticker: "APA", weight: 0.02 },
  ];
  const fact = (ticker: string) => ({
    cik: "1", ticker, fiscal_period: "CY2026Q2", metric: "Revenues",
    value: 1, filed_date: "2026-07-01",
  });

  it("refuses to call a median reliable when the largest holding is missing", () => {
    // Energy's median was computed with XOM absent, and XOM is a fifth of the
    // fund. That is not a sector median.
    const coverage = factsCoverage(holdings, ["CVX", "COP", "APA"].map(fact));
    expect(coverage.largest).toMatchObject({ ticker: "XOM", covered: false });
    expect(coverage.reliable).toBe(false);
  });

  it("refuses when too little of the fund by weight is covered", () => {
    const coverage = factsCoverage(holdings, ["XOM", "APA"].map(fact));
    expect(coverage.largest?.covered).toBe(true);
    expect(coverage.weightCovered).toBeLessThan(0.75);
    expect(coverage.reliable).toBe(false);
  });

  it("accepts full coverage and reports the numbers behind it", () => {
    const coverage = factsCoverage(holdings, ["XOM", "CVX", "COP", "APA"].map(fact));
    expect(coverage).toMatchObject({ constituents: 4, covered: 4, reliable: true });
    expect(coverage.weightCovered).toBeCloseTo(1);
  });

  it("blanks a margin that cannot be true rather than printing it", () => {
    // Camden Property Trust: $119M of net income over a $5M fee line.
    expect(plausibleMargin(23.33)).toBeNull();
    expect(plausibleMargin(-1.6)).toBeNull();
    expect(plausibleMargin(0.42)).toBe(0.42);
    expect(plausibleMargin(null)).toBeNull();
  });
});

describe("period selection", () => {
  const fact = (period: string, metric: string, value: number, filed: string) => ({
    cik: "1", ticker: "INTC", fiscal_period: period, metric, value, filed_date: filed,
  });

  it("takes the most recently filed period, not the one that sorts last", () => {
    // FY sorts after CY for reasons unrelated to time, which is how a company
    // reporting both ended up labelled with the wrong quarter's figures.
    const rows = compsRows({ companyFacts: [
      fact("CY2026Q2", "Revenues", 16_100, "2026-07-24"),
      fact("CY2026Q2", "NetIncomeLoss", -11_000, "2026-07-24"),
      fact("FY2026Q2", "Revenues", 12_800, "2025-08-01"),
      fact("FY2026Q2", "NetIncomeLoss", -1_600, "2025-08-01"),
    ], companyMeta: [] });
    expect(rows[0].period).toBe("CY2026Q2");
    expect(rows[0].filed).toBe("2026-07-24");
  });

  it("never treats an instant frame as a quarter of activity", () => {
    // CY2026Q2I is a balance sheet at a moment; dividing income by it is
    // meaningless, and it produced rows with every metric blank.
    const rows = compsRows({ companyFacts: [
      fact("CY2026Q2I", "Assets", 200_000, "2026-08-01"),
      fact("CY2026Q1", "Revenues", 10_000, "2026-04-01"),
      fact("CY2026Q1", "NetIncomeLoss", 1_000, "2026-04-01"),
    ], companyMeta: [] });
    expect(rows[0].period).toBe("CY2026Q1");
    expect(rows[0].netMargin).toBeCloseTo(0.1);
  });

  it("compares like frames only", () => {
    const rows = compsRows({ companyFacts: [
      fact("FY2026Q2", "Revenues", 120, "2026-07-01"),
      fact("CY2025Q2", "Revenues", 60, "2025-07-01"),
    ], companyMeta: [] });
    // The only prior period on offer is a different frame, so growth is blank
    // rather than a doubling that never happened.
    expect(rows[0].revenueGrowth).toBeNull();
  });
});

describe("share classes", () => {
  it("counts one company once", () => {
    // XLC holds GOOGL at 10.43% and GOOG at 8.35%. That is 18.78% of Alphabet,
    // not two companies, and the AI cloud group dropped GOOG's 8.35 points.
    const merged = mergeShareClasses([
      { constituent_ticker: "GOOGL", weight: 0.1043 },
      { constituent_ticker: "META", weight: 0.0912 },
      { constituent_ticker: "GOOG", weight: 0.0835 },
    ]);
    expect(merged[0]).toMatchObject({ constituent_ticker: "GOOGL" });
    expect(merged[0].weight).toBeCloseTo(0.1878);
    expect(merged).toHaveLength(2);
  });

  it("maps the classes explicitly rather than stripping a letter", () => {
    // Stripping a trailing letter would fold unrelated tickers together, and
    // being wrong here silently doubles a weight.
    expect(primaryShareClass("BRK.A")).toBe("BRK.B");
    expect(primaryShareClass("FOX")).toBe("FOXA");
    expect(primaryShareClass("NWS")).toBe("NWSA");
    expect(primaryShareClass("NVDA")).toBe("NVDA");
    expect(primaryShareClass("A")).toBe("A");
  });
});

describe("which period heads a company's row", () => {
  const fact = (fiscal_period: string, metric: string, value: number, filed_date: string) =>
    ({ cik: "1", ticker: "MTD", fiscal_period, metric, value, filed_date }) as never;

  it("prefers the newer period when one filing carries both it and its comparative", () => {
    // A quarterly report includes the prior-year quarter, so both periods share
    // a filing date. Sorted as strings, FY2024Q2 beats CY2026Q2 and MTD's row
    // showed figures from two years earlier under the current-quarter heading.
    const rows = compsRows({
      companyFacts: [
        fact("CY2026Q2", "Revenues", 1_027_314_000, "2026-07-31"),
        fact("CY2026Q2", "NetIncomeLoss", 232_899_000, "2026-07-31"),
        fact("FY2024Q2", "Revenues", 1_866_965_000, "2026-07-31"),
        fact("FY2024Q2", "NetIncomeLoss", 365_935_000, "2026-07-31"),
      ],
      companyMeta: [],
    });
    expect(rows[0].period).toBe("CY2026Q2");
  });

  it("still lets a later filing win, because a restatement supersedes", () => {
    const rows = compsRows({
      companyFacts: [
        fact("CY2026Q1", "Revenues", 100, "2026-08-01"),
        fact("CY2026Q2", "Revenues", 200, "2026-07-01"),
      ],
      companyMeta: [],
    });
    expect(rows[0].period).toBe("CY2026Q1");
  });
});
