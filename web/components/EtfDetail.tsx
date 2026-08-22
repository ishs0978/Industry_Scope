"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { DetailHead, Heading, Stat, Unavailable } from "@/components/DetailUi";
import {
  annualizedVolatility, beta, cagr, calendarPeriodReturns, concentration,
  cumulativeReturn, investmentValue, maxDrawdown, sharpeRatio, type SeriesPoint,
} from "@/lib/metrics";
import { formatMoney, formatNumber, formatPercent, formatPrice, stampDate } from "@/lib/format";
import type { EtfPayload } from "@/lib/types";

const money = (value: number | null) => (value === null ? "—" : formatMoney(value));
const percent = (value: number | null) => formatPercent(value);
const RANGES = ["1", "3", "5", "Max"] as const;

const DEFINITIONS: Record<string, string> = {
  "Total return": "Price change plus dividends, assuming every dividend was reinvested the day it was paid.",
  "Annualized return": "The constant yearly rate that would have produced the same total return over this window.",
  "Volatility": "How much the fund moved day to day, scaled to an annual figure. Higher means a bumpier ride, not a worse one.",
  "Sharpe ratio": "Return earned above what a 3-month Treasury would have paid, divided by how much the fund bounced around to earn it.",
  "Beta vs S&P 500": "How much the fund moved when the market moved. One means it tracked the market, above one means it amplified it.",
  "Max drawdown": "The worst peak-to-trough fall inside this window, and how long it took to get back if it did.",
  "Expense ratio": "The annual fee the fund charges, taken out of returns automatically.",
  "Assets": "Total money invested in the fund.",
  "Concentration": "HHI squares every holding's weight and adds them up, on a 0 to 10,000 scale. One stock scores 10,000; a hundred equal stocks score 100.",
  "Top 10 holdings": "The share of the portfolio sitting in its ten largest positions.",
};

