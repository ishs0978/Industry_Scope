import { describe, expect, it } from "vitest";
import {
  annualizedVolatility, beta, cagr, calendarYearReturns, concentration,
  correlation, cumulativeReturn, holdingsOverlap, maxDrawdown, relativeStrength,
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
    expect(returns[2024]).toBeCloseTo(-0.25);
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
});
