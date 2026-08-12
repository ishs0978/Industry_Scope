import { describe, expect, it } from "vitest";
import {
  annualizedVolatility, beta, cagr, calendarPeriodReturns, calendarYearReturns, concentration,
  correlation, cumulativeReturn, holdingsOverlap, holdingsSnapshotIssue, maxDrawdown, relativeStrength,
  rollingCorrelation, rollingVolatility, sharpeRatio, type SeriesPoint,
} from "./metrics";

const series = (values: number[], start = Date.UTC(2020, 0, 1)): SeriesPoint[] =>
  values.map((value, index) => ({
    date: new Date(start + index * 86_400_000).toISOString().slice(0, 10), value,
  }));

describe("return and risk metrics", () => {
  it("computes cumulative return and CAGR", () => {
    const points = [{ date: "2020-01-01", value: 100 }, { date: "2021-01-01", value: 121 }];
    expect(cumulativeReturn(points)).toBeCloseTo(0.21);
    expect(cagr(points)).toBeCloseTo(0.21, 2);
  });

  it("computes annualized sample volatility and Sharpe", () => {
    const points = series([100, 110, 99, 108.9]);
    const returns = [0.1, -0.1, 0.1];
    const mean = returns.reduce((sum, value) => sum + value, 0) / 3;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 2;
    expect(annualizedVolatility(points)).toBeCloseTo(Math.sqrt(variance * 252));
    const riskFree = series([0, 0, 0, 0]);
    expect(sharpeRatio(points, riskFree)).toBeCloseTo((mean * 252) / Math.sqrt(variance * 252));
  });

  it("finds drawdown peak, trough, recovery, and duration", () => {
    const result = maxDrawdown(series([100, 120, 90, 80, 100, 120]));
    expect(result?.maxDrawdown).toBeCloseTo(-1 / 3);
    expect(result?.peakDate).toBe("2020-01-02");
    expect(result?.troughDate).toBe("2020-01-04");
    expect(result?.recoveryDate).toBe("2020-01-06");
    expect(result?.durationDays).toBe(4);
  });

  it("computes beta and correlation on aligned observations", () => {
    const benchmark = series([100, 110, 99, 108.9]);
    const asset = series([100, 120, 96, 115.2]);
    expect(beta(asset, benchmark)).toBeCloseTo(2);
    expect(correlation(series([1, 2, 3]), series([2, 4, 6]))).toBeCloseTo(1);
  });

  it("computes rolling metrics only after full windows", () => {
    expect(rollingVolatility(series([100, 101, 100, 102]), 3)).toHaveLength(1);
    expect(rollingCorrelation(series([100, 101, 100, 102]), series([100, 102, 100, 104]), 3)).toHaveLength(1);
  });
});

