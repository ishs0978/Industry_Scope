"use client";

import { useMemo, useState } from "react";
import {
  Area, AreaChart, Bar, CartesianGrid, ComposedChart, Legend, Line,
  LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  annualizedVolatility, beta, calendarPeriodReturns, concentration, correlation,
  cumulativeReturn, holdingsOverlap, holdingsSnapshotIssue, investmentValue, maxDrawdown, rollingVolatility,
  sharpeRatio, type HoldingWeight, type SeriesPoint,
} from "@/lib/metrics";
import { formatMoney as money, formatNumber as number, formatPercent as percent, formatUnitValue as unitValue } from "@/lib/format";
import type { CompanyFact, IndustryPayload, MacroMeta } from "@/lib/types";
import WorkbookButton from "./WorkbookButton";

const COLORS = ["#1d6b4d", "#143142", "#b97816", "#7d5a91", "#a4463f"];
const DAY = 86_400_000;
const shortDate = (value: string | null | undefined) => value ? value.slice(0, 10) : "unavailable";

type Preset = "1Y" | "3Y" | "5Y" | "10Y" | "Max" | "Custom";

function points(payload: IndustryPayload, ticker: string, start: string, end: string): SeriesPoint[] {
  return payload.prices.filter((row) => row.ticker === ticker && row.date >= start && row.date <= end)
    .map((row) => ({ date: row.date, value: row.adj_close }));
}

