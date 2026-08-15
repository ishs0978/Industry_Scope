import { holdingsSnapshotIssue, type HoldingWeight } from "./metrics";
import type { IndustryPayload } from "./types";

const asDate = (value: string | null | undefined) => (value ? value.slice(0, 10) : "unavailable");

export function holdingsAt(payload: IndustryPayload, fund: string, end: string) {
  const candidates = payload.holdings.filter((holding) => holding.fund_ticker === fund && asDate(holding.as_of) <= end);
  const snapshot = candidates.map((holding) => asDate(holding.as_of)).sort().at(-1);
  return snapshot ? candidates.filter((holding) => asDate(holding.as_of) === snapshot) : [];
}

export function latestHoldingsFailure(payload: IndustryPayload, fund: string): string | null {
  const perFund = payload.freshness.find((run) => run.source === `holdings:${fund}`);
  if (perFund?.status === "failed") return perFund.error_message ?? "Latest snapshot validation failed.";
  const aggregate = payload.freshness.find((run) => run.source === "holdings");
  const errors = aggregate?.details?.fund_errors;
  if (errors && typeof errors === "object" && fund in errors) return String((errors as Record<string, unknown>)[fund]);
  const meta = payload.etfMeta.find((item) => item.ticker === fund);
  if (meta?.holdings_status === "unsupported") return meta.holdings_error ?? "Issuer feed is not supported.";
  if (meta?.holdings_status === "stale" && meta.holdings_error) return meta.holdings_error;
  return null;
}

/**
 * The one gate on whether a fund's holdings may be shown. The site suppressed a
 * fund whose latest ingest failed while the workbook exported it anyway, so an
 * export could contain rows the site refuses to display.
 */
export function validatedFundHoldings(
  payload: IndustryPayload, fund: string, end: string,
): { rows: IndustryPayload["holdings"]; failure: string | null } {
  const rows = holdingsAt(payload, fund, end);
  const weights: HoldingWeight[] = rows.map((holding) => ({ ticker: holding.constituent_ticker, weight: holding.weight }));
  const failure = latestHoldingsFailure(payload, fund) ?? (rows.length ? holdingsSnapshotIssue(weights) : null);
  return { rows, failure };
}

/** Every holding the site would actually render, across all funds in the payload. */
export function exportableHoldings(payload: IndustryPayload, end: string): IndustryPayload["holdings"] {
  const funds = [...new Set(payload.holdings.map((row) => row.fund_ticker))];
  return funds.flatMap((fund) => {
    const candidate = validatedFundHoldings(payload, fund, end);
    return candidate.failure ? [] : candidate.rows;
  });
}
