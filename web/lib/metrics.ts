export type SeriesPoint = { date: string; value: number };
export type DrawdownResult = {
  maxDrawdown: number;
  peakDate: string;
  troughDate: string;
  recoveryDate: string | null;
  durationDays: number;
};

const DAYS_PER_YEAR = 365.25;
const TRADING_DAYS = 252;

function sorted(points: SeriesPoint[]): SeriesPoint[] {
  return [...points]
    .filter((point) => Number.isFinite(point.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function returns(points: SeriesPoint[]): SeriesPoint[] {
  const values = sorted(points);
  const output: SeriesPoint[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1].value;
    if (previous > 0) {
      output.push({ date: values[index].date, value: values[index].value / previous - 1 });
    }
  }
  return output;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleVariance(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values)!;
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
}

function paired(a: SeriesPoint[], b: SeriesPoint[]): [number[], number[]] {
  const bMap = new Map(sorted(b).map((point) => [point.date, point.value]));
  const left: number[] = [];
  const right: number[] = [];
  for (const point of sorted(a)) {
    const other = bMap.get(point.date);
    if (other !== undefined) {
      left.push(point.value);
      right.push(other);
    }
  }
  return [left, right];
}

export function cumulativeReturn(points: SeriesPoint[]): number | null {
  const values = sorted(points);
  if (values.length < 2 || values[0].value <= 0) return null;
  return values.at(-1)!.value / values[0].value - 1;
}

/** Dollar value of a hypothetical investment, using adjusted-close prices. */
export function investmentValue(points: SeriesPoint[], startingBalance = 100): SeriesPoint[] {
  const values = sorted(points);
  if (!values.length || values[0].value <= 0 || startingBalance < 0) return [];
  const initialPrice = values[0].value;
  return values.map((point) => ({
    date: point.date,
    value: startingBalance * (point.value / initialPrice),
  }));
}

export function cagr(points: SeriesPoint[]): number | null {
  const values = sorted(points);
  if (values.length < 2 || values[0].value <= 0 || values.at(-1)!.value <= 0) return null;
  const elapsedDays =
    (Date.parse(values.at(-1)!.date) - Date.parse(values[0].date)) / 86_400_000;
  if (elapsedDays <= 0) return null;
  return (values.at(-1)!.value / values[0].value) ** (DAYS_PER_YEAR / elapsedDays) - 1;
}

export function annualizedVolatility(points: SeriesPoint[]): number | null {
  const variance = sampleVariance(returns(points).map((point) => point.value));
  return variance === null ? null : Math.sqrt(variance * TRADING_DAYS);
}

export function sharpeRatio(points: SeriesPoint[], dgs3mo: SeriesPoint[]): number | null {
  const dailyReturns = returns(points);
  if (dailyReturns.length < 2) return null;
  const rates = sorted(dgs3mo);
  let rateIndex = 0;
  let currentRate: number | null = null;
  const excess: number[] = [];
  for (const point of dailyReturns) {
    while (rateIndex < rates.length && rates[rateIndex].date <= point.date) {
      currentRate = rates[rateIndex].value / 100;
      rateIndex += 1;
    }
    if (currentRate !== null) excess.push(point.value - currentRate / TRADING_DAYS);
  }
  // Both sides are computed from `excess` so the ratio is defined on one series.
  // `excess` can be shorter than `dailyReturns` when the risk-free series starts
  // later, and sampling the two sides over different windows is not a Sharpe.
  const variance = sampleVariance(excess);
  const averageExcess = mean(excess);
  if (variance === null || averageExcess === null || variance === 0) return null;
  return (averageExcess * TRADING_DAYS) / Math.sqrt(variance * TRADING_DAYS);
}

export function maxDrawdown(points: SeriesPoint[]): DrawdownResult | null {
  const values = sorted(points);
  if (values.length < 2) return null;
  let peakIndex = 0;
  let worstPeakIndex = 0;
  let troughIndex = 0;
  let worst = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index].value > values[peakIndex].value) peakIndex = index;
    if (values[peakIndex].value <= 0) continue;
    const drawdown = values[index].value / values[peakIndex].value - 1;
    if (drawdown < worst) {
      worst = drawdown;
      worstPeakIndex = peakIndex;
      troughIndex = index;
    }
  }
  let recoveryDate: string | null = null;
  for (let index = troughIndex + 1; index < values.length; index += 1) {
    if (values[index].value >= values[worstPeakIndex].value) {
      recoveryDate = values[index].date;
      break;
    }
  }
  const endDate = recoveryDate ?? values.at(-1)!.date;
  return {
    maxDrawdown: worst,
    peakDate: values[worstPeakIndex].date,
    troughDate: values[troughIndex].date,
    recoveryDate,
    durationDays: Math.round((Date.parse(endDate) - Date.parse(values[worstPeakIndex].date)) / 86_400_000),
  };
}

