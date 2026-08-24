import type { CompanyFact, IndustryPayload } from "./types";

/**
 * Revenue tags in resolution order. `Revenues` and the contract-revenue tag are
 * not always equal, so a growth rate must read the same tag in both periods.
 */
export const REVENUE_TAGS = [
  // Most specific first. A bank's revenue is net interest income, a REIT's is
  // rental income, an insurer's is premiums; the contract-revenue tag is an
  // ancillary fee line for all three. Camden Property Trust files no Revenues
  // at all, so that fallback divided $119M of net income by a $5M fee line and
  // printed a 2,333% margin.
  "Revenues",
  "RevenuesNetOfInterestExpense",
  "RealEstateRevenueNet",
  "OperatingLeaseLeaseIncome",
  "PremiumsEarnedNet",
  "InterestAndDividendIncomeOperating",
  "InterestIncomeExpenseNet",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueNet",
] as const;

/**
 * A margin is only reported when it can be true.
 *
 * These are ratios of two figures the company filed, so a value outside a
 * plausible band means the wrong revenue line was matched, not that the company
 * earned 2,333%. Blanking it is honest; printing it is not, and a reader has no
 * way to tell the difference.
 */
/**
 * The only facts a sector page reads.
 *
 * The comps table and the margin trend divide a profit line by a revenue line;
 * nothing on the page touches a balance sheet. Shipping the rest cost 44% of
 * the fact payload and pushed Technology to 19.23 MB, past the 19.07 MB ceiling
 * Vercel puts on a prerendered response, which fails the deploy outright.
 * Company pages load their own facts and still get everything.
 */
export const SECTOR_FACT_METRICS: string[] =
  [...REVENUE_TAGS, "GrossProfit", "OperatingIncomeLoss", "NetIncomeLoss"];

export const MAX_PLAUSIBLE_MARGIN = 1;

export function plausibleMargin(value: number | null): number | null {
  return value === null || Math.abs(value) > MAX_PLAUSIBLE_MARGIN ? null : value;
}
export const revenueTags = new Set<string>(REVENUE_TAGS);

export function latestFactsByTicker(facts: CompanyFact[]): Map<string, CompanyFact[]> {
  const grouped = new Map<string, CompanyFact[]>();
  for (const fact of facts) {
    if (fact.ticker) grouped.set(fact.ticker, [...(grouped.get(fact.ticker) ?? []), fact]);
  }
  return grouped;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator;
}

export type CompsSource = Pick<IndustryPayload, "companyFacts" | "companyMeta">;

/**
 * The end of a fiscal-period label, as a sortable timestamp.
 *
 * Labels are not comparable as strings: FY2024Q2 sorts after CY2026Q2 for
 * reasons that have nothing to do with time. Both arrive in the same filing,
 * because a quarterly report carries the prior-year quarter as its comparative,
 * so they also share a filing date and cannot be separated by one.
 */
export function periodEndValue(period: string): number {
  const quarter = /^[CF]Y(\d{4})Q([1-4])/.exec(period);
  if (quarter) return Date.UTC(Number(quarter[1]), Number(quarter[2]) * 3, 0);
  const annual = /^[CF]Y(\d{4})/.exec(period);
  return annual ? Date.UTC(Number(annual[1]), 12, 0) : 0;
}


export function compsRows(payload: CompsSource) {
  const output = [];
  for (const [ticker, facts] of latestFactsByTicker(payload.companyFacts)) {
    // Which period is "current" was decided by sorting the labels, and the
    // labels are not comparable: FY2026Q2 and CY2026Q2 are different frames,
    // and a string sort puts FY after CY for reasons that have nothing to do
    // with time. A company reporting both showed whichever sorted later, which
    // is how INTC came to be labelled FY2026Q2 carrying another quarter's
    // figures. The newest filing date is the honest answer.
    //
    // Frames ending in I are instants: a balance sheet at a moment, not a
    // quarter of activity. They are valid for Assets and meaningless as the
    // denominator of a margin, so they never stand as the current period.
    const durations = facts.filter((fact) => !fact.fiscal_period.endsWith("I"));
    const filedByPeriod = new Map<string, string>();
    for (const fact of durations) {
      const seen = filedByPeriod.get(fact.fiscal_period);
      if (!seen || fact.filed_date > seen) filedByPeriod.set(fact.fiscal_period, fact.filed_date);
    }
    // Filing date first, because a restatement is the better source for a
    // period. Then the period's own end date: MTD's Q2 filing carries both
    // CY2026Q2 and the FY2024Q2 comparative under one filing date, and a label
    // sort picked the two-year-old one to head the row.
    const periods = [...filedByPeriod.entries()]
      .sort((a, b) => b[1].localeCompare(a[1])
        || periodEndValue(b[0]) - periodEndValue(a[0])
        || b[0].localeCompare(a[0]))
      .map(([period]) => period);
    const current = periods[0];
    if (!current) continue;
    const metric = (period: string | undefined, names: Set<string> | string) => {
      if (!period) return null;
      const fact = facts.find((item) => item.fiscal_period === period
        && (typeof names === "string" ? item.metric === names : names.has(item.metric)));
      return fact?.value ?? null;
    };
    // Resolve one revenue tag per company from the current period, then require
    // the prior period to report that same tag rather than whichever tag the
    // fact array happens to list first.
    const revenueTag = REVENUE_TAGS.find((tag) => facts.some(
      (fact) => fact.fiscal_period === current && fact.metric === tag && fact.value !== null,
    ));
    const revenue = revenueTag ? metric(current, revenueTag) : null;
    // No index-based fallback. `periods[4]` is only the year-ago quarter for a
    // purely quarterly filer, and a wrong growth rate is worse than a blank cell.
    // The comparison must be the same frame family as well as the same quarter:
    // CY2025Q2 is not the prior-year period for a company reporting FY2026Q2.
    const frame = current.slice(0, 2);
    const previousPeriod = periods.find(
      (period) => period !== current
        && period.slice(0, 2) === frame
        && period.slice(-2) === current.slice(-2),
    );
    const previousRevenue = revenueTag && previousPeriod ? metric(previousPeriod, revenueTag) : null;
    output.push({
      ticker,
      period: current,
      filed: filedByPeriod.get(current) ?? null,
      marketCap: payload.companyMeta.find((item) => item.ticker === ticker)?.market_cap ?? null,
      revenueGrowth: revenue !== null && previousRevenue ? revenue / previousRevenue - 1 : null,
      grossMargin: plausibleMargin(ratio(metric(current, "GrossProfit"), revenue)),
      operatingMargin: plausibleMargin(ratio(metric(current, "OperatingIncomeLoss"), revenue)),
      netMargin: plausibleMargin(ratio(metric(current, "NetIncomeLoss"), revenue)),
    });
  }
  return output;
}


