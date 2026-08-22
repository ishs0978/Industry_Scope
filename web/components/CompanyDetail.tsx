"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, LineChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { DetailHead, Heading, Stat, Unavailable } from "@/components/DetailUi";
import { calendarPeriodReturns, cumulativeReturn, investmentValue, type SeriesPoint } from "@/lib/metrics";
import { compsRows } from "@/lib/comps";
import { formatMoney, formatNumber, formatPercent, formatPrice, stampDate } from "@/lib/format";
import type { CompanyPayload } from "@/lib/types";

const money = (value: number | null) => (value === null ? "—" : formatMoney(value));
const percent = (value: number | null) => formatPercent(value);
const RANGES = ["1", "3", "5"] as const;

const DEFINITIONS: Record<string, string> = {
  "Market cap": "What the whole company is worth at today's share price. Current, not aligned to the range selected.",
  "Trailing P/E": "Share price divided by the last twelve months of earnings per share. Blank when the company has no positive earnings to divide by.",
  "Forward P/E": "Share price divided by what analysts expect the company to earn next year. An expectation, not a reported figure.",
  "Price to book": "Share price against the accounting value of the company's net assets.",
  "Dividend yield": "Annual dividend as a share of the current price.",
  "Analyst target": "The average price analysts covering this company expect. An opinion with a date on it, and the count says how many opinions it averages.",
  "Analyst view": "The consensus recommendation across the analysts covering this company. An opinion, not a reported fact, and not advice.",
  "Revenue growth": "Change in revenue against the same period a year earlier, using the same revenue tag in both periods.",
  "Gross margin": "Gross profit as a share of revenue, both as the company reported them.",
  "Operating margin": "Operating income as a share of revenue, both as the company reported them.",
  "Net margin": "Net income as a share of revenue, both as the company reported them.",
  "Total return": "Price change plus dividends over the selected range, from weekly closes.",
};

/** Yahoo's recommendation keys read badly on a page; these do not. */
const RECOMMENDATION_LABELS: Record<string, string> = {
  strong_buy: "Strong buy", buy: "Buy", hold: "Hold",
  underperform: "Underperform", sell: "Sell", none: "No consensus",
};