export default function EtfDetail({ payload }: { payload: EtfPayload }) {
  const [preset, setPreset] = useState<(typeof RANGES)[number]>("5");

  const series = useMemo(
    () => payload.prices.map((row) => ({ date: row.date, value: row.adj_close })),
    [payload.prices],
  );
  const [start, end] = useMemo(() => {
    const last = series.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
    if (preset === "Max") return [series[0]?.date ?? last, last];
    const from = new Date(`${last}T00:00:00Z`);
    from.setUTCFullYear(from.getUTCFullYear() - Number(preset));
    return [from.toISOString().slice(0, 10), last];
  }, [preset, series]);

  const window = (points: SeriesPoint[]) => points.filter((p) => p.date >= start && p.date <= end);
  const fund = window(series);
  const benchmark = window(payload.benchmark.map((row) => ({ date: row.date, value: row.adj_close })));
  const riskFree = payload.riskFree
    .filter((row) => row.value !== null)
    .map((row) => ({ date: row.date, value: row.value! }));

  const growth = useMemo(() => {
    const fundValue = investmentValue(fund, 10_000);
    const benchValue = new Map(investmentValue(benchmark, 10_000).map((p) => [p.date, p.value]));
    return fundValue.map((point) => ({
      date: point.date, fund: point.value, benchmark: benchValue.get(point.date) ?? null,
    }));
  }, [fund, benchmark]);

  const drawdown = maxDrawdown(fund);
  const years = useMemo(() => calendarPeriodReturns(fund, start, end), [fund, start, end]);
  const top = payload.holdings.slice(0, 15);
  const topTen = payload.holdings.slice(0, 10).reduce((sum, row) => sum + row.weight, 0);
  const hhi = concentration(payload.holdings.map((row) => row.weight)).hhi * 10_000;
  const asOf = payload.prices.at(-1)?.date ?? null;

  if (payload.errors.length) {
    return <main><section className="panel">
      <Unavailable>{payload.errors[0].source}: {payload.errors[0].reason}</Unavailable>
    </section></main>;
  }

  return <main>
    <section className="industry-hero">
      <div className="eyebrow">
        <Link href={`/industry/${payload.sectorSlug}`}>← {payload.sectorName}</Link>
        {payload.isPrimary ? " · primary fund" : " · comparison fund"}
      </div>
      <h1>{payload.ticker}</h1>
      <p className="panel-description">
        {payload.meta?.name ?? "Fund name unavailable"}
        {payload.meta?.issuer ? ` · ${payload.meta.issuer}` : ""}
        {asOf ? ` · priced through ${asOf}` : ""}
      </p>
      <div className="chip-row">
        {RANGES.map((option) => (
          <button className={`chip${preset === option ? " active" : ""}`} key={option}
            onClick={() => setPreset(option)}>
            {option === "Max" ? "Max" : `${option}Y`}
          </button>
        ))}
      </div>
    </section>

    <section className="panel">
      <DetailHead eyebrow="01" title="How it has performed" subtitle="Total return, dividends reinvested"
        description="Every figure here is measured over the range selected above, from this fund's own adjusted closes. Risk figures are measured against the S&P 500 and 3-month Treasury over the same range."
        asOf={stampDate(asOf)} />
      <div className="stat-grid">
        <Stat label="Total return" value={percent(cumulativeReturn(fund))} definition={DEFINITIONS["Total return"]} />
        <Stat label="Annualized return" term="CAGR" value={percent(cagr(fund))} definition={DEFINITIONS["Annualized return"]} />
        <Stat label="Volatility" term="Annualized" value={percent(annualizedVolatility(fund))} definition={DEFINITIONS["Volatility"]} />
        <Stat label="Sharpe ratio" term="vs 3-month Treasury" value={formatNumber(sharpeRatio(fund, riskFree))} definition={DEFINITIONS["Sharpe ratio"]} />
      </div>
      <div className="stat-grid">
        <Stat label="Beta vs S&P 500" value={formatNumber(beta(fund, benchmark))} definition={DEFINITIONS["Beta vs S&P 500"]} />
        <Stat label="Max drawdown" term={drawdown ? `${drawdown.peakDate} to ${drawdown.troughDate}` : undefined}
          value={drawdown ? percent(drawdown.maxDrawdown) : "—"} definition={DEFINITIONS["Max drawdown"]} />
        <Stat label="Expense ratio" term="Annual fee" value={percent(payload.meta?.expense_ratio ?? null)} definition={DEFINITIONS["Expense ratio"]} />
        <Stat label="Assets" term="Fund total" value={money(payload.meta?.aum ?? null)} definition={DEFINITIONS["Assets"]} />
      </div>

      <div className="chart-shell">
        <Heading title="What $10,000 would have become" term={`${payload.ticker} against the S&P 500`} />
        {growth.length > 1 ? <ResponsiveContainer width="100%" height={320}>
          <LineChart data={growth}>
            <CartesianGrid stroke="#e4e6df" vertical={false} />
            <XAxis dataKey="date" minTickGap={48} tick={{ fontSize: 10 }} />
            <YAxis tickFormatter={(value) => money(Number(value))} tick={{ fontSize: 10 }} />
            <Tooltip formatter={(value) => money(Number(value))} />
            <Legend />
            <Line dataKey="fund" name={payload.ticker} dot={false} stroke="#1d6b4d" />
            <Line dataKey="benchmark" name="SPY" dot={false} stroke="#b97816" />
          </LineChart>
        </ResponsiveContainer> : <Unavailable>No prices for {payload.ticker} inside this range.</Unavailable>}
        <p className="provenance">Both lines start at $10,000 on the first day of the range, which is what makes their paths comparable regardless of share price.</p>
      </div>

      {years.length > 0 && <div className="chart-shell">
        <Heading title="Return by calendar year" term="Total return per year in range" />
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={years}>
            <CartesianGrid stroke="#e4e6df" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis tickFormatter={(value) => percent(Number(value))} tick={{ fontSize: 10 }} />
            <Tooltip formatter={(value) => percent(Number(value))} />
            <Bar dataKey="value" name="Total return" fill="#1d6b4d" />
          </BarChart>
        </ResponsiveContainer>
        <p className="provenance">A year the range only partly covers is labelled with the dates it actually spans, so a short bar is not mistaken for a weak year.</p>
      </div>}
    </section>

    <section className="panel">
      <DetailHead eyebrow="02" title="What it holds" subtitle="Latest validated composition"
        description="Weights come from the issuer's own published holdings file. A snapshot is used only when it parses to a full portfolio, so a fund shows its real composition or none at all."
        asOf={stampDate(payload.holdings[0]?.as_of ?? null)} />
      {payload.holdings.length ? <>
        <div className="stat-grid">
          <Stat label="Holdings" term="Positions in file" value={payload.holdings.length.toLocaleString()} />
          <Stat label="Top 10 holdings" term="Share of portfolio" value={percent(topTen)} definition={DEFINITIONS["Top 10 holdings"]} />
          <Stat label="Concentration" term="HHI, 0 to 10,000" value={formatNumber(hhi)} definition={DEFINITIONS["Concentration"]} />
          <Stat label="Largest position" term={payload.holdings[0]?.constituent_ticker}
            value={percent(payload.holdings[0]?.weight ?? null)} />
        </div>
        <div className="data-table-wrap"><table>
          <thead><tr><th>Company</th><th>Name</th><th>Weight</th></tr></thead>
          <tbody>{top.map((row) => <tr key={row.constituent_ticker}>
            <td><Link href={`/company/${row.constituent_ticker}`}>{row.constituent_ticker}</Link></td>
            <td>{row.constituent_name ?? "—"}</td>
            <td>{percent(row.weight)}</td>
          </tr>)}</tbody>
        </table></div>
        {payload.holdings.length > top.length
          && <p className="provenance">Showing the {top.length} largest of {payload.holdings.length.toLocaleString()} positions. Company names link through to what each one reported.</p>}
      </> : <Unavailable>
        Composition is unavailable for {payload.ticker}
        {payload.meta?.holdings_status ? ` (${payload.meta.holdings_status})` : ""}
        . Holdings feeds are implemented per issuer, and a fund whose file cannot be parsed is left blank rather than estimated.
      </Unavailable>}
      {payload.peers.length > 0 && <p className="provenance">
        Compared on the sector page against {payload.peers.map((peer, index) => <span key={peer}>
          {index > 0 ? ", " : ""}<Link href={`/etf/${peer}`}>{peer}</Link>
        </span>)}.
      </p>}
    </section>
  </main>;
}