function investmentPerformance(payload: IndustryPayload, tickers: string[], start: string, end: string) {
  const rows = new Map<string, Record<string, string | number>>();
  for (const ticker of tickers) {
    for (const point of investmentValue(points(payload, ticker, start, end))) {
      const row = rows.get(point.date) ?? { date: point.date };
      row[ticker] = point.value;
      rows.set(point.date, row);
    }
  }
  return [...rows.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function drawdownSeries(series: SeriesPoint[]) {
  let peak = -Infinity;
  return series.map((point) => {
    peak = Math.max(peak, point.value);
    return { date: point.date, drawdown: peak > 0 ? point.value / peak - 1 : null };
  });
}

function asOfLabel(values: (string | null | undefined)[]): string {
  const valid = values.filter(Boolean).map(String).sort();
  return valid.length ? shortDate(valid.at(-1)) : "unavailable";
}

function holdingsAt(payload: IndustryPayload, fund: string, end: string) {
  const candidates = payload.holdings.filter((holding) => holding.fund_ticker === fund && shortDate(holding.as_of) <= end);
  const snapshot = candidates.map((holding) => shortDate(holding.as_of)).sort().at(-1);
  return snapshot ? candidates.filter((holding) => shortDate(holding.as_of) === snapshot) : [];
}

function latestHoldingsFailure(payload: IndustryPayload, fund: string): string | null {
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

function validatedFundHoldings(payload: IndustryPayload, fund: string, end: string): { rows: IndustryPayload["holdings"]; failure: string | null } {
  const rows = holdingsAt(payload, fund, end);
  const weights: HoldingWeight[] = rows.map((holding) => ({ ticker: holding.constituent_ticker, weight: holding.weight }));
  const failure = latestHoldingsFailure(payload, fund) ?? (rows.length ? holdingsSnapshotIssue(weights) : null);
  return { rows, failure };
}

function ChartEmpty({ source }: { source: string }) {
  return <div className="chart-empty">{source}: no observations are available for this panel.</div>;
}

function EventBands({ events, start, end }: { events: IndustryPayload["events"]; start: string; end: string }) {
  return <>{events.filter((event) => event.start_date <= end && (event.end_date ?? event.start_date) >= start).map((event) =>
    <ReferenceArea key={event.id} x1={event.start_date} x2={event.end_date ?? event.start_date} fill={event.impact === "negative" ? "#a4463f" : "#1d6b4d"} fillOpacity={.09} ifOverflow="extendDomain" />
  )}</>;
}

function SectionHead({ index, title, description, asOf }: { index: string; title: string; description: string; asOf: string }) {
  return <div className="panel-head"><div><div className="panel-index">{index}</div><h2>{title}</h2><p className="panel-description">{description}</p></div><div className="as-of">Table as of<br /><strong>{asOf}</strong></div></div>;
}

function latestFactsByTicker(facts: CompanyFact[]) {
  const grouped = new Map<string, CompanyFact[]>();
  for (const fact of facts) if (fact.ticker) grouped.set(fact.ticker, [...(grouped.get(fact.ticker) ?? []), fact]);
  return grouped;
}

const revenueTags = new Set(["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"]);
function compsRows(payload: IndustryPayload) {
  const output = [];
  for (const [ticker, facts] of latestFactsByTicker(payload.companyFacts)) {
    const periods = [...new Set(facts.map((fact) => fact.fiscal_period))].sort().reverse();
    const current = periods[0];
    if (!current) continue;
    const metric = (period: string | undefined, names: Set<string> | string) => {
      if (!period) return null;
      const fact = facts.find((item) => item.fiscal_period === period && (typeof names === "string" ? item.metric === names : names.has(item.metric)));
      return fact?.value ?? null;
    };
    const revenue = metric(current, revenueTags);
    const previousPeriod = periods.find((period) => period !== current && period.slice(-2) === current.slice(-2)) ?? periods[4];
    const previousRevenue = metric(previousPeriod, revenueTags);
    const ratio = (numerator: number | null, denominator: number | null) => numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator;
    output.push({
      ticker, period: current,
      marketCap: payload.companyMeta.find((item) => item.ticker === ticker)?.market_cap ?? null,
      revenueGrowth: revenue !== null && previousRevenue ? revenue / previousRevenue - 1 : null,
      grossMargin: ratio(metric(current, "GrossProfit"), revenue),
      operatingMargin: ratio(metric(current, "OperatingIncomeLoss"), revenue),
      netMargin: ratio(metric(current, "NetIncomeLoss"), revenue),
    });
  }
  return output;
}

function marginTrend(payload: IndustryPayload) {
  const byPeriod = new Map<string, { gross: number[]; operating: number[]; net: number[] }>();
  for (const facts of latestFactsByTicker(payload.companyFacts).values()) {
    const periods = [...new Set(facts.map((fact) => fact.fiscal_period))];
    for (const period of periods) {
      const metric = (names: Set<string> | string) => facts.find((fact) => fact.fiscal_period === period && (typeof names === "string" ? fact.metric === names : names.has(fact.metric)))?.value ?? null;
      const revenue = metric(revenueTags);
      if (!revenue) continue;
      const group = byPeriod.get(period) ?? { gross: [], operating: [], net: [] };
      const gross = metric("GrossProfit");
      const operating = metric("OperatingIncomeLoss");
      const net = metric("NetIncomeLoss");
      if (gross !== null) group.gross.push(gross / revenue);
      if (operating !== null) group.operating.push(operating / revenue);
      if (net !== null) group.net.push(net / revenue);
      byPeriod.set(period, group);
    }
  }
  return [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-8).map(([period, values]) => ({
    period, gross: quantile(values.gross, .5), operating: quantile(values.operating, .5), net: quantile(values.net, .5),
  }));
}

function quantile(values: (number | null)[], q: number): number | null {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

export default function IndustryDashboard({ initialPayload: payload }: { initialPayload: IndustryPayload }) {
  const tickers = [payload.sector.primary_etf, ...payload.sector.comparison_etfs, "SPY"];
  const compositionFunds = tickers.filter((ticker) => ticker !== "SPY" && payload.etfMeta.find((meta) => meta.ticker === ticker)?.holdings_status !== "unsupported");
  const allDates = payload.prices.map((row) => row.date).sort();
  const maxEnd = allDates.at(-1) ?? new Date().toISOString().slice(0, 10);
  const maxStart = allDates[0] ?? maxEnd;
  const [preset, setPreset] = useState<Preset>("3Y");
  const [customStart, setCustomStart] = useState(maxStart);
  const [customEnd, setCustomEnd] = useState(maxEnd);
  const [fund, setFund] = useState(compositionFunds[0] ?? payload.sector.primary_etf);

  const [start, end] = useMemo(() => {
    if (preset === "Max") return [maxStart, maxEnd];
    if (preset === "Custom") return [customStart, customEnd];
    const years = Number.parseInt(preset, 10);
    const startDate = new Date(Date.parse(maxEnd));
    startDate.setUTCFullYear(startDate.getUTCFullYear() - years);
    return [startDate.toISOString().slice(0, 10), maxEnd];
  }, [preset, customStart, customEnd, maxStart, maxEnd]);

  const primary = points(payload, payload.sector.primary_etf, start, end);
  const spy = points(payload, "SPY", start, end);
  const riskFree = payload.macro.series.filter((row) => row.series_id === "DGS3MO" && row.value !== null).map((row) => ({ date: row.date, value: row.value! }));
  const performance = investmentPerformance(payload, tickers, start, end);
  const primaryInvestment = investmentValue(primary);
  const spyInvestment = investmentValue(spy);
  const drawdown = drawdownSeries(primary);
  const maximumDrawdown = maxDrawdown(primary);
  const selected = validatedFundHoldings(payload, fund, end);
  const selectedHoldings = selected.failure ? [] : selected.rows;
  const holdingsByFund = Object.fromEntries(compositionFunds.flatMap((ticker) => {
    const candidate = validatedFundHoldings(payload, ticker, end);
    return candidate.failure || !candidate.rows.length ? [] : [[ticker, candidate.rows.map((holding) => ({ ticker: holding.constituent_ticker, weight: holding.weight }))]];
  }));
  const overlap = holdingsOverlap(holdingsByFund);
  const concentrationStats = concentration(selectedHoldings.map((holding) => holding.weight));
  const reportedTop10Weight = [...selectedHoldings]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)
    .reduce((sum, holding) => sum + holding.weight, 0);
  const factsAsOfEnd = payload.companyFacts.filter((fact) => fact.filed_date <= end);
  const factsPayload = { ...payload, companyFacts: factsAsOfEnd };
  const comps = compsRows(factsPayload);
  const marginTrends = marginTrend(factsPayload);
  const rollingVol = rollingVolatility(primary);
  const reportedWeightTotal = selectedHoldings.reduce((sum, holding) => sum + holding.weight, 0);
  const largestHolding = [...selectedHoldings].sort((a, b) => b.weight - a.weight)[0];
  const snapshotDate = selected.rows.length ? asOfLabel(selected.rows.map((row) => row.as_of)) : null;
  const snapshotAgeDays = snapshotDate && snapshotDate !== "unavailable"
    ? Math.floor((Date.now() - Date.parse(`${snapshotDate}T00:00:00Z`)) / DAY)
    : null;

  const privateCapital = useMemo(() => {
    const groups = new Map<string, { quarter: string; raised: number | null; count: number; values: number[] }>();
    for (const filing of payload.formD.filter((row) => row.filed_date >= start && row.filed_date <= end)) {
      const parsed = new Date(`${filing.filed_date}T00:00:00Z`);
      const quarter = `${parsed.getUTCFullYear()} Q${Math.floor(parsed.getUTCMonth() / 3) + 1}`;
      const group = groups.get(quarter) ?? { quarter, raised: null, count: 0, values: [] };
      group.count += 1;
      if (filing.amount_sold !== null) { group.values.push(filing.amount_sold); group.raised = (group.raised ?? 0) + filing.amount_sold; }
      groups.set(quarter, group);
    }
    const pricesByQuarter = new Map<string, number>();
    for (const point of primary) {
      const parsed = new Date(`${point.date}T00:00:00Z`);
      pricesByQuarter.set(`${parsed.getUTCFullYear()} Q${Math.floor(parsed.getUTCMonth() / 3) + 1}`, point.value);
    }
    return [...groups.values()].map((group) => ({ ...group, median: quantile(group.values, .5), etfPrice: pricesByQuarter.get(group.quarter) ?? null })).sort((a, b) => a.quarter.localeCompare(b.quarter));
  }, [payload.formD, primary, start, end]);

  const timeline = useMemo(() => [
    ...payload.events.filter((event) => event.start_date <= end && (event.end_date ?? event.start_date) >= start).map((event) => ({ kind: "event" as const, date: event.start_date, item: event })),
    ...payload.headlines.filter((item) => item.published_date.slice(0, 10) >= start && item.published_date.slice(0, 10) <= end).map((item) => ({ kind: "headline" as const, date: item.published_date, item })),
  ].sort((a, b) => b.date.localeCompare(a.date)), [payload.events, payload.headlines, start, end]);

  return <main>
    <section className="industry-hero">
      <div className="eyebrow">{payload.sector.primary_etf} · NAICS {payload.sector.naics_code}</div>
      <h1>{payload.sector.name}</h1>
      <p>One synchronized view across public markets, business fundamentals, private financing, operating indicators, and sourced events.</p>
      <div className="hero-meta">{tickers.map((ticker) => <span className="pill" key={ticker}>{ticker}{ticker === payload.sector.primary_etf ? " · primary" : ""}</span>)}</div>
    </section>

    <div className="range-bar" aria-label="Date range">
      {(["1Y", "3Y", "5Y", "10Y", "Max"] as Preset[]).map((value) => <button className={preset === value ? "active" : ""} key={value} onClick={() => setPreset(value)}>{value}</button>)}
      <button className={preset === "Custom" ? "active" : ""} onClick={() => setPreset("Custom")}>Custom</button>
      {preset === "Custom" && <><input aria-label="Start date" type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /><input aria-label="End date" type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></>}
      <WorkbookButton payload={payload} start={start} end={end} />
    </div>

    {payload.errors.length > 0 && <details className="source-errors-summary">
      <summary><strong>{payload.errors.length} data {payload.errors.length === 1 ? "source is" : "sources are"} temporarily unavailable</strong> · failed data is automatically suppressed</summary>
      <div className="source-errors-list">{payload.errors.map((error) => <div key={`${error.source}:${error.reason}`}><strong>{error.source}</strong>: {error.reason}</div>)}</div>
    </details>}
    <div className="freshness">{payload.freshness.map((item) => <div className={`freshness-item ${item.status === "failed" ? "failed" : ""}`} key={item.source}><strong>{item.source}</strong> · {item.details.skipped ? "skipped (not due)" : item.status} · {shortDate(item.finished_at ?? item.started_at)}</div>)}</div>

    <section className="panel" id="performance">
      <SectionHead index="01" title="Performance" description="Adjusted-close performance and risk metrics recalculate in the browser whenever the date range changes." asOf={asOfLabel(payload.prices.map((row) => row.date))} />
      <div className="insight-grid">
        <div className="insight-card"><div className="insight-label">What happened</div><p><strong>$100 invested in {payload.sector.primary_etf}</strong> became <strong>{primaryInvestment.length ? money(primaryInvestment.at(-1)!.value) : "—"}</strong> over the selected window.</p>{spyInvestment.length > 0 && <p className="insight-detail">The same $100 in SPY became {money(spyInvestment.at(-1)!.value)}.</p>}</div>
        <div className="insight-card"><div className="insight-label">How to read the risk</div><p>Volatility describes day-to-day variability. Beta compares moves with SPY, where 1.00 means equal sensitivity.</p>{maximumDrawdown && <p className="insight-detail">Largest peak-to-trough decline: {percent(maximumDrawdown.maxDrawdown)}.</p>}</div>
      </div>
      <div className="stat-grid">
        <div className="stat"><div className="stat-label">Cumulative return</div><div className="stat-value">{percent(cumulativeReturn(primary))}</div></div>
        <div className="stat"><div className="stat-label">Annualized volatility</div><div className="stat-value">{percent(annualizedVolatility(primary))}</div></div>
        <div className="stat"><div className="stat-label">Beta vs. SPY</div><div className="stat-value">{number(beta(primary, spy))}</div></div>
        <div className="stat"><div className="stat-label">Sharpe · DGS3MO</div><div className="stat-value">{number(sharpeRatio(primary, riskFree))}</div></div>
      </div>
      <div className="chart-shell"><div className="chart-title">Value of $100 invested</div>{performance.length ? <ResponsiveContainer width="100%" height={320}><LineChart data={performance}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="date" minTickGap={48} tick={{ fontSize: 10 }} /><YAxis tickFormatter={(value) => money(Number(value))} tick={{ fontSize: 10 }} width={72} /><Tooltip formatter={(value, name) => [money(Number(value)), String(name)]} /><Legend /><EventBands events={payload.events} start={start} end={end} />{tickers.map((ticker, index) => <Line key={ticker} dataKey={ticker} dot={false} connectNulls stroke={COLORS[index % COLORS.length]} strokeWidth={ticker === payload.sector.primary_etf ? 2.4 : 1.3} />)}</LineChart></ResponsiveContainer> : <ChartEmpty source="Prices" />}</div>
      <div className="chart-grid">
        <div className="chart-shell"><div className="chart-title">Drawdown</div>{drawdown.length ? <ResponsiveContainer width="100%" height={260}><AreaChart data={drawdown}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="date" minTickGap={40} tick={{ fontSize: 10 }} /><YAxis tickFormatter={(value) => `${(Number(value) * 100).toFixed(2)}%`} tick={{ fontSize: 10 }} /><Tooltip formatter={(value) => percent(Number(value))} /><Area dataKey="drawdown" stroke="#a4463f" fill="#a4463f" fillOpacity={.22} /></AreaChart></ResponsiveContainer> : <ChartEmpty source="Prices" />}</div>
        <div className="chart-shell"><div className="chart-title">Rolling 60-day annualized volatility</div>{rollingVol.length ? <ResponsiveContainer width="100%" height={260}><LineChart data={rollingVol}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="date" minTickGap={40} tick={{ fontSize: 10 }} /><YAxis tickFormatter={(value) => `${(Number(value) * 100).toFixed(2)}%`} tick={{ fontSize: 10 }} /><Tooltip formatter={(value) => percent(Number(value))} /><Line dataKey="value" dot={false} stroke="#b97816" /></LineChart></ResponsiveContainer> : <ChartEmpty source="Prices" />}</div>
      </div>
      {maximumDrawdown && <p className="panel-description">Maximum drawdown {percent(maximumDrawdown.maxDrawdown)} from {maximumDrawdown.peakDate} to {maximumDrawdown.troughDate}; {maximumDrawdown.recoveryDate ? `recovered ${maximumDrawdown.recoveryDate}` : "not recovered in the selected window"} ({maximumDrawdown.durationDays} days).</p>}
      <div className="hero-meta">{payload.events.filter((event) => event.start_date <= end && (event.end_date ?? event.start_date) >= start).map((event) => <a className="pill" href={event.source_url ?? undefined} title={event.blurb || "Editorial description pending human review"} key={event.id}>{event.title}</a>)}</div>
      <CalendarTable payload={payload} tickers={tickers} start={start} end={end} />
    </section>

    <section className="panel" id="composition">
      <SectionHead index="02" title="Composition" description="Latest issuer-published snapshots. Unsupported issuers are hidden rather than represented by empty portfolios." asOf={asOfLabel(selected.rows.map((row) => row.as_of))} />
      {compositionFunds.length > 0 && <select className="fund-selector" value={fund} onChange={(event) => setFund(event.target.value)}>{compositionFunds.map((ticker) => <option key={ticker}>{ticker}</option>)}</select>}
      {selected.failure ? <div className="source-error">Holdings · {fund} · {selected.failure}</div> : <>
      {snapshotAgeDays !== null && snapshotAgeDays > 7 && <div className="source-error">Holdings · {fund} · stale snapshot dated {snapshotDate}.</div>}
      <div className="insight-grid">
        <div className="insight-card"><div className="insight-label">What the fund owns</div><p><strong>{fund}</strong> reports {selectedHoldings.length.toLocaleString()} holdings covering <strong>{percent(reportedWeightTotal)}</strong> of portfolio weight.{largestHolding && <> Its largest position is <strong>{largestHolding.constituent_ticker} at {percent(largestHolding.weight)}</strong>.</>}</p></div>
        <div className="insight-card"><div className="insight-label">Why 100% appears</div><p>Portfolio weights are slices of one whole, so a complete snapshot totals approximately 100%. In overlap, <strong>Self</strong> means a fund compared with itself and is always 100% by definition.</p></div>
      </div>
      <div className="stat-grid">
        <div className="stat"><div className="stat-label">Top-10 reported weight</div><div className="stat-value">{selectedHoldings.length ? percent(reportedTop10Weight) : "—"}</div></div>
        <div className="stat"><div className="stat-label">HHI</div><div className="stat-value">{selectedHoldings.length ? Math.round(concentrationStats.hhi * 10_000).toLocaleString() : "—"}</div></div>
        <div className="stat"><div className="stat-label">Expense ratio</div><div className="stat-value">{payload.etfMeta.find((item) => item.ticker === fund)?.expense_ratio === null ? "Unavailable from Yahoo Finance" : percent(payload.etfMeta.find((item) => item.ticker === fund)?.expense_ratio ?? null, 2)}</div></div>
        <div className="stat"><div className="stat-label">Assets</div><div className="stat-value">{payload.etfMeta.find((item) => item.ticker === fund)?.aum ? money(payload.etfMeta.find((item) => item.ticker === fund)!.aum!) : "—"}</div></div>
      </div>
      {selectedHoldings.length ? <div className="data-table-wrap"><table><thead><tr><th>Holding</th><th>Ticker</th><th>Weight</th></tr></thead><tbody>{selectedHoldings.slice(0, 25).map((holding) => <tr key={holding.constituent_ticker}><td>{holding.constituent_name ?? holding.constituent_ticker}</td><td>{holding.constituent_ticker}</td><td>{percent(holding.weight, 2)}</td></tr>)}</tbody></table></div> : <div className="source-error">Holdings · {payload.etfMeta.find((item) => item.ticker === fund)?.holdings_error ?? "No issuer snapshot is available."}</div>}
      <OverlapMatrix matrix={overlap} funds={Object.keys(holdingsByFund)} />
      </>}
    </section>

    <section className="panel" id="fundamentals">
      <SectionHead index="03" title="Fundamentals" description="Reported SEC XBRL facts only. Missing tags remain blank; quartiles use available observations." asOf={asOfLabel(payload.companyFacts.map((row) => row.filed_date))} />
      {comps.length ? <CompsTable rows={comps} /> : <div className="source-error">SEC XBRL: no company facts are available for the latest primary-fund constituents.</div>}
      {marginTrends.length > 0 && <div className="chart-shell" style={{ marginTop: 16 }}><div className="chart-title">Sector median margin trend · last eight reported periods</div><ResponsiveContainer width="100%" height={300}><LineChart data={marginTrends}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="period" tick={{ fontSize: 10 }} /><YAxis tickFormatter={(value) => `${(Number(value) * 100).toFixed(2)}%`} tick={{ fontSize: 10 }} /><Tooltip formatter={(value) => percent(Number(value))} /><Legend /><Line dataKey="gross" name="Gross margin" stroke="#1d6b4d" /><Line dataKey="operating" name="Operating margin" stroke="#143142" /><Line dataKey="net" name="Net margin" stroke="#b97816" /></LineChart></ResponsiveContainer></div>}
    </section>

    <section className="panel" id="private-capital">
      <SectionHead index="04" title="Private capital" description="Reported Form D amounts by filing quarter. Filings without reported amounts contribute to counts, not dollars." asOf={asOfLabel(payload.formD.map((row) => row.filed_date))} />
      <div className="stat-grid"><div className="stat"><div className="stat-label">Filings in range</div><div className="stat-value">{privateCapital.reduce((sum, row) => sum + row.count, 0).toLocaleString()}</div></div><div className="stat"><div className="stat-label">Reported amount sold</div><div className="stat-value">{privateCapital.some((row) => row.raised !== null) ? money(privateCapital.reduce((sum, row) => sum + (row.raised ?? 0), 0)) : "—"}</div></div><div className="stat"><div className="stat-label">Median reported raise</div><div className="stat-value">{quantile(payload.formD.filter((row) => row.amount_sold !== null && row.filed_date >= start && row.filed_date <= end).map((row) => row.amount_sold), .5) !== null ? money(quantile(payload.formD.filter((row) => row.amount_sold !== null && row.filed_date >= start && row.filed_date <= end).map((row) => row.amount_sold), .5)!) : "—"}</div></div><div className="stat"><div className="stat-label">Mapped SIC sector</div><div className="stat-value">{payload.sector.name}</div></div></div>
      <div className="chart-shell">{privateCapital.length ? <ResponsiveContainer width="100%" height={320}><ComposedChart data={privateCapital}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="quarter" tick={{ fontSize: 10 }} /><YAxis yAxisId="capital" tickFormatter={(value) => money(Number(value))} tick={{ fontSize: 10 }} /><YAxis yAxisId="price" orientation="right" tickFormatter={(value) => `$${number(Number(value))}`} tick={{ fontSize: 10 }} /><Tooltip formatter={(value, name) => [String(name).includes("amount sold") ? money(Number(value)) : `$${number(Number(value))}`, String(name)]} /><Legend /><Bar yAxisId="capital" dataKey="raised" name="Form D amount sold" fill="#1d6b4d" /><Line yAxisId="price" dataKey="etfPrice" name={`${payload.sector.primary_etf} quarter-end price`} dot={false} stroke="#b97816" /></ComposedChart></ResponsiveContainer> : <ChartEmpty source="SEC Form D" />}</div>
    </section>

    <section className="panel" id="macro">
      <SectionHead index="05" title="Macro & operations" description="Sector-relevant FRED, EIA, and BLS raw series aligned to the same date window." asOf={asOfLabel(payload.macro.meta.map((row) => row.as_of))} />
      <div className="small-multiples">{payload.macro.meta.map((meta) => <MacroChart key={meta.series_id} meta={meta} points={payload.macro.series.filter((point) => point.series_id === meta.series_id && point.date >= start && point.date <= end && point.value !== null).map((point) => ({ date: point.date, value: point.value! }))} />)}</div>
      {!payload.macro.meta.length && <div className="source-error">Macro sources: no metadata is available.</div>}
    </section>

    <section className="panel" id="timeline">
      <SectionHead index="06" title="Timeline" description="Quantitative GDELT activity above; human-curated events and verbatim NYT headlines below." asOf={asOfLabel([...payload.newsVolume.map((row) => row.date), ...payload.headlines.map((row) => row.published_date)])} />
      <div className="chart-shell">{payload.newsVolume.length ? <ResponsiveContainer width="100%" height={300}><ComposedChart data={payload.newsVolume.filter((row) => row.date >= start && row.date <= end)}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="date" minTickGap={40} tick={{ fontSize: 10 }} /><YAxis yAxisId="volume" tickFormatter={(value) => number(Number(value))} tick={{ fontSize: 10 }} /><YAxis yAxisId="tone" orientation="right" tickFormatter={(value) => number(Number(value))} tick={{ fontSize: 10 }} /><Tooltip formatter={(value, name) => [`${number(Number(value))}${String(name) === "article_volume" ? " articles" : " tone points"}`, String(name)]} /><Bar yAxisId="volume" dataKey="article_volume" fill="#b7e55c" /><Line yAxisId="tone" dataKey="avg_tone" dot={false} stroke="#143142" /></ComposedChart></ResponsiveContainer> : <ChartEmpty source="GDELT" />}</div>
      <div className="timeline-list">{timeline.map((entry) => entry.kind === "event" ? <article className="timeline-item event" key={`e:${entry.item.id}`}><div className="timeline-date">{entry.item.start_date}{entry.item.end_date && entry.item.end_date !== entry.item.start_date ? ` – ${entry.item.end_date}` : ""} · CURATED EVENT</div><h3>{entry.item.title}</h3>{entry.item.blurb ? <p>{entry.item.blurb}</p> : <p>Editorial description pending human review.</p>}{entry.item.source_url && <a href={entry.item.source_url} target="_blank" rel="noreferrer">Source ↗</a>}</article> : <article className="timeline-item" key={`h:${entry.item.id}`}><div className="timeline-date">{shortDate(entry.item.published_date)} · {entry.item.source}{entry.item.section ? ` · ${entry.item.section}` : ""}</div><h3><a href={entry.item.url} target="_blank" rel="noreferrer">{entry.item.headline} ↗</a></h3>{entry.item.abstract && <p>{entry.item.abstract}</p>}</article>)}</div>
      {!timeline.length && <div className="source-error">Timeline sources: no events or headlines are available for this window.</div>}
    </section>
  </main>;
}

function CalendarTable({ payload, tickers, start, end }: { payload: IndustryPayload; tickers: string[]; start: string; end: string }) {
  const periods = Object.fromEntries(tickers.map((ticker) => [
    ticker,
    calendarPeriodReturns(
      payload.prices.filter((row) => row.ticker === ticker).map((row) => ({ date: row.date, value: row.adj_close })),
      start,
      end,
    ),
  ]));
  const years = [...new Set(Object.values(periods).flatMap((items) => items.map((item) => item.year)))].sort();
  if (!years.length) return null;
  const labels = Object.fromEntries(years.map((year) => {
    const entries = tickers.flatMap((ticker) => periods[ticker].filter((item) => item.year === year));
    return [year, entries.find((item) => item.partial)?.label ?? year];
  }));
  return <div className="data-table-wrap"><table><thead><tr><th>ETF</th>{years.map((year) => <th key={year}>{labels[year]}</th>)}</tr></thead><tbody>{tickers.map((ticker) => <tr key={ticker}><td>{ticker}</td>{years.map((year) => { const value = periods[ticker].find((item) => item.year === year)?.value; return <td className={value === undefined ? "" : value >= 0 ? "positive-cell" : "negative-cell"} key={year}>{value === undefined ? "—" : percent(value)}</td>; })}</tr>)}</tbody></table></div>;
}

function OverlapMatrix({ matrix, funds }: { matrix: Record<string, Record<string, number>>; funds: string[] }) {
  const valid = funds.filter((fund) => Object.keys(matrix[fund] ?? {}).length && matrix[fund][fund] > 0);
  if (valid.length < 2) return null;
  let best: [string, string, number] | null = null;
  valid.forEach((a, i) => valid.slice(i + 1).forEach((b) => { const value = matrix[a][b]; if (!best || value > best[2]) best = [a, b, value]; }));
  return <div style={{ marginTop: 28 }}><div className="chart-title">Pairwise holdings overlap</div>{best && <p className="panel-description">{best[0]} and {best[1]} share {(best[2] * 100).toFixed(2)}% of holdings by weight. Diagonal cells are self-comparisons.</p>}<div className="overlap-grid" style={{ gridTemplateColumns: `80px repeat(${valid.length}, minmax(54px, 1fr))` }}><span />{valid.map((fund) => <strong key={fund}>{fund}</strong>)}{valid.flatMap((row) => [<strong key={`${row}:label`}>{row}</strong>, ...valid.map((column) => { const value = matrix[row][column]; const self = row === column; return <div className={`overlap-cell${self ? " self" : ""}`} title={self ? "Self-overlap is 100% by definition" : `${row} and ${column}: ${percent(value)}`} key={`${row}:${column}`} style={{ background: `rgba(29,107,77,${.08 + Math.min(value, 1) * .7})` }}>{self ? "Self" : percent(value)}</div>; })])}</div></div>;
}

type CompRow = ReturnType<typeof compsRows>[number];
function CompsTable({ rows }: { rows: CompRow[] }) {
  const [sortKey, setSortKey] = useState<keyof CompRow>("marketCap");
  const ordered = [...rows].sort((a, b) => ((b[sortKey] as number | null) ?? -Infinity) - ((a[sortKey] as number | null) ?? -Infinity));
  const metrics: (keyof CompRow)[] = ["marketCap", "revenueGrowth", "grossMargin", "operatingMargin", "netMargin"];
  const summaries = [
    { ticker: "Sector 25th percentile", q: .25 }, { ticker: "Sector median", q: .5 }, { ticker: "Sector 75th percentile", q: .75 },
  ];
  return <div className="data-table-wrap"><table><thead><tr><th onClick={() => setSortKey("ticker")}>Company</th><th>Period</th>{metrics.map((metric) => <th key={metric} onClick={() => setSortKey(metric)}>{metric.replace(/([A-Z])/g, " $1")}</th>)}</tr></thead><tbody>{summaries.map((summary) => <tr key={summary.ticker}><td><strong>{summary.ticker}</strong></td><td>—</td>{metrics.map((metric) => { const value = quantile(rows.map((row) => typeof row[metric] === "number" ? row[metric] as number : null), summary.q); return <td key={metric}>{metric === "marketCap" ? value === null ? "—" : money(value) : percent(value)}</td>; })}</tr>)}{ordered.map((row) => <tr key={row.ticker}><td>{row.ticker}</td><td>{row.period}</td><td>{row.marketCap === null ? "—" : money(row.marketCap)}</td><td>{percent(row.revenueGrowth)}</td><td>{percent(row.grossMargin)}</td><td>{percent(row.operatingMargin)}</td><td>{percent(row.netMargin)}</td></tr>)}</tbody></table></div>;
}

function MacroChart({ meta, points }: { meta: MacroMeta; points: SeriesPoint[] }) {
  return <div className="chart-shell"><div className="chart-title">{meta.label}</div>{points.length ? <ResponsiveContainer width="100%" height={220}><LineChart data={points}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="date" minTickGap={40} tick={{ fontSize: 9 }} /><YAxis tickFormatter={(value) => number(Number(value))} tick={{ fontSize: 9 }} /><Tooltip formatter={(value) => unitValue(Number(value), meta.units)} /><Line dataKey="value" dot={false} stroke="#1d6b4d" /></LineChart></ResponsiveContainer> : <ChartEmpty source={meta.source} />}<div className="as-of" style={{ textAlign: "left" }}>{meta.source} · {meta.units ?? "units unavailable"}<br />Release: {shortDate(meta.last_release_date)} · Ingest: {shortDate(meta.as_of)}</div></div>;
}