export function beta(assetPrices: SeriesPoint[], benchmarkPrices: SeriesPoint[]): number | null {
  const [asset, benchmark] = paired(returns(assetPrices), returns(benchmarkPrices));
  if (asset.length < 2) return null;
  const benchmarkVariance = sampleVariance(benchmark);
  if (!benchmarkVariance) return null;
  const assetMean = mean(asset)!;
  const benchmarkMean = mean(benchmark)!;
  const covariance = asset.reduce(
    (sum, value, index) => sum + (value - assetMean) * (benchmark[index] - benchmarkMean),
    0,
  ) / (asset.length - 1);
  return covariance / benchmarkVariance;
}

export function correlation(a: SeriesPoint[], b: SeriesPoint[]): number | null {
  const [left, right] = paired(a, b);
  if (left.length < 2) return null;
  const leftVariance = sampleVariance(left);
  const rightVariance = sampleVariance(right);
  if (!leftVariance || !rightVariance) return null;
  const leftMean = mean(left)!;
  const rightMean = mean(right)!;
  const covariance = left.reduce(
    (sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean),
    0,
  ) / (left.length - 1);
  return covariance / Math.sqrt(leftVariance * rightVariance);
}

export function rollingVolatility(points: SeriesPoint[], window = 60): SeriesPoint[] {
  const daily = returns(points);
  const output: SeriesPoint[] = [];
  for (let end = window - 1; end < daily.length; end += 1) {
    const variance = sampleVariance(daily.slice(end - window + 1, end + 1).map((point) => point.value));
    if (variance !== null) output.push({ date: daily[end].date, value: Math.sqrt(variance * TRADING_DAYS) });
  }
  return output;
}

export function rollingCorrelation(
  assetPrices: SeriesPoint[],
  benchmarkPrices: SeriesPoint[],
  window = 90,
): SeriesPoint[] {
  const assetReturns = returns(assetPrices);
  const benchmarkReturns = new Map(returns(benchmarkPrices).map((point) => [point.date, point.value]));
  const aligned = assetReturns.filter((point) => benchmarkReturns.has(point.date));
  const output: SeriesPoint[] = [];
  for (let end = window - 1; end < aligned.length; end += 1) {
    const slice = aligned.slice(end - window + 1, end + 1);
    const value = correlation(slice, slice.map((point) => ({ date: point.date, value: benchmarkReturns.get(point.date)! })));
    if (value !== null) output.push({ date: aligned[end].date, value });
  }
  return output;
}

export function relativeStrength(asset: SeriesPoint[], benchmark: SeriesPoint[]): SeriesPoint[] {
  const benchmarkMap = new Map(sorted(benchmark).map((point) => [point.date, point.value]));
  const ratios = sorted(asset)
    .filter((point) => benchmarkMap.has(point.date) && point.value > 0 && benchmarkMap.get(point.date)! > 0)
    .map((point) => ({ date: point.date, value: point.value / benchmarkMap.get(point.date)! }));
  if (!ratios.length) return [];
  const initial = ratios[0].value;
  return ratios.map((point) => ({ date: point.date, value: (point.value / initial) * 100 }));
}

export function calendarYearReturns(points: SeriesPoint[]): Record<string, number> {
  const values = sorted(points);
  if (values.length < 2) return {};
  return Object.fromEntries(
    calendarPeriodReturns(values, values[0].date, values.at(-1)!.date)
      .map((period) => [period.year, period.value]),
  );
}