export default function CompanyDetail({ payload }: { payload: CompanyPayload }) {
  const [preset, setPreset] = useState<(typeof RANGES)[number]>("5");

  const series: SeriesPoint[] = useMemo(
    () => payload.weekly.map((row) => ({ date: row.week_ending, value: row.adj_close })),
    [payload.weekly],
  );
  const [start, end] = useMemo(() => {
    const last = series.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
    const from = new Date(`${last}T00:00:00Z`);
    from.setUTCFullYear(from.getUTCFullYear() - Number(preset));
    return [from.toISOString().slice(0, 10), last];
  }, [preset, series]);

  const windowed = series.filter((point) => point.date >= start && point.date <= end);
  const growth = useMemo(() => investmentValue(windowed, 10_000), [windowed]);
  const years = useMemo(() => calendarPeriodReturns(series, series[0]?.date ?? start, end), [series, start, end]);

  // Reuse the sector page's comps logic for a single company, so the margins
  // here are computed exactly as they are in the table it was clicked from.
  const fundamentals = useMemo(
    () => compsRows({ companyFacts: payload.facts, companyMeta: payload.meta ? [payload.meta] : [] })[0] ?? null,
    [payload.facts, payload.meta],
  );

  const meta = payload.meta;
  const latestPrice = series.at(-1)?.value ?? null;
  const upside = meta?.target_mean_price && latestPrice
    ? meta.target_mean_price / latestPrice - 1
    : null;

  if (payload.errors.length) {
    return <main><section className="panel">
      <Unavailable>{payload.errors[0].source}: {payload.errors[0].reason}</Unavailable>
    </section></main>;
  }

  return <main>
    <section className="industry-hero">
      <div className="eyebrow">
        {payload.sectorSlug
          ? <Link href={`/industry/${payload.sectorSlug}`}>← {payload.sectorName}</Link>
          : "Not held by a tracked fund"}
      </div>
      <h1>{payload.ticker}</h1>
      <p className="panel-description">
        {meta?.name ?? "Company name unavailable"}
        {latestPrice !== null ? ` · ${formatPrice(latestPrice)} at ${series.at(-1)!.date}` : ""}
      </p>
      {series.length > 0 && <div className="chip-row">
        {RANGES.map((option) => (
          <button className={`chip${preset === option ? " active" : ""}`} key={option}
            onClick={() => setPreset(option)}>{option}Y</button>
        ))}
      </div>}
    </section>

    <section className="panel">
      <DetailHead eyebrow="01" title="What the market pays for it" subtitle="Valuation and analyst view"
        description="Market cap and multiples are current values from Yahoo, not aligned to the range selected. The analyst figures are opinions with a date on them rather than anything the company reported, and they are not advice."
        asOf={stampDate(meta?.as_of ?? null)} />
      <div className="stat-grid">
        <Stat label="Market cap" term="Current" value={money(meta?.market_cap ?? null)} definition={DEFINITIONS["Market cap"]} />
        <Stat label="Trailing P/E" term="Last twelve months" value={formatNumber(meta?.trailing_pe ?? null)} definition={DEFINITIONS["Trailing P/E"]} />
        <Stat label="Forward P/E" term="On expected earnings" value={formatNumber(meta?.forward_pe ?? null)} definition={DEFINITIONS["Forward P/E"]} />
        <Stat label="Price to book" value={formatNumber(meta?.price_to_book ?? null)} definition={DEFINITIONS["Price to book"]} />
      </div>
      <div className="stat-grid">
        <Stat label="Dividend yield" value={percent(meta?.dividend_yield ?? null)} definition={DEFINITIONS["Dividend yield"]} />
        <Stat label="Analyst target" term={meta?.analyst_count ? `${meta.analyst_count} analysts` : "Average"}
          value={meta?.target_mean_price ? formatPrice(meta.target_mean_price) : "—"} definition={DEFINITIONS["Analyst target"]} />
        <Stat label="Implied from target" term="Against the latest close"
          value={upside === null ? "—" : percent(upside)} />
        <Stat label="Analyst view" term="Consensus"
          value={meta?.recommendation ? (RECOMMENDATION_LABELS[meta.recommendation] ?? meta.recommendation) : "—"}
          definition={DEFINITIONS["Analyst view"]} />
      </div>
      {!meta && <p className="provenance">No valuation or analyst figures have been collected for {payload.ticker} yet. The figures below come from the company&rsquo;s own SEC filings and do not depend on them.</p>}
    </section>

    <section className="panel">
      <DetailHead eyebrow="02" title="What it reported" subtitle="SEC XBRL, as filed"
        description="Every figure here is a number the company itself filed with the SEC for the period named. The margins are the only calculated cells: each divides a reported profit line by that same company's reported revenue for the same period."
        asOf={fundamentals?.period} />
      {fundamentals ? <div className="stat-grid">
        <Stat label="Revenue growth" term={fundamentals.period} value={percent(fundamentals.revenueGrowth)} definition={DEFINITIONS["Revenue growth"]} />
        <Stat label="Gross margin" value={percent(fundamentals.grossMargin)} definition={DEFINITIONS["Gross margin"]} />
        <Stat label="Operating margin" value={percent(fundamentals.operatingMargin)} definition={DEFINITIONS["Operating margin"]} />
        <Stat label="Net margin" value={percent(fundamentals.netMargin)} definition={DEFINITIONS["Net margin"]} />
      </div> : <Unavailable>
        No XBRL facts are held for {payload.ticker}. Fundamentals are collected for the companies inside the sector funds that file with the SEC, so a foreign issuer or a recent addition can be missing.
      </Unavailable>}
    </section>

    <section className="panel">
      <DetailHead eyebrow="03" title="How the shares have done" subtitle="Weekly closes, dividends reinvested"
        description="This series is weekly, not daily. Daily bars for every company inside the funds do not fit the database, and the questions here are measured in years, which a weekly close answers identically."
        asOf={stampDate(series.at(-1)?.date ?? null)} />
      {series.length > 1 ? <>
        <div className="stat-grid">
          <Stat label="Total return" term={`Over ${preset} years`} value={percent(cumulativeReturn(windowed))} definition={DEFINITIONS["Total return"]} />
          <Stat label="Weeks of history" value={series.length.toLocaleString()} />
          <Stat label="First week held" value={series[0].date} />
          <Stat label="Latest close" value={latestPrice === null ? "—" : formatPrice(latestPrice)} />
        </div>
        <div className="chart-shell">
          <Heading title="What $10,000 would have become" term={`${payload.ticker}, weekly`} />
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={growth}>
              <CartesianGrid stroke="#e4e6df" vertical={false} />
              <XAxis dataKey="date" minTickGap={48} tick={{ fontSize: 10 }} />
              <YAxis tickFormatter={(value) => money(Number(value))} tick={{ fontSize: 10 }} />
              <Tooltip formatter={(value) => money(Number(value))} />
              <Line dataKey="value" name={payload.ticker} dot={false} stroke="#1d6b4d" />
            </LineChart>
          </ResponsiveContainer>
        </div>
        {years.length > 0 && <div className="chart-shell">
          <Heading title="Return by calendar year" term="Full history held" />
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={years}>
              <CartesianGrid stroke="#e4e6df" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} />
              <YAxis tickFormatter={(value) => percent(Number(value))} tick={{ fontSize: 10 }} />
              <Tooltip formatter={(value) => percent(Number(value))} />
              <Bar dataKey="value" name="Total return" fill="#1d6b4d" />
            </BarChart>
          </ResponsiveContainer>
          <p className="provenance">A year the held history only partly covers is labelled with the dates it actually spans.</p>
        </div>}
      </> : <Unavailable>No weekly prices are held for {payload.ticker}.</Unavailable>}
    </section>

    {payload.heldBy.length > 0 && <section className="panel">
      <DetailHead eyebrow="04" title="Which funds hold it" subtitle="Latest published composition"
        description="Weights come from each issuer's own holdings file. A company can appear in several funds, and the same share of it counts once in each." />
      <div className="data-table-wrap"><table>
        <thead><tr><th>Fund</th><th>Weight in fund</th><th>As of</th></tr></thead>
        <tbody>{payload.heldBy.map((row) => <tr key={row.fund_ticker}>
          <td><Link href={`/etf/${row.fund_ticker}`}>{row.fund_ticker}</Link></td>
          <td>{percent(row.weight)}</td>
          <td>{row.as_of}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
  </main>;
}