describe("comparison and holdings metrics", () => {
  it("indexes relative strength to 100", () => {
    expect(relativeStrength(series([100, 120]), series([50, 50]))).toEqual([
      { date: "2020-01-01", value: 100 }, { date: "2020-01-02", value: 120 },
    ]);
  });

  it("computes calendar returns", () => {
    const points = [
      { date: "2023-01-03", value: 100 }, { date: "2023-12-29", value: 110 },
      { date: "2024-01-02", value: 120 }, { date: "2024-12-31", value: 90 },
    ];
    const returns = calendarYearReturns(points);
    expect(returns[2023]).toBeCloseTo(0.1);
    expect(returns[2024]).toBeCloseTo(90 / 110 - 1);
  });

  it("test_partial_year_labeled", () => {
    const periods = calendarPeriodReturns([
      { date: "2023-08-12", value: 100 },
      { date: "2023-12-29", value: 106.9 },
      { date: "2024-12-31", value: 120 },
    ], "2023-08-12", "2024-12-31");
    expect(periods[0].partial).toBe(true);
    expect(periods[0].label).not.toBe("2023");
    expect(periods[0].label).toContain("from Aug 12");
  });

  it("labels database ISO timestamps without throwing", () => {
    const periods = calendarPeriodReturns([
      { date: "2023-08-12T00:00:00.000Z", value: 100 },
      { date: "2023-12-29T00:00:00.000Z", value: 106.9 },
    ], "2023-08-12", "2023-12-29T00:00:00.000Z");
    expect(periods[0].label).toBe("2023 (Aug 12–Dec 29)");
  });

  it("test_spy_2023_full_year", () => {
    const periods = calendarPeriodReturns([
      { date: "2022-12-30", value: 100 },
      { date: "2023-06-30", value: 112 },
      { date: "2023-12-29", value: 126 },
      { date: "2024-01-02", value: 127 },
    ], "2022-12-30", "2024-01-02");
    const spy2023 = periods.find((period) => period.year === "2023")!.value;
    expect(spy2023).toBeGreaterThanOrEqual(0.24);
    expect(spy2023).toBeLessThanOrEqual(0.28);
  });

  it("test_cumulative_reconciles", () => {
    const sectors = [
      series([100, 103, 98, 121]),
      series([100, 90, 110, 95, 140]),
      series([100, 150, 125]),
      series([100, 101, 102, 103, 104, 105]),
    ];
    for (const prices of sectors) {
      const periods = calendarPeriodReturns(prices, prices[0].date, prices.at(-1)!.date);
      const compounded = periods.reduce((factor, period) => factor * (1 + period.value), 1) - 1;
      expect(compounded).toBeCloseTo(cumulativeReturn(prices)!, 10);
    }
  });

  it("computes concentration and a symmetric overlap matrix", () => {
    expect(concentration([0.5, 0.3, 0.2])).toEqual({ top10Weight: 1, hhi: 0.38 });
    const matrix = holdingsOverlap({
      A: [{ ticker: "X", weight: 0.6 }, { ticker: "Y", weight: 0.4 }],
      B: [{ ticker: "X", weight: 0.3 }, { ticker: "Z", weight: 0.7 }],
    });
    expect(matrix.A.B).toBeCloseTo(0.3);
    expect(matrix.B.A).toBeCloseTo(0.3);
    expect(matrix.A.A).toBeCloseTo(1);
  });

  it("test_hhi_bounded", () => {
    for (const weights of [[0.25, 0.25, 0.25, 0.25], [0.60, 0.10, 0.10, 0.10, 0.10]]) {
      const hhi = concentration(weights).hhi;
      expect(hhi).toBeGreaterThan(0);
      expect(hhi).toBeLessThanOrEqual(1);
    }
  });

  it("test_top10_bounded", () => {
    expect(concentration([0.25, 0.25, 0.25, 0.25]).top10Weight).toBeLessThanOrEqual(1);
    expect(concentration([25, 25, 25, 25]).top10Weight).toBeLessThanOrEqual(1);
  });

  it("test_self_overlap_is_100", () => {
    const funds = {
      XLE: [{ ticker: "XOM", weight: 0.21 }, { ticker: "CVX", weight: 0.15 }, { ticker: "COP", weight: 0.14 }, { ticker: "MPC", weight: 0.13 }, { ticker: "OTHER", weight: 0.37 }],
      XOP: [{ ticker: "XOM", weight: 0.03 }, { ticker: "CVX", weight: 0.03 }, { ticker: "COP", weight: 0.03 }, { ticker: "MPC", weight: 0.03 }, { ticker: "OTHER", weight: 0.86 }],
    };
    const matrix = holdingsOverlap(funds);
    for (const fund of Object.keys(funds)) expect(matrix[fund][fund] * 100).toBeCloseTo(100, 1);
  });

  it("rejects corrupt stored snapshots before metrics render", () => {
    const issue = holdingsSnapshotIssue([
      { ticker: "YUM", weight: 0.9766 },
      { ticker: "DHI", weight: 0.9736 },
      { ticker: "EXPE", weight: 0.8999 },
      { ticker: "CCL", weight: 0.8732 },
      { ticker: "AMZN", weight: 0.2498 },
    ]);
    expect(issue).toContain("weights total 397.31%");
    expect(issue).toContain("largest weight 97.66%");
  });
});
