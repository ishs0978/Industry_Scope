import type { CompanyFact, IndustryPayload } from "./types";

/**
 * Revenue tags in resolution order. `Revenues` and the contract-revenue tag are
 * not always equal, so a growth rate must read the same tag in both periods.
 */
export const REVENUE_TAGS = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
] as const;
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

export function compsRows(payload: CompsSource) {
  const output = [];
  for (const [ticker, facts] of latestFactsByTicker(payload.companyFacts)) {
    const periods = [...new Set(facts.map((fact) => fact.fiscal_period))].sort().reverse();
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
    const previousPeriod = periods.find(
      (period) => period !== current && period.slice(-2) === current.slice(-2),
    );
    const previousRevenue = revenueTag && previousPeriod ? metric(previousPeriod, revenueTag) : null;
    output.push({
      ticker,
      period: current,
      marketCap: payload.companyMeta.find((item) => item.ticker === ticker)?.market_cap ?? null,
      revenueGrowth: revenue !== null && previousRevenue ? revenue / previousRevenue - 1 : null,
      grossMargin: ratio(metric(current, "GrossProfit"), revenue),
      operatingMargin: ratio(metric(current, "OperatingIncomeLoss"), revenue),
      netMargin: ratio(metric(current, "NetIncomeLoss"), revenue),
    });
  }
  return output;
}