export type CalendarPeriodReturn = {
  year: string;
  label: string;
  partial: boolean;
  value: number;
};

function monthDay(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

/** Partition one adjusted-close series into multiplicatively reconciling periods. */
export function calendarPeriodReturns(
  points: SeriesPoint[],
  start: string,
  end: string,
): CalendarPeriodReturn[] {
  const values = sorted(points).filter((point) => point.date >= start && point.date <= end);
  if (values.length < 2) return [];
  const factors = new Map<string, number>();
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1].value;
    if (previous <= 0) continue;
    const year = values[index].date.slice(0, 4);
    factors.set(year, (factors.get(year) ?? 1) * (values[index].value / previous));
  }
  const effectiveStart = values[0].date > start ? values[0].date : start;
  const effectiveEnd = values.at(-1)!.date < end ? values.at(-1)!.date : end;
  return [...factors.entries()].map(([year, factor]) => {
    const startsPartial = effectiveStart.slice(0, 4) === year && effectiveStart > `${year}-01-01`;
    const endsPartial = effectiveEnd.slice(0, 4) === year && effectiveEnd < `${year}-12-31`;
    let label = year;
    if (startsPartial && endsPartial) label = `${year} (${monthDay(effectiveStart)}–${monthDay(effectiveEnd)})`;
    else if (startsPartial) label = `${year} (from ${monthDay(effectiveStart)})`;
    else if (endsPartial) label = `${year} (through ${monthDay(effectiveEnd)})`;
    return { year, label, partial: startsPartial || endsPartial, value: factor - 1 };
  });
}

/** HHI on a 0-to-1 scale; callers render it on the standard 0-to-10,000 scale. */
export function concentration(weights: number[]): { hhi: number } {
  const valid = weights.filter((weight) => Number.isFinite(weight) && weight >= 0).sort((a, b) => b - a);
  const total = valid.reduce((sum, weight) => sum + weight, 0);
  const normalized = total > 0 ? valid.map((weight) => weight / total) : [];
  return { hhi: normalized.reduce((sum, weight) => sum + weight ** 2, 0) };
}

export type HoldingWeight = { ticker: string; weight: number };
export function holdingsSnapshotIssue(holdings: HoldingWeight[], concentrated = false): string | null {
  const valid = holdings.filter((holding) => Number.isFinite(holding.weight) && holding.weight >= 0);
  const total = valid.reduce((sum, holding) => sum + holding.weight, 0);
  const top = [...valid].sort((a, b) => b.weight - a.weight).slice(0, 3);
  const issues: string[] = [];
  if (valid.length < 5) issues.push(`only ${valid.length} rows parsed`);
  if (total < 0.98 || total > 1.02) issues.push(`weights total ${(total * 100).toFixed(2)}%`);
  if (!concentrated && top[0]?.weight > 0.60) issues.push(`largest weight ${(top[0].weight * 100).toFixed(2)}%`);
  return issues.length
    ? `Stored snapshot failed validation (${issues.join(", ")}); top rows: ${top.map((row) => `${row.ticker} ${(row.weight * 100).toFixed(2)}%`).join(", ")}.`
    : null;
}

export function holdingsOverlap(funds: Record<string, HoldingWeight[]>): Record<string, Record<string, number>> {
  const entries = Object.entries(funds).map(([ticker, holdings]) => {
    const total = holdings.reduce((sum, holding) => sum + holding.weight, 0);
    return [ticker, total > 0 ? holdings.map((holding) => ({ ...holding, weight: holding.weight / total })) : []] as const;
  });
  const matrix: Record<string, Record<string, number>> = {};
  for (const [tickerA, holdingsA] of entries) {
    matrix[tickerA] = {};
    const mapA = new Map(holdingsA.map((holding) => [holding.ticker, holding.weight]));
    for (const [tickerB, holdingsB] of entries) {
      matrix[tickerA][tickerB] = holdingsB.reduce(
        (sum, holding) => sum + Math.min(mapA.get(holding.ticker) ?? 0, holding.weight),
        0,
      );
    }
  }
  return matrix;
}