export type FactsCoverage = {
  /** Constituents in the fund's latest validated holdings file. */
  constituents: number;
  /** Of those, how many have any reported facts. */
  covered: number;
  /** Share of the fund by weight that those covered companies represent. */
  weightCovered: number;
  /** The largest holding, and whether its facts are present. */
  largest: { ticker: string; weight: number; covered: boolean } | null;
  /** Whether percentiles may be shown at all. */
  reliable: boolean;
};

/**
 * How much of a fund the fundamentals actually cover.
 *
 * The percentile rows are the reason this exists. They were computed over
 * whichever companies happened to have been fetched, and presented as "sector
 * median" without qualification. On Energy that meant a median taken with XOM
 * absent, and XOM is a fifth of the fund. A median of an arbitrary subset is
 * not a sector median, so the page needs to know when it has one.
 */
export function factsCoverage(
  holdings: { constituent_ticker: string; weight: number }[],
  facts: CompanyFact[],
): FactsCoverage {
  const withFacts = new Set(facts.map((fact) => fact.ticker));
  const positions = holdings.filter((row) => row.weight > 0);
  const totalWeight = positions.reduce((sum, row) => sum + row.weight, 0);
  const covered = positions.filter((row) => withFacts.has(row.constituent_ticker));
  const weightCovered = totalWeight > 0
    ? covered.reduce((sum, row) => sum + row.weight, 0) / totalWeight
    : 0;
  const biggest = [...positions].sort((a, b) => b.weight - a.weight)[0] ?? null;
  const largest = biggest
    ? { ticker: biggest.constituent_ticker, weight: biggest.weight, covered: withFacts.has(biggest.constituent_ticker) }
    : null;
  return {
    constituents: positions.length,
    covered: covered.length,
    weightCovered,
    largest,
    // Three quarters of the fund by weight, and the largest holding present.
    // Missing the biggest position moves a median more than missing the tail.
    reliable: positions.length > 0 && weightCovered >= 0.75 && (largest?.covered ?? false),
  };
}


/**
 * Share classes of one company, so exposure is counted once.
 *
 * A fund holding GOOGL at 10.43% and GOOG at 8.35% holds 18.78% of Alphabet,
 * not two companies. Treating them separately understated the AI cloud group by
 * GOOG's 8.35 points, because the group named GOOGL and the second class simply
 * fell outside it. The same applies to FOXA/FOX, NWSA/NWS and BRK.A/BRK.B.
 *
 * Mapped explicitly rather than by stripping a trailing letter: that heuristic
 * would fold unrelated tickers together, and being wrong here silently doubles
 * or halves a weight.
 */
export const SHARE_CLASSES: Record<string, string> = {
  GOOG: "GOOGL", "BRK.A": "BRK.B", "BRK-A": "BRK.B", FOX: "FOXA", NWS: "NWSA",
  "BF.A": "BF.B", "BF-A": "BF.B", "LEN.B": "LEN", "HEI.A": "HEI",
  "UHAL.B": "UHAL", "PARAA": "PARA", "LGF.B": "LGF.A",
};

export function primaryShareClass(ticker: string): string {
  return SHARE_CLASSES[ticker.toUpperCase()] ?? ticker.toUpperCase();
}

/** Combine share classes of the same company into one weighted position. */
export function mergeShareClasses<T extends { constituent_ticker: string; weight: number }>(
  holdings: T[],
): T[] {
  const merged = new Map<string, T>();
  for (const row of holdings) {
    const key = primaryShareClass(row.constituent_ticker);
    const existing = merged.get(key);
    if (existing) {
      merged.set(key, { ...existing, weight: existing.weight + row.weight });
    } else {
      merged.set(key, { ...row, constituent_ticker: key });
    }
  }
  return [...merged.values()].sort((a, b) => b.weight - a.weight);
}
