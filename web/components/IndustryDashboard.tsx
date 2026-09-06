"use client";

import Link from "next/link";

import { useMemo, useState, type ReactNode } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line,
  LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  annualizedVolatility, beta, calendarPeriodReturns, concentration, correlation,
  cumulativeReturn, holdingsOverlap, investmentValue, maxDrawdown,
  sharpeRatio, type SeriesPoint,
} from "@/lib/metrics";
import { compsRows, factsCoverage, latestFactsByTicker, mergeShareClasses, revenueTags, type FactsCoverage } from "@/lib/comps";
import { validatedFundHoldings } from "@/lib/holdings";
import { coIssuerLabel, coverageNote, debtSplit, DOMINANCE_THRESHOLD, formDCounts, groupOfferings, largestShare, raisedOfferings, totalRaised, unpackFormD, type Coverage, type DebtSplit, type FormDCounts, type Offering } from "@/lib/formd";
import { distinctMonthTicks, placeName, plural, verb, formatMoney as money, formatNumber as number, formatPercent as percent, formatPrice as price, formatPriceChange as priceChange, formatSignedPercent as signedPercent, formatUnitValue as unitValue, isStale, readableError, relativeTime, stamp, stampDate } from "@/lib/format";
import { unpackRows } from "@/lib/wire";
import { ChartTable, Unavailable } from "@/components/DetailUi";
import type { CompanyMeta, FundComparison, IndustryPayload, MacroMeta, SectorGroup, WireIndustryPayload } from "@/lib/types";
import WorkbookButton from "./WorkbookButton";

const COLORS = ["#1d6b4d", "#143142", "#b97816", "#7d5a91", "#a4463f", "#2f7f9e", "#6b7a2f", "#8a4b6b"];
const DAY = 86_400_000;
const MACRO_VISIBLE = 4;
const COVERAGE_PAGE = 20;
// SPY is a benchmark, not a peer, so it is drawn thin, grey and dashed.
const BENCHMARK_STROKE = "#8a8f85";
// Axes rendered raw ISO strings. "Mar '24" is what a reader can actually scan.
const axisDate = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
const fullDate = (value: string) => new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
// Sort the tooltip so its top line is the top line on the chart.
const byValueDescending = (item: { value?: unknown }) => -Number(item.value ?? 0);
const closeDay = (value: string) => new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
const RANGE_DEFINITION = "The highest and lowest closing prices over the last year. Brokers usually quote a 52-week range from intraday highs and lows, which are wider, so this range will sit slightly inside the one on a quote page.";
const CLOSE_DEFINITION = "The fund's last traded closing price. This site stores end-of-day prices only, so this is the most recent session's close, not a live quote. Returns elsewhere on the page use dividend-adjusted prices, which is why a return will not equal the change in this number.";

/** Traded closes, never adjusted closes. */
function quoteFor(payload: IndustryPayload, ticker: string) {
  const rows = payload.prices
    .filter((row) => row.ticker === ticker && row.close !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const last = rows.at(-1);
  const previous = rows.at(-2);
  if (!last) return null;
  const change = previous ? last.close - previous.close : null;
  const yearAgo = new Date(Date.parse(`${last.date}T00:00:00Z`) - 365 * DAY).toISOString().slice(0, 10);
  const window = rows.filter((row) => row.date >= yearAgo).map((row) => row.close);
  return {
    date: last.date,
    close: last.close,
    change,
    changePercent: change !== null && previous?.close ? change / previous.close : null,
    low: window.length ? Math.min(...window) : null,
    high: window.length ? Math.max(...window) : null,
  };
}
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

function ChartEmpty({ source }: { source: string }) {
  return <div className="chart-empty">{source}: no observations are available for this panel.</div>;
}

// An event with no description is a marker the reader clicks for a payoff that
// never arrives, which is worse than no marker. Nothing blurbless is rendered.
function describedEvents(events: IndustryPayload["events"], start: string, end: string) {
  return events.filter((event) => event.blurb?.trim()
    && event.start_date <= end && (event.end_date ?? event.start_date) >= start);
}

function EventBands({ events, start, end }: { events: IndustryPayload["events"]; start: string; end: string }) {
  return <>{describedEvents(events, start, end).map((event) =>
    <ReferenceArea key={event.id} x1={event.start_date} x2={event.end_date ?? event.start_date} fill={event.impact === "negative" ? "#a4463f" : "#1d6b4d"} fillOpacity={.09} ifOverflow="extendDomain" />
  )}</>;
}

/** Facts over an event window, never a causal claim. */
function EventWindowReturns({ payload, event, onClose }: {
  payload: IndustryPayload; event: IndustryPayload["events"][number]; onClose: () => void;
}) {
  const windowEnd = event.end_date ?? event.start_date;
  const fund = payload.sector.primary_etf;
  const sector = cumulativeReturn(points(payload, fund, event.start_date, windowEnd));
  const benchmark = cumulativeReturn(points(payload, "SPY", event.start_date, windowEnd));
  const relative = sector !== null && benchmark !== null ? sector - benchmark : null;
  return <div className="event-window">
    <div className="event-window-head">
      <div>
        <h3>{event.title}</h3>
        <div className="event-window-dates">{event.start_date}{windowEnd !== event.start_date ? ` – ${windowEnd}` : ""}</div>
      </div>
      <button aria-label="Close" className="event-window-close" onClick={onClose}>×</button>
    </div>
    <p className="event-window-blurb">{event.blurb}</p>
    <h4 className="chart-title">Return over this window</h4>
    <table className="event-window-table">
      <caption className="visually-hidden">Total return over this event window for the sector fund, for the S&amp;P 500, and the difference between them.</caption>
      <tbody>
      <tr><th scope="row">{fund}</th><td>{percent(sector)}</td></tr>
      <tr><th scope="row">S&amp;P 500</th><td>{percent(benchmark)}</td></tr>
      <tr className="event-window-relative"><th scope="row">Relative</th><td>{percent(relative)}</td></tr>
    </tbody></table>
    <p className="event-window-note">Returns over an event window are coincident, not causal. Many things move a sector at once.</p>
    {event.source_url && <a href={event.source_url} target="_blank" rel="noreferrer">Source ↗</a>}
  </div>;
}

/**
 * The horizontal half of the timeline. Headlines are text of varying length and
 * belong in a vertical list; events have dates and durations, so they belong on
 * an axis. This rail shares the news chart's x-scale, which is where checking
 * whether a coverage spike matches a known event actually happens.
 */
function EventRail({ events, start, end, onSelect }: {
  events: IndustryPayload["events"]; start: string; end: string; onSelect: (id: string) => void;
}) {
  const span = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  if (span <= 0 || !events.length) return null;
  return <div aria-label="Events in this window" className="event-rail" role="group">
    {events.map((event) => {
      const offset = ((Date.parse(`${event.start_date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / span) * 100;
      return <button
        className={`event-marker ${event.impact}`}
        key={event.id}
        onClick={() => onSelect(event.id)}
        style={{ left: `${Math.min(Math.max(offset, 0), 100)}%` }}
        title={`${event.start_date} · ${event.title}`}
      >
        <span className="visually-hidden">{event.start_date} · {event.title}</span>
      </button>;
    })}
  </div>;
}

function monthLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${String(value).slice(0, 7)}-01T00:00:00Z`));
}

function SectionHead({ index, title, term, description, asOf }: { index: string; title: string; term: string; description: string; asOf: string }) {
  return <div className="panel-head"><div><div className="panel-index">{index}</div><h2>{title}</h2><div className="chart-term">{term}</div><p className="panel-description">{description}</p></div><div className="as-of">Table as of<br /><strong>{asOf}</strong></div></div>;
}


// Progressive disclosure, per M16. Nothing on the page explains itself until
// asked: a title click reveals the definition of the concept, and two lines
// under each chart say what this specific chart shows, with the rest behind a
// dots button. Both are inline expansions rather than popovers, which need
// positioning logic, break at narrow widths and are awkward on touch.
const CHART_COPY = {
  growth: {
    definition: "Rebasing restates every fund to the same starting value, so their paths can be compared no matter what their share prices are. The axis is an index, not a price: a fund trading at $63 can sit at 152 here, meaning it has returned 52% over the window.",
    lines: "Every fund set to 100 on the first day of the window, so their paths can be compared whatever their share prices are. 160 means up 60%. The thick line is this sector's fund; the grey dashed line is the S&P 500.",
    more: "Shaded bands mark dated events listed further down the page. Add peer funds with the chips above the chart. This is what the arithmetic produces, not a record of a real investment.",
  },
  drawdown: {
    definition: "A drawdown is the fall from a previous high. It measures the worst stretch an investor would have had to sit through, rather than the average experience.",
    lines: "How far the fund sits below its own previous peak at every point in the window. Zero means it just hit a record high.",
    more: "A reading of \u221230% means the fund would need to gain 43% to get back to even, which is why deep drawdowns matter more than they first look. The width of each dip shows how long recovery took.",
  },
  calendar: {
    definition: "Calendar year returns split the total into the years it happened in, so you can see whether one year did all the work.",
    lines: "Return for each calendar year in the window. Multiply these together and you get the total return shown above.",
    more: "Partial years show their start and end dates in the header. Each day's return counts toward the year it ends in, which is why the years reconcile to the total exactly.",
  },
  margins: {
    definition: "Margin is the share of revenue a company keeps after a given set of costs. Gross is after production, operating is after running the business, net is after everything including interest and tax.",
    lines: "Profit margins for the middle company in this fund, across the last eight reported quarters.",
    more: "The median is used rather than the average so one very large company cannot move the line on its own. Rising lines mean the typical company is keeping more of each dollar of revenue. Companies that do not report a figure are left out of that period rather than counted as zero.",
  },
  overlap: {
    definition: "Overlap adds up the smaller of the two weights for every stock two funds share, so it measures genuinely duplicated exposure rather than just shared names.",
    lines: "How much of any two funds' portfolios are the same stocks, weighted by position size.",
    more: "High overlap means owning both gives you less diversification than the two names suggest. A fund compared with itself is always 100%, which is why the diagonal reads Self.",
  },
  formd: {
    definition: "Form D is the filing a private company sends the SEC when it raises money without going public. It is the only public record of most private rounds.",
    lines: "Securities placed privately under Regulation D by issuers the SEC classifies in this sector, placed in the quarter the offering began. Filers are not all private companies: a listed company placing securities privately files the same form, and those rows are marked.",
    more: "Watch whether private funding turns before or after the public market does. Each offering is counted once, at the cumulative figure from its most recent filing; a company that amends restates its total rather than adding to it. An offering is plotted in the quarter its original filing was made, which is a simplification: raising can run for years after that date, and the money shown in one quarter was not necessarily all raised in it. Offerings whose original predates this data have no known start date and are left out of these bars, though they remain in the table below. Many filings report no amount at all and count toward the filing tally only. Hovering a bar gives the number of offerings behind it, because a tall bar built from one offering means something different from the same total spread across fifty.",
  },
  news: {
    definition: "Tone is GDELT's sentiment score for the language in an article, averaged across all coverage that day. Above zero is net positive.",
    lines: "How many articles mentioned this industry each day, and how positive that coverage was.",
    more: "Spikes almost always match an event in the list below. Keyword matching is imperfect and will catch some unrelated articles while missing some relevant ones, so read the shape as the signal and the exact counts as approximate.",
  },
} as const;

const STAT_DEFINITIONS: Record<string, string> = {
  "Total return": "Price change plus dividends, assuming every dividend was reinvested the day it was paid.",
  "Volatility": "How much the fund moved day to day, scaled to an annual figure. Higher means a bumpier ride, not a worse one.",
  "Beta vs S&P 500": "How much the fund moved when the market moved. One means it tracked the market, above one means it amplified it.",
  "Sharpe ratio": "Return earned above what a 3-month Treasury would have paid, divided by how much the fund bounced around to earn it. Higher is better compensation for the risk taken.",
  "Top 10 holdings": "The share of the portfolio sitting in its ten largest positions.",
  "Concentration": "HHI squares every holding's weight and adds them up, on a 0 to 10,000 scale. One stock scores 10,000; a hundred equal stocks score 100.",
  "Expense ratio": "The annual fee the fund charges, taken out of returns automatically.",
  "Assets": "Total money invested in the fund.",
  "Form D filings": "How many documents the SEC received: originals and amendments alike, counted one per accession number.",
  "Offerings": "How many distinct fundraises those filings describe. EDGAR gives each offering an 021 file number and keeps it constant when the filer amends, so amendments fold into the offering they restate.",
  "Total raised": "Money private companies reported raising, counting each offering once at the cumulative figure from its most recent filing.",
  "Typical raise": "The median reported offering size, which is more representative than the average when one huge round distorts it.",
  "Raised as debt": "Of the money whose filers said what kind of security they were selling, the share in offerings that include debt. The boxes on the form are not exclusive, so an offering selling equity and debt together counts here in full; the form never asks how the money splits between them. Offerings that ticked no box are left out of this share entirely rather than assumed to be equity.",
  "Offerings per quarter": "The median number of offerings starting in a quarter, so a quarter's bar can be read against how much activity produced it. Only offerings with a known start quarter are counted.",
};

/**
 * Two dates matter and they are never merged. "Data through" is the latest
 * observation, which is what the reader cares about. "Last checked" is when the
 * ingest last ran, which tells them whether a stale number means the source has
 * not published or the pipeline broke.
 */
function ChartFreshness({ payload, source, dataThrough }: {
  payload: IndustryPayload; source: string; dataThrough: string | null | undefined;
}) {
  const run = payload.freshness.find((item) => item.source === source);
  const checked = run?.finished_at ?? run?.started_at ?? null;
  const stale = isStale(checked);
  return <div className={`chart-freshness${stale ? " source-stale" : ""}`}>
    Data through {stampDate(dataThrough)} · last checked {stamp(checked)}
  </div>;
}

function ChartCaption({ lines, more }: { lines: string; more?: string }) {
  const [open, setOpen] = useState(false);
  return <div className="chart-caption">
    <p>{lines}</p>
    {more && <>
      <button aria-expanded={open} aria-label={open ? "Show less" : "Show more"} className="caption-more" onClick={() => setOpen(!open)}>…</button>
      {open && <p className="caption-more-body">{more}</p>}
    </>}
  </div>;
}

/** A title answers "what am I looking at"; the term line keeps the vocabulary. */
function ChartHeading({ title, term, definition, asLabel }: { title: string; term?: string; definition?: string; asLabel?: boolean }) {
  const [open, setOpen] = useState(false);
  // The title is what a reader navigating by heading is looking for, so it is a
  // heading. Where it also opens the definition, the heading wraps the button
  // rather than sitting inside it: a button's children are presentational, so a
  // heading nested in one is dropped from the accessibility tree.
  if (!definition) {
    return <div className="chart-heading">
      <h3 className="chart-title">{title}</h3>
      {term && <div className="chart-term">{term}</div>}
    </div>;
  }
  const toggle = <button aria-expanded={open} className="term-toggle" onClick={() => setOpen(!open)}>
    <span className="chart-title">{title}</span>
    {term && <span className="chart-term">{term}</span>}
  </button>;
  // asLabel is the two hero stat cells. They are cells in a stat row rather
  // than charts, and they sit above the page's first h2, so a heading there
  // opens the outline with two stat labels and jumps h1 straight to h3, which
  // is what axe's heading-order rule caught.
  return <div className="chart-heading">
    {asLabel ? toggle : <h3 className="chart-heading-title">{toggle}</h3>}
    {open && <div className="term-body">{definition}</div>}
  </div>;
}

function Stat({ label, term, value }: { label: string; term?: string; value: ReactNode }) {
  const [open, setOpen] = useState(false);
  const definition = STAT_DEFINITIONS[label];
  return <div className="stat">
    {definition ? <>
      <button aria-expanded={open} className="term-toggle" onClick={() => setOpen(!open)}>
        <span className="stat-label">{label}</span>
        {term && <span className="chart-term">{term}</span>}
      </button>
      {open && <div className="term-body">{definition}</div>}
    </> : <>
      <div className="stat-label">{label}</div>
      {term && <div className="chart-term">{term}</div>}
    </>}
    <div className="stat-value">{value}</div>
  </div>;
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

export default function IndustryDashboard({ initialPayload }: { initialPayload: WireIndustryPayload }) {
  // Form D arrives packed so the prerendered page stays inside Vercel's size
  // limit. Everything below this line sees ordinary rows.
  const payload: IndustryPayload = useMemo(() => ({
    ...initialPayload,
    prices: unpackRows(initialPayload.prices),
    macro: { ...initialPayload.macro, series: unpackRows(initialPayload.macro.series) },
    formD: unpackFormD(initialPayload.formD),
  }), [initialPayload]);
  const tickers = [payload.sector.primary_etf, ...payload.sector.comparison_etfs, "SPY"];
  const compositionFunds = tickers.filter((ticker) => ticker !== "SPY" && payload.etfMeta.find((meta) => meta.ticker === ticker)?.holdings_status !== "unsupported");
  const allDates = payload.prices.map((row) => row.date).sort();
  const maxEnd = allDates.at(-1) ?? new Date().toISOString().slice(0, 10);
  const maxStart = allDates[0] ?? maxEnd;
  const [preset, setPreset] = useState<Preset>("3Y");
  const [customStart, setCustomStart] = useState(maxStart);
  const [customEnd, setCustomEnd] = useState(maxEnd);
  const [fund, setFund] = useState(compositionFunds[0] ?? payload.sector.primary_etf);
  const [activePeers, setActivePeers] = useState<string[]>([]);
  const [allHoldingsShown, setAllHoldingsShown] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const selectedEvent = payload.events.find((event) => event.id === selectedEventId) ?? null;

  const [start, end] = useMemo(() => {
    if (preset === "Max") return [maxStart, maxEnd];
    if (preset === "Custom") return [customStart, customEnd];
    const years = Number.parseInt(preset, 10);
    const startDate = new Date(Date.parse(maxEnd));
    startDate.setUTCFullYear(startDate.getUTCFullYear() - years);
    return [startDate.toISOString().slice(0, 10), maxEnd];
  }, [preset, customStart, customEnd, maxStart, maxEnd]);

  // Five similar-weight lines at once is unreadable. Show the fund and the
  // benchmark; peers are added deliberately with the chips above the chart.
  const peerTickers = tickers.filter((ticker) => ticker !== payload.sector.primary_etf && ticker !== "SPY");
  const shownTickers = [payload.sector.primary_etf, ...activePeers.filter((ticker) => peerTickers.includes(ticker))];
  const quote = quoteFor(payload, payload.sector.primary_etf);
  const ytdReturn = useMemo(() => {
    const rows = payload.prices.filter((row) => row.ticker === payload.sector.primary_etf).sort((a, b) => a.date.localeCompare(b.date));
    const latest = rows.at(-1);
    if (!latest) return null;
    // Same basis as the home grid: the prior year-end close, not January 1.
    const baseline = rows.filter((row) => row.date < `${latest.date.slice(0, 4)}-01-01`).at(-1);
    return baseline && baseline.adj_close > 0 ? latest.adj_close / baseline.adj_close - 1 : null;
  }, [payload.prices, payload.sector.primary_etf]);
  const primary = points(payload, payload.sector.primary_etf, start, end);
  const spy = points(payload, "SPY", start, end);
  const riskFree = payload.macro.series.filter((row) => row.series_id === "DGS3MO" && row.value !== null).map((row) => ({ date: row.date, value: row.value! }));
  const performance = investmentPerformance(payload, tickers, start, end);
  const primaryInvestment = investmentValue(primary);
  const spyInvestment = investmentValue(spy);
  const drawdown = drawdownSeries(primary);
  const maximumDrawdown = maxDrawdown(primary);
  const selected = validatedFundHoldings(payload, fund, end);
  // GOOGL and GOOG are one company; counted separately they split a position
  // in two and drop one half out of any group naming only the other.
  const selectedHoldings = selected.failure ? [] : mergeShareClasses(selected.rows);
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
  // The margins chart plots fiscal periods, but "data through" means the most
  // recent filing that fed it.
  const latestFactFiled = [...factsAsOfEnd].map((fact) => fact.filed_date).sort().at(-1);
  const comps = compsRows(factsPayload);
  const marginTrends = marginTrend(factsPayload);
  const reportedWeightTotal = selectedHoldings.reduce((sum, holding) => sum + holding.weight, 0);
  const largestHolding = [...selectedHoldings].sort((a, b) => b.weight - a.weight)[0];
  const snapshotDate = selected.rows.length ? asOfLabel(selected.rows.map((row) => row.as_of)) : null;
  const snapshotAgeDays = snapshotDate && snapshotDate !== "unavailable"
    ? Math.floor((Date.now() - Date.parse(`${snapshotDate}T00:00:00Z`)) / DAY)
    : null;

  const formDInRange = useMemo(
    () => payload.formD.filter((row) => row.filed_date >= start && row.filed_date <= end),
    [payload.formD, start, end],
  );
  // Filings collapse into the offerings they describe, keyed on EDGAR's file
  // number. Dollars come from the latest filing in each group; the quarter
  // comes from the original's date.
  const offerings = useMemo(() => groupOfferings(formDInRange), [formDInRange]);
  const counts = useMemo(() => formDCounts(formDInRange), [formDInRange]);

  const privateCapital = useMemo(() => {
    const quarterOf = (value: string) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return `${parsed.getUTCFullYear()} Q${Math.floor(parsed.getUTCMonth() / 3) + 1}`;
    };
    const groups = new Map<string, { quarter: string; raised: number | null; count: number; values: number[] }>();
    const group = (quarter: string) => {
      const existing = groups.get(quarter) ?? { quarter, raised: null, count: 0, values: [] };
      groups.set(quarter, existing);
      return existing;
    };
    // An offering whose original is missing has only an amendment's date, which
    // would put its money in the quarter it was amended rather than the quarter
    // it was raised in. It stays in the table below and out of these bars.
    const datable = offerings.filter((offering) => !offering.originUnknown);
    for (const offering of datable) group(quarterOf(offering.startDate)).count += 1;
    // Each offering contributes its cumulative total once. `raised` stays null
    // for a quarter where nothing was reported, which is not zero raised.
    for (const [quarter, quarterOfferings] of Map.groupBy(
      datable.filter((offering) => offering.amountSold !== null),
      (offering) => quarterOf(offering.startDate),
    )) {
      const bucket = group(quarter);
      bucket.values.push(...quarterOfferings.map((offering) => offering.amountSold!));
      bucket.raised = totalRaised(quarterOfferings.map((offering) => offering.latest));
    }
    const pricesByQuarter = new Map<string, number>();
    for (const point of primary) {
      const parsed = new Date(`${point.date}T00:00:00Z`);
      pricesByQuarter.set(`${parsed.getUTCFullYear()} Q${Math.floor(parsed.getUTCMonth() / 3) + 1}`, point.value);
    }
    return [...groups.values()]
      .map((row) => ({ ...row, median: quantile(row.values, .5), etfPrice: pricesByQuarter.get(row.quarter) ?? null }))
      .sort((a, b) => a.quarter.localeCompare(b.quarter));
  }, [offerings, primary]);

  // Zero is a real answer on Form D: the offering is declared and nothing has
  // closed yet, and 19,093 filings say it. Counted as a raise it halves the
  // median, so Real Estate's typical offering read $1.0m against the $2.59m
  // typical of the offerings that have actually taken money.
  const nothingSoldYet = offerings.filter((row) => row.amountSold === 0).length;
  const medianReportedRaise = quantile(raisedOfferings(offerings).map((row) => row.amountSold), .5);
  // The total counts every offering; the bars can only carry the ones with a
  // known start quarter. Naming the difference keeps the two from contradicting
  // each other on the same panel.
  const undatedRaised = useMemo(
    () => totalRaised(offerings.filter((row) => row.originUnknown).map((row) => row.latest)),
    [offerings],
  );
  const debt = useMemo(() => debtSplit(offerings), [offerings]);
  const offeringsPerQuarter = quantile(privateCapital.map((row) => row.count), .5);
  // What Form D actually covers, which is not the window the reader picked.
  // The collector holds published quarters plus whatever of the quarter in
  // progress has been crawled, and that range is usually the narrower of the two.
  const formDCoverage = useMemo(() => {
    const dates = payload.formD.map((row) => row.filed_date).sort();
    return { earliest: dates[0] ?? null, latest: dates.at(-1) ?? null };
  }, [payload.formD]);

  // The chart is fed the range-filtered rows, so the empty check has to test
  // those. Testing the unfiltered array drew an empty canvas with axes and no
  // explanation whenever rows existed but none fell inside the window.
  // A sector with ten FRED series rendered ten charts of equal weight. Show the
  // most relevant few and put the rest behind a disclosure.
  const macroPoints = (meta: MacroMeta) => payload.macro.series
    .filter((point) => point.series_id === meta.series_id && point.date >= start && point.date <= end && point.value !== null)
    .map((point) => ({ date: point.date, value: point.value! }));

  const newsInRange = useMemo(
    () => payload.newsVolume.filter((row) => row.date >= start && row.date <= end),
    [payload.newsVolume, start, end],
  );
  const gdeltRun = payload.freshness.find((run) => run.source === "gdelt");

  // Events and headlines are no longer interleaved by date. There are few
  // events and many headlines, and the events are the higher-value content.
  const timelineEvents = useMemo(
    () => [...describedEvents(payload.events, start, end)].sort((a, b) => b.start_date.localeCompare(a.start_date)),
    [payload.events, start, end],
  );
  // The window ends on the last trading day, because that is the last day the
  // price series has. News does not stop on a market holiday: articles filed
  // after the close were being dropped, which hid the whole live feed behind
  // month-old headlines. When the reader has not deliberately picked an earlier
  // end, coverage runs to the present instead.
  const coverageEnd = end >= maxEnd ? "9999-12-31" : end;
  const coverage = useMemo(
    () => payload.headlines
      .filter((item) => item.published_date.slice(0, 10) >= start && item.published_date.slice(0, 10) <= coverageEnd)
      .sort((a, b) => b.published_date.localeCompare(a.published_date)),
    [payload.headlines, start, coverageEnd],
  );
  // The list had no cap, so a 3-year window rendered hundreds of items and the
  // page became unscrollable.
  // The two feeds behind this list run at different speeds, and a reader
  // seeing month-old headlines needs to know which one they are looking at.
  const curatedThrough = useMemo(() => {
    const dates = payload.events.map((event) => event.start_date).sort();
    return dates.at(-1) ?? null;
  }, [payload.events]);
  const coverageFeeds = useMemo(() => {
    const newest = new Map<string, string>();
    for (const item of payload.headlines) {
      const feed = item.id.startsWith("gdelt:") ? "GDELT" : item.source;
      const date = item.published_date.slice(0, 10);
      if (!newest.has(feed) || date > newest.get(feed)!) newest.set(feed, date);
    }
    const parts = [...newest.entries()]
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, 4)
      .map(([feed, date]) => `${feed} through ${date}`);
    return parts.length
      ? `Latest in each feed: ${parts.join("; ")}. Publisher names are shown per item.`
      : "";
  }, [payload.headlines]);

  const [coverageShown, setCoverageShown] = useState(COVERAGE_PAGE);
  const visibleCoverage = coverage.slice(0, coverageShown);
  const selectEvent = (id: string) => {
    setSelectedEventId(id);
    const target = typeof document === "undefined" ? null : document.getElementById(`event-${id}`);
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  };

  return <main id="main-content" tabIndex={-1}>
    <section className="industry-hero">
      <div className="eyebrow">{payload.sector.primary_etf} · NAICS {payload.sector.naics_code}</div>
      <h1>{payload.sector.name}</h1>
      <p>One synchronized view across public markets, business fundamentals, private financing, operating indicators, and sourced events.</p>
      <div className="hero-meta">{tickers.map((ticker) => <span className="pill" key={ticker}>{ticker}{ticker === payload.sector.primary_etf ? " · primary" : ""}</span>)}</div>
      {quote && <div className="hero-stats">
        <div className="hero-stat">
          <ChartHeading asLabel title="Close" term={`${payload.sector.primary_etf} · ${closeDay(quote.date)}`} definition={CLOSE_DEFINITION} />
          <div className="hero-stat-value">{price(quote.close)}</div>
        </div>
        <div className="hero-stat">
          <div className="hero-stat-label">Day change</div>
          <div className="hero-stat-value">{quote.change === null ? "-" : <span className={quote.change >= 0 ? "up" : "down"}>{priceChange(quote.change)} ({signedPercent(quote.changePercent)})</span>}</div>
        </div>
        <div className="hero-stat">
          <div className="hero-stat-label">Year to date</div>
          <div className="hero-stat-value">{percent(ytdReturn)}</div>
        </div>
        <div className="hero-stat">
          <ChartHeading asLabel title="52-week range" term="Closing basis" definition={RANGE_DEFINITION} />
          <div className="hero-stat-value">{price(quote.low)} - {price(quote.high)}</div>
        </div>
      </div>}
    </section>

    {/* A bare div takes no aria-label: with no role there is nothing for the
        name to name, and assistive technology drops it. The buttons carried
        their selected state in a class, which is styling, not state. */}
    <div className="range-bar" role="group" aria-label="Date range">
      {(["1Y", "3Y", "5Y", "10Y", "Max"] as Preset[]).map((value) => <button aria-pressed={preset === value} className={preset === value ? "active" : ""} key={value} onClick={() => setPreset(value)}>{value}</button>)}
      <button aria-pressed={preset === "Custom"} className={preset === "Custom" ? "active" : ""} onClick={() => setPreset("Custom")}>Custom</button>
      {preset === "Custom" && <><input aria-label="Start date" type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /><input aria-label="End date" type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></>}
      <WorkbookButton payload={payload} start={start} end={end} />
    </div>

    {payload.errors.length > 0 && <details className="source-errors-summary">
      <summary><strong>{payload.errors.length} data {payload.errors.length === 1 ? "source is" : "sources are"} temporarily unavailable</strong> · failed data is automatically suppressed</summary>
      <div className="source-errors-list">{payload.errors.map((error) => <div key={`${error.source}:${error.reason}`}><strong>{error.source}</strong>: {readableError(error.reason)}</div>)}</div>
    </details>}
    <div className="freshness">{payload.freshness.map((item) => <div className={`freshness-item ${item.status === "failed" ? "failed" : isStale(item.finished_at ?? item.started_at) ? "stale" : ""}`} key={item.source}><strong>{item.source}</strong> · {item.details.skipped ? "skipped (not due)" : item.status} · {stamp(item.finished_at ?? item.started_at)}</div>)}</div>

    <section className="panel" id="performance">
      <SectionHead index="01" title="Price and risk" term="Total return, volatility, drawdown" description="Adjusted-close performance and risk metrics recalculate in the browser whenever the date range changes." asOf={asOfLabel(payload.prices.map((row) => row.date))} />
      <div className="insight-grid">
        <div className="insight-card"><div className="insight-label">What happened</div><p><strong>$100 invested in {payload.sector.primary_etf}</strong> became <strong>{primaryInvestment.length ? money(primaryInvestment.at(-1)!.value) : "-"}</strong> over the selected window.</p>{spyInvestment.length > 0 && <p className="insight-detail">The same $100 in SPY became {money(spyInvestment.at(-1)!.value)}.</p>}</div>
      </div>
      <div className="stat-grid">
        <Stat label="Total return" value={percent(cumulativeReturn(primary))} />
        <Stat label="Volatility" term="Annualized, from daily moves" value={percent(annualizedVolatility(primary))} />
        <Stat label="Beta vs S&P 500" value={number(beta(primary, spy))} />
        <Stat label="Sharpe ratio" term="vs 3-month Treasury" value={number(sharpeRatio(primary, riskFree))} />
      </div>
      <div className="chart-shell"><ChartHeading title="How each fund has performed" term="Rebased to 100, dividends reinvested" definition={CHART_COPY.growth.definition} />
        {peerTickers.length > 0 && <div className="peer-chips">{peerTickers.map((ticker) => <button aria-pressed={activePeers.includes(ticker)} className={`chip${activePeers.includes(ticker) ? " active" : ""}`} key={ticker} onClick={() => setActivePeers(activePeers.includes(ticker) ? activePeers.filter((item) => item !== ticker) : [...activePeers, ticker])}>{ticker}</button>)}</div>}
        {performance.length ? <ResponsiveContainer width="100%" height={320}><LineChart data={performance} role="img" aria-label={`Line chart. ${CHART_COPY.growth.lines}`}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="date" ticks={distinctMonthTicks(performance.map((row) => String(row.date)))} tick={{ fontSize: 10 }} tickFormatter={axisDate} /><YAxis tickFormatter={(value) => Math.round(Number(value)).toString()} tick={{ fontSize: 10 }} width={48} /><Tooltip formatter={(value, name) => [`${Math.round(Number(value))} (${signedPercent(Number(value) / 100 - 1)})`, String(name)]} itemSorter={byValueDescending} labelFormatter={(value) => fullDate(String(value))} /><Legend /><ReferenceLine y={100} stroke="#c9cdc2" strokeDasharray="3 3" /><EventBands events={payload.events} start={start} end={end} />{shownTickers.map((ticker, index) => <Line key={ticker} dataKey={ticker} dot={false} connectNulls stroke={COLORS[index % COLORS.length]} strokeWidth={ticker === payload.sector.primary_etf ? 2.4 : 1.3} />)}<Line key="SPY" dataKey="SPY" dot={false} connectNulls stroke={BENCHMARK_STROKE} strokeWidth={1.2} strokeDasharray="4 3" /></LineChart></ResponsiveContainer> : <ChartEmpty source="Prices" />}<ChartCaption lines={CHART_COPY.growth.lines} more={CHART_COPY.growth.more} /><FundLinks tickers={[payload.sector.primary_etf, ...peerTickers]} primary={payload.sector.primary_etf} /><ChartFreshness payload={payload} source="prices" dataThrough={primary.at(-1)?.date} /></div>
      <div className="chart-grid">
        <div className="chart-shell"><ChartHeading title="How far below its last peak" term="Drawdown" definition={CHART_COPY.drawdown.definition} />{drawdown.length ? <ResponsiveContainer width="100%" height={260}><AreaChart data={drawdown} role="img" aria-label={`Area chart. ${CHART_COPY.drawdown.lines}`}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="date" ticks={distinctMonthTicks(drawdown.map((row) => String(row.date)))} tick={{ fontSize: 10 }} tickFormatter={axisDate} /><YAxis tickFormatter={(value) => `${(Number(value) * 100).toFixed(2)}%`} tick={{ fontSize: 10 }} /><Tooltip formatter={(value) => percent(Number(value))} labelFormatter={(value) => fullDate(String(value))} /><ReferenceLine y={0} stroke="#c9cdc2" strokeDasharray="3 3" /><Area dataKey="drawdown" stroke="#a4463f" fill="#a4463f" fillOpacity={.22} /></AreaChart></ResponsiveContainer> : <ChartEmpty source="Prices" />}<ChartCaption lines={CHART_COPY.drawdown.lines} more={CHART_COPY.drawdown.more} /><ChartFreshness payload={payload} source="prices" dataThrough={primary.at(-1)?.date} /></div>
      </div>
      {maximumDrawdown && <p className="panel-description">Maximum drawdown {percent(maximumDrawdown.maxDrawdown)} from {maximumDrawdown.peakDate} to {maximumDrawdown.troughDate}; {maximumDrawdown.recoveryDate
        ? `recovered ${maximumDrawdown.recoveryDate}, ${maximumDrawdown.durationDays} days from peak to recovery`
        : `not recovered in the selected window, ${maximumDrawdown.durationDays} days from peak to the end of the range`}.</p>}
      <div className="hero-meta">{describedEvents(payload.events, start, end).map((event) => <button className={`pill event-pill${selectedEvent?.id === event.id ? " active" : ""}`} onClick={() => setSelectedEventId(selectedEvent?.id === event.id ? null : event.id)} key={event.id}>{event.title}</button>)}</div>
      {selectedEvent && <EventWindowReturns payload={payload} event={selectedEvent} onClose={() => setSelectedEventId(null)} />}
      <CalendarTable payload={payload} tickers={tickers} start={start} end={end} />
    </section>

    <section className="panel" id="composition">
      <SectionHead index="02" title="What the fund holds" term="Constituents and weights" description="Latest issuer-published snapshots. Unsupported issuers are hidden rather than represented by empty portfolios. Share classes of one company are combined, so a fund holding two lines of the same issuer counts it once." asOf={asOfLabel(selected.rows.map((row) => row.as_of))} />
      <SubstituteFundNote shown={fund} primary={payload.sector.primary_etf}
        reason={payload.etfMeta.find((meta) => meta.ticker === payload.sector.primary_etf)?.holdings_error ?? null} />
      {compositionFunds.length > 0 && <select aria-label="Fund whose holdings are shown" className="fund-selector" value={fund} onChange={(event) => setFund(event.target.value)}>{compositionFunds.map((ticker) => <option key={ticker}>{ticker}</option>)}</select>}
      {selected.failure ? <div className="source-error">Holdings · {fund} · {selected.failure}</div> : <>
      {snapshotAgeDays !== null && snapshotAgeDays > 7 && <div className="source-error">Holdings · {fund} · stale snapshot dated {snapshotDate}.</div>}
      <div className="insight-grid">
        <div className="insight-card"><div className="insight-label">What the fund owns</div><p><strong>{fund}</strong> reports {selectedHoldings.length.toLocaleString()} holdings covering <strong>{percent(reportedWeightTotal)}</strong> of portfolio weight.{largestHolding && <> Its largest position is <strong>{largestHolding.constituent_ticker} at {percent(largestHolding.weight)}</strong>.</>}</p></div>
      </div>
      <div className="stat-grid">
        <Stat label="Top 10 holdings" term="Share of portfolio" value={selectedHoldings.length ? percent(reportedTop10Weight) : "-"} />
        <Stat label="Concentration" term="HHI, 0 to 10,000" value={selectedHoldings.length ? Math.round(concentrationStats.hhi * 10_000).toLocaleString() : "-"} />
        <Stat label="Expense ratio" term="Annual fee" value={payload.etfMeta.find((item) => item.ticker === fund)?.expense_ratio === null ? "Unavailable from Yahoo Finance" : percent(payload.etfMeta.find((item) => item.ticker === fund)?.expense_ratio ?? null, 2)} />
        <Stat label="Assets" term="Total invested in the fund" value={payload.etfMeta.find((item) => item.ticker === fund)?.aum ? money(payload.etfMeta.find((item) => item.ticker === fund)!.aum!) : "-"} />
      </div>
      {selectedHoldings.length ? <>
        <p className="provenance">Every row is published by the fund&rsquo;s issuer in its own daily holdings file and stored as given. Weights are the issuer&rsquo;s, not recomputed here, which is why a complete snapshot sums to about 100%. A snapshot that fails validation is suppressed rather than shown in part.</p>
        <div className="data-table-wrap" tabIndex={0}><table><caption className="visually-hidden">Every position in the selected fund, with its ticker and its weight in the fund.</caption><thead><tr><th scope="col">Holding</th><th scope="col">Ticker</th><th scope="col">Weight</th></tr></thead><tbody>{(allHoldingsShown ? selectedHoldings : selectedHoldings.slice(0, 25)).map((holding) => <tr key={holding.constituent_ticker}><td>{holding.constituent_name ?? holding.constituent_ticker}</td><td>{holding.constituent_ticker}</td><td>{percent(holding.weight, 2)}</td></tr>)}</tbody></table></div>
        {selectedHoldings.length > 25 && <button className="chip show-more" onClick={() => setAllHoldingsShown(!allHoldingsShown)}>{allHoldingsShown ? `Show the largest 25 of ${selectedHoldings.length}` : `Show all ${selectedHoldings.length} holdings`}</button>}
        {!allHoldingsShown && selectedHoldings.length > 25 && <p className="provenance">Showing the largest 25 of {selectedHoldings.length.toLocaleString()}. The stats above are computed across all {selectedHoldings.length.toLocaleString()}, not just the rows displayed.</p>}
      </> : <div className="source-error">Holdings · {payload.etfMeta.find((item) => item.ticker === fund)?.holdings_error ?? "No issuer snapshot is available."}</div>}
      <OverlapMatrix matrix={overlap} funds={Object.keys(holdingsByFund)} />
      </>}
    </section>

    {payload.fundComparisons.length > 0 && <section className="panel" id="comparison">
      <SectionHead index="02" title="Against the alternatives" term="Funds from other sectors"
        description="The same money could sit in a different asset entirely. These funds live on their own pages; this puts them on one axis so the choice between them can be seen."
        asOf={asOfLabel(payload.fundComparisons.flatMap((c) => c.series.flatMap((s) => s.points.map((p) => p.date))))} />
      {payload.fundComparisons.map((comparison) => <FundComparisonPanel key={comparison.slug} comparison={comparison} start={start} end={end} />)}
    </section>}

    {payload.groups.length > 0 && <section className="panel" id="groups">
      <SectionHead index="03" title="Groups worth watching" term="Curated company groups"
        description="Companies grouped by what they actually do, cutting across the fund that happens to hold them. These groupings are curated rather than taken from a filing, because the issuer holdings files carry no usable sub-sector of their own."
        asOf={asOfLabel(payload.groups.flatMap((group) => group.members.flatMap((member) => member.weekly.map((point) => point.date))))} />
      {payload.groups.map((group) => <CompanyGroupPanel key={group.slug} group={group} start={start} end={end} />)}
    </section>}

    <section className="panel" id="fundamentals">
      <SectionHead index="04" title="How the companies are doing" term="SEC XBRL reported facts" description="Reported SEC XBRL facts only. Missing tags remain blank; quartiles use available observations. Market cap is today's value and is not aligned to the selected date range." asOf={asOfLabel(payload.companyFacts.map((row) => row.filed_date))} />
      {comps.length ? <>
        <ChartHeading title="Every company in the fund, side by side" term="One row per constituent" definition={COMPS_DEFINITION} />
        <p className="provenance">Each figure below is a number the company itself filed with the SEC in XBRL, for the period named in its row. Revenue, gross profit, operating income and net income are reported values, taken as filed. The three margins are the only calculated cells: each divides a reported profit line by that same company&rsquo;s reported revenue for the same period. Nothing here is estimated, and a company that did not report a figure leaves the cell blank rather than showing a zero.</p>
        <CompsCoverage coverage={factsCoverage(selectedHoldings, factsAsOfEnd)} />
        <CompsTable rows={comps} coverage={factsCoverage(selectedHoldings, factsAsOfEnd)} />
      </> : <div className="source-error">SEC XBRL: no company facts are available for the latest primary-fund constituents.</div>}
      {marginTrends.length > 0 && <div className="chart-shell" style={{ marginTop: 16 }}><ChartHeading title="Profit margins for the typical company" term="Median gross, operating and net margin" definition={CHART_COPY.margins.definition} /><ResponsiveContainer width="100%" height={300}><LineChart data={marginTrends} role="img" aria-label={`Line chart. ${CHART_COPY.margins.lines}`}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="period" tick={{ fontSize: 10 }} /><YAxis tickFormatter={(value) => `${(Number(value) * 100).toFixed(2)}%`} tick={{ fontSize: 10 }} /><Tooltip formatter={(value) => percent(Number(value))} itemSorter={byValueDescending} /><Legend /><Line dataKey="gross" name="Gross margin" stroke="#1d6b4d" /><Line dataKey="operating" name="Operating margin" stroke="#143142" /><Line dataKey="net" name="Net margin" stroke="#b97816" /></LineChart></ResponsiveContainer><ChartTable caption="Median gross, operating and net margin by fiscal period" columns={["Period", "Gross margin", "Operating margin", "Net margin"]} rows={marginTrends.map((row) => [row.period, percent(row.gross), percent(row.operating), percent(row.net)])} /><ChartCaption lines={CHART_COPY.margins.lines} more={CHART_COPY.margins.more} /><ChartFreshness payload={payload} source="sec_xbrl" dataThrough={latestFactFiled} /></div>}
    </section>

    <section className="panel">
      <SectionHead index="04b" title="What the market pays for them" term="Yahoo Finance multiples"
        description="These are vendor figures, not filings. Every number in the panel above is a value a company filed with the SEC; every number here is Yahoo Finance's, computed from a price the company does not set and an earnings basis Yahoo chooses. They are shown separately for that reason. Blanks are common: a REIT or a bank often has no meaningful P/E, and Yahoo reports none rather than a wrong one."
        asOf={asOfLabel(payload.companyMeta.map((row) => String(row.as_of)))} />
      <VendorMultiples meta={payload.companyMeta} holdings={selectedHoldings} />
    </section>

    <section className="panel" id="private-capital">
      <SectionHead index="05" title="Reg D placements" term="SEC Form D filings" description="Reported Form D amounts, grouped into offerings by the file number EDGAR keeps constant across a filing and its amendments, and placed in the quarter each offering began rather than the quarter it was last amended. Filings without reported amounts contribute to counts, not dollars. An amendment restates an offering's cumulative total rather than adding to it, so dollar figures count each offering once at its latest reported figure. A fund raising capital is not an operating industry, so two kinds of pooled vehicle are excluded on the filer's own answers: those selecting Pooled Investment Fund as their industry, and those saying the security sold is an interest in a pooled investment fund, which is how insurance separate accounts filing under Insurance are caught. Vehicles are most Form D filings, so these counts are a minority of all filings. Amounts are unverified self-reports and the SEC does not check them. Which filings appear here is decided by the industry category the filer picked on the form, falling back to the issuer's SIC code in EDGAR where that category maps to no sector: only 5% of these filings carry a SIC code that resolves at all, so membership is mostly the filer's own idea of its industry rather than a classification of its business, and it is coarser than the fund definition used everywhere else on this page." asOf={asOfLabel(payload.formD.map((row) => row.filed_date))} />
      <div className="stat-grid stat-grid-three"><Stat label="Form D filings" term="Distinct accessions" value={counts.filings.toLocaleString()} /><Stat label="Offerings" term="Distinct file numbers" value={counts.offerings.toLocaleString()} /><Stat label="Total raised" term="Where an amount was reported" value={offerings.some((row) => row.amountSold !== null) ? money(totalRaised(offerings.map((row) => row.latest))) : "-"} /><Stat label="Typical raise" term="Median offering that has taken money" value={medianReportedRaise === null ? "-" : money(medianReportedRaise)} /><Stat label="Raised as debt" term="Share of classified dollars" value={debt.share === null ? "-" : percent(debt.share)} /><Stat label="Offerings per quarter" term="Median quarter" value={offeringsPerQuarter === null ? "-" : Math.round(offeringsPerQuarter).toLocaleString()} /></div>
      <FormDCoverage coverage={formDCoverage} start={start} end={end} />
      <FormDConcentration offerings={offerings} />
      {nothingSoldYet > 0 && <p className="provenance">
        {plural(nothingSoldYet, "offering")} here reported no securities sold as of the filing. They
        are counted as offerings and shown as &ldquo;None yet&rdquo;, and they are left out of the
        typical raise, which is the median of the offerings that have taken money.
      </p>}
      <FormDReconciliation counts={counts} issuers={new Set(formDInRange.map((row) => row.cik ?? row.issuer_name)).size} undated={undatedRaised} debt={debt} />
      <div className="chart-shell">
        <ChartHeading title="Placements by quarter" term="Form D amount sold by quarter" definition={CHART_COPY.formd.definition} />
        {/* Fewer than four quarters cannot show a trend, and drawing three bars
            invites one to be read as one. Say what the coverage is instead. */}
        {privateCapital.length < MINIMUM_QUARTERS
          ? <div className="source-error">{privateCapital.length === 0
              ? "SEC Form D: no offering in this sector has a known start quarter inside the selected window."
              : `SEC Form D: ${privateCapital.length} quarter${privateCapital.length === 1 ? "" : "s"} of data here, which is too few to plot a trend. The offerings themselves are in the table below. Widen the date range to see the chart.`}</div>
          : <ResponsiveContainer width="100%" height={320}><BarChart data={privateCapital} role="img" aria-label={`Bar chart. ${CHART_COPY.formd.lines}`}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="quarter" tick={{ fontSize: 10 }} /><YAxis tickFormatter={(value) => money(Number(value))} tick={{ fontSize: 10 }} /><Tooltip formatter={(value, _name, item) => [`${money(Number(value))} across ${(item?.payload?.count ?? 0).toLocaleString()} offering${item?.payload?.count === 1 ? "" : "s"}`, "Amount sold"]} /><Bar dataKey="raised" name="Form D amount sold" fill="#1d6b4d" /></BarChart></ResponsiveContainer>}
        <ChartCaption lines={CHART_COPY.formd.lines} more={CHART_COPY.formd.more} />
        <ChartFreshness payload={payload} source="form_d" dataThrough={formDCoverage.latest ?? undefined} />
      </div>
      <FormDIssuers offerings={offerings} />
    </section>

    <section className="panel" id="macro">
      <SectionHead index="06" title="Economic backdrop" term="FRED, EIA and BLS series" description="Sector-relevant FRED, EIA, and BLS raw series aligned to the same date window." asOf={asOfLabel(payload.macro.meta.map((row) => row.as_of))} />
      <div className="small-multiples">{payload.macro.meta.slice(0, MACRO_VISIBLE).map((meta) => <MacroChart key={meta.series_id} meta={meta} points={macroPoints(meta)} />)}</div>
      {payload.macro.meta.length > MACRO_VISIBLE && <details className="macro-more">
        <summary>Show all {payload.macro.meta.length} indicators</summary>
        <div className="small-multiples">{payload.macro.meta.slice(MACRO_VISIBLE).map((meta) => <MacroChart key={meta.series_id} meta={meta} points={macroPoints(meta)} />)}</div>
      </details>}
      {!payload.macro.meta.length && <div className="source-error">Macro sources: no metadata is available.</div>}
    </section>

    <section className="panel" id="timeline">
      <SectionHead index="07" title="News and events" term="GDELT volume, live coverage and NYT headlines" description="Quantitative GDELT activity above. Below it, human-curated events, then coverage from two feeds with different lags: GDELT indexes publishers continuously, while the NYT Archive publishes a month at a time once that month has completed." asOf={asOfLabel([...payload.newsVolume.map((row) => row.date), ...payload.headlines.map((row) => row.published_date)])} />
      {gdeltRun?.status === "failed" && <div className="source-error">GDELT · {readableError(gdeltRun.error_message)} · coverage below may be incomplete.</div>}
      <div className="chart-shell"><ChartHeading title="How much coverage, and how positive" term="GDELT article volume and average tone" definition={CHART_COPY.news.definition} />{newsInRange.length ? <ResponsiveContainer width="100%" height={300}><ComposedChart data={newsInRange} role="img" aria-label={`Combination chart. ${CHART_COPY.news.lines}`}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="date" minTickGap={40} tick={{ fontSize: 10 }} tickFormatter={axisDate} /><YAxis yAxisId="volume" tickFormatter={(value) => number(Number(value))} tick={{ fontSize: 10 }} /><YAxis yAxisId="tone" orientation="right" tickFormatter={(value) => number(Number(value))} tick={{ fontSize: 10 }} /><Tooltip formatter={(value, name) => [`${number(Number(value))}${String(name) === "article_volume" ? " articles" : " tone points"}`, String(name)]} labelFormatter={(value) => fullDate(String(value))} /><Legend /><Bar yAxisId="volume" dataKey="article_volume" name="Articles" fill="#b7e55c" /><EventBands events={payload.events} start={start} end={end} /><Line yAxisId="tone" dataKey="avg_tone" name="Average tone" dot={false} stroke="#143142" /></ComposedChart></ResponsiveContainer> : <ChartEmpty source="GDELT" />}<EventRail events={timelineEvents} start={start} end={end} onSelect={selectEvent} /><ChartCaption lines={CHART_COPY.news.lines} more={CHART_COPY.news.more} /><ChartFreshness payload={payload} source="gdelt" dataThrough={newsInRange.at(-1)?.date} /></div>
      {timelineEvents.length > 0 && <>
        <h3 className="timeline-group">Events</h3>
        <FeedNote>Events are written by hand against a source, not collected, so this list is only as current as its last review{curatedThrough ? `, which was ${curatedThrough}` : ""}. It is a record of things with a lasting effect on a sector, not a feed of what happened today; that is below.</FeedNote>
        <div className="timeline-list">{timelineEvents.map((event) => <article className={`timeline-item event ${event.impact}`} id={`event-${event.id}`} key={`e:${event.id}`}>
          <div className="timeline-date">{event.start_date}{event.end_date && event.end_date !== event.start_date ? ` – ${event.end_date}` : ""} · CURATED EVENT</div>
          <h3>{event.title}</h3>
          <p>{event.blurb}</p>
          <button className="chip" onClick={() => setSelectedEventId(selectedEvent?.id === event.id ? null : event.id)}>Return over this window</button>
          {event.source_url && <a href={event.source_url} target="_blank" rel="noreferrer">Source ↗</a>}
        </article>)}</div>
      </>}
      {coverage.length > 0 && <>
        <h3 className="timeline-group">Coverage</h3>
        <FeedNote>{coverageFeeds}</FeedNote>
        <div className="timeline-list">{visibleCoverage.map((item, index) => <div key={`h:${item.id}`}>
          {(index === 0 || item.published_date.slice(0, 7) !== visibleCoverage[index - 1].published_date.slice(0, 7))
            && <div className="month-divider">{monthLabel(item.published_date)}</div>}
          <article className="timeline-item">
            <div className="timeline-date">{stamp(item.published_date)}{relativeTime(item.published_date) ? ` · ${relativeTime(item.published_date)}` : ""} · {item.source}{item.section ? ` · ${item.section}` : ""}</div>
            <h3><a href={item.url} target="_blank" rel="noreferrer">{item.headline} ↗</a></h3>
            {item.abstract && <p>{item.abstract}</p>}
          </article>
        </div>)}</div>
        {coverageShown < coverage.length && <button className="chip show-more" onClick={() => setCoverageShown(coverageShown + COVERAGE_PAGE)}>Show more ({coverage.length - coverageShown} remaining)</button>}
      </>}
      {!timelineEvents.length && !coverage.length && <div className="source-error">No events or headlines in this window. Try a longer range.</div>}
    </section>
  </main>;
}

/**
 * Funds from different sectors on one axis.
 *
 * Bonds, municipals and property each live on their own page, but a reader
 * deciding where income should sit is comparing them against each other, and
 * that comparison had nowhere to happen.
 */
function FundComparisonPanel(
  { comparison, start, end }: { comparison: FundComparison; start: string; end: string },
) {
  const chart = useMemo(() => {
    const byDate = new Map<string, Record<string, number | string>>();
    for (const entry of comparison.series) {
      const windowed = entry.points.filter((point) => point.date >= start && point.date <= end);
      for (const point of investmentValue(windowed, 10_000)) {
        const row = byDate.get(point.date) ?? { date: point.date };
        row[entry.ticker] = point.value;
        byDate.set(point.date, row);
      }
    }
    return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [comparison.series, start, end]);

  return <div className="chart-shell" style={{ marginTop: 20 }}>
    <ChartHeading title={comparison.name} term="Growth of $10,000, dividends reinvested" />
    <p className="panel-description">{comparison.blurb}</p>
    {chart.length > 1
      ? <ResponsiveContainer width="100%" height={300}><LineChart data={chart} role="img" aria-label="Line chart. Growth of $10,000 in each fund, dividends reinvested. The same funds and their returns are listed in the table below the chart.">
          <CartesianGrid stroke="#e4e6df" vertical={false} />
          <XAxis dataKey="date" ticks={distinctMonthTicks(chart.map((row) => String(row.date)))} tick={{ fontSize: 10 }} tickFormatter={axisDate} />
          <YAxis tickFormatter={(value) => money(Number(value))} tick={{ fontSize: 10 }} width={72} />
          <Tooltip formatter={(value, name) => [money(Number(value)), String(name)]} itemSorter={byValueDescending} labelFormatter={(value) => fullDate(String(value))} />
          <Legend />
          {comparison.series.map((entry, index) => <Line key={entry.ticker} dataKey={entry.ticker}
            dot={false} connectNulls stroke={COLORS[index % COLORS.length]} strokeWidth={1.6} />)}
        </LineChart></ResponsiveContainer>
      : <ChartEmpty source="Prices" />}
    <div className="data-table-wrap" tabIndex={0}><table>
      <caption className="visually-hidden">Total return over the selected date range for each fund in this comparison.</caption>
      <thead><tr><th scope="col">Fund</th><th scope="col">Total return in range</th></tr></thead>
      <tbody>{comparison.series.map((entry) => <tr key={entry.ticker}>
        <td><Link href={`/etf/${entry.ticker}`}>{entry.ticker}</Link></td>
        <td>{percent(cumulativeReturn(entry.points.filter((point) => point.date >= start && point.date <= end)))}</td>
      </tr>)}</tbody>
    </table></div>
    <PeerSpread comparison={comparison} start={start} end={end} />
  </div>;
}

/**
 * A named group of companies, charted together and listed with their weights.
 *
 * The sector registry answers which fund tracks an industry. It cannot answer
 * which companies people are actually talking about, because the issuer
 * holdings files carry a sub-sector column whose every value is literally "-".
 * These groups are curated instead, which makes their membership an opinion
 * rather than a fact from a filing, and the panel says so.
 *
 * The lines are weekly, because daily bars for every company inside the funds
 * do not fit the database. Over the multi-year spans these groups are read at,
 * a weekly close answers the same question.
 */
/** Two funds sold as the same theme can hold almost nothing in common. */
const PEER_SPREAD = .15;

/**
 * Says when funds tracking one theme disagree about what the theme is.
 *
 * BOTZ returned -0.47% against IRBO's +35.88% over the same window, and IGV
 * -2.18% against SKYY's +23.95%. Neither fund is wrong: a theme has no index
 * committee, so each issuer writes its own inclusion rules and the funds end up
 * holding different companies. Shown side by side without that, the gap reads
 * as one of them tracking the sector badly.
 */
function PeerSpread(
  { comparison, start, end }: { comparison: FundComparison; start: string; end: string },
) {
  const returns = comparison.series
    .map((entry) => ({
      ticker: entry.ticker,
      value: cumulativeReturn(entry.points.filter((point) => point.date >= start && point.date <= end)),
    }))
    .filter((entry): entry is { ticker: string; value: number } => entry.value !== null);
  if (returns.length < 2) return null;
  const best = returns.reduce((a, b) => (b.value > a.value ? b : a));
  const worst = returns.reduce((a, b) => (b.value < a.value ? b : a));
  if (best.value - worst.value < PEER_SPREAD) return null;
  return <p className="provenance">
    {best.ticker} returned {percent(best.value)} over this window and {worst.ticker}{" "}
    {percent(worst.value)}. A theme has no index committee, so each issuer writes its own inclusion
    rules and funds with the same label hold different companies. Read the gap as disagreement about
    what belongs in the theme, not as one fund tracking it badly.
  </p>;
}

function CompanyGroupPanel({ group, start, end }: { group: SectorGroup; start: string; end: string }) {
  const [open, setOpen] = useState(false);
  const members = useMemo(
    () => [...group.members].sort((a, b) => (b.market_cap ?? -1) - (a.market_cap ?? -1)),
    [group.members],
  );
  const chart = useMemo(() => {
    const byDate = new Map<string, Record<string, number | string>>();
    for (const member of members) {
      const windowed = member.weekly.filter((point) => point.date >= start && point.date <= end);
      for (const point of investmentValue(windowed, 10_000)) {
        const row = byDate.get(point.date) ?? { date: point.date };
        row[member.ticker] = point.value;
        byDate.set(point.date, row);
      }
    }
    return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [members, start, end]);

  const shown = open ? members : members.slice(0, 6);
  // The table collapses to six; the chart does not, because a legend that omits
  // a company the heading counts reads as a missing company rather than a
  // shortened list. Beyond the palette there is no way to tell lines apart.
  const charted = members.slice(0, COLORS.length);
  return <div className="chart-shell" style={{ marginTop: 20 }}>
    <ChartHeading title={group.name} term={`${members.length} companies, weekly closes, dividends reinvested`} />
    {charted.length < members.length && <p className="grid-note">The chart draws the {charted.length} largest by market value; the table lists all {members.length}.</p>}
    <p className="panel-description">{group.blurb}</p>
    {chart.length > 1
      ? <ResponsiveContainer width="100%" height={300}><LineChart data={chart} role="img" aria-label="Line chart. Growth of $10,000 in each company in this group, dividends reinvested. The same companies and their returns are listed in the table below the chart.">
          <CartesianGrid stroke="#e4e6df" vertical={false} />
          <XAxis dataKey="date" ticks={distinctMonthTicks(chart.map((row) => String(row.date)))} tick={{ fontSize: 10 }} tickFormatter={axisDate} />
          <YAxis tickFormatter={(value) => money(Number(value))} tick={{ fontSize: 10 }} width={72} />
          <Tooltip formatter={(value, name) => [money(Number(value)), String(name)]} itemSorter={byValueDescending} labelFormatter={(value) => fullDate(String(value))} />
          <Legend />
          {charted.map((member, index) => <Line key={member.ticker} dataKey={member.ticker} dot={false}
            connectNulls stroke={COLORS[index]} strokeWidth={1.4} />)}
        </LineChart></ResponsiveContainer>
      : <ChartEmpty source="Weekly company prices" />}
    <div className="data-table-wrap" tabIndex={0}><table>
      <caption className="visually-hidden">Each company in this group, with its market capitalisation and its total return over the selected date range.</caption>
      <thead><tr><th scope="col">Company</th><th scope="col">Name</th><th scope="col">Market cap</th><th scope="col">Total return in range</th></tr></thead>
      <tbody>{shown.map((member) => {
        const windowed = member.weekly.filter((point) => point.date >= start && point.date <= end);
        return <tr key={member.ticker}>
          <td><Link href={`/company/${member.ticker}`}>{member.ticker}</Link></td>
          <td>{member.name ?? "-"}</td>
          <td>{member.market_cap === null ? "-" : money(member.market_cap)}</td>
          <td>{percent(cumulativeReturn(windowed))}</td>
        </tr>;
      })}</tbody>
    </table></div>
    {members.length > 6 && <button className="chip show-more" onClick={() => setOpen(!open)}>
      {open ? "Show fewer" : `Show all ${members.length}`}
    </button>}
    {group.funds.length > 0 && <>
      <ChartHeading title="Funds holding this group" term="Share of each fund, latest validated file" />
      <div className="data-table-wrap" tabIndex={0}><table>
        <caption className="visually-hidden">Each fund that holds companies from this group, with its share of the fund and how many members it holds.</caption>
        <thead><tr><th scope="col">Fund</th><th scope="col">Share of the fund</th><th scope="col">Members held</th><th scope="col">As of</th></tr></thead>
        <tbody>{group.funds.map((row) => <tr key={row.fund_ticker}>
          <td><Link href={`/etf/${row.fund_ticker}`}>{row.fund_ticker}</Link></td>
          <td>{percent(row.weight)}</td>
          <td>{row.members} of {group.members.length}</td>
          <td>{row.as_of}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="provenance">Owning one of these funds is how a reader gets this group without buying each company. Only funds whose published holdings file parsed to a full portfolio appear, so a fund with no usable file is absent rather than shown at zero.</p>
    </>}
    <p className="provenance">Membership of this group is a curated judgement, not something any filing states. Each line starts at $10,000 on the first week of the range. Companies with no price history held are left out rather than shown flat.</p>
  </div>;
}

/**
 * The funds on the chart above, each linking to its own page.
 *
 * The chart names them in a legend that cannot be clicked, so a reader who
 * wanted the fees, risk figures or composition of one of them had nowhere to go.
 */
function FundLinks({ tickers, primary }: { tickers: string[]; primary: string }) {
  if (!tickers.length) return null;
  return <p className="provenance">
    Open a fund for its fees, risk figures and holdings:{" "}
    {tickers.map((ticker, index) => <span key={ticker}>
      {index > 0 ? " · " : ""}
      <Link href={`/etf/${ticker}`}>{ticker}</Link>{ticker === primary ? " (primary)" : ""}
    </span>)}
  </p>;
}

/** A short line saying what a feed is and how current it can be. */
function FeedNote({ children }: { children: React.ReactNode }) {
  return children ? <p className="provenance feed-note">{children}</p> : null;
}

/**
 * Says so when the composition on screen is not the sector's own fund.
 *
 * Nine funds publish no holdings file this site can read, so the panel falls
 * back to whichever comparison fund does. Semiconductors then showed XSD's
 * equal-weight portfolio, whose largest position is PI at 3.51%, under a
 * heading a reader takes for SMH. The substitution is reasonable; presenting it
 * unlabelled is not.
 */
function SubstituteFundNote(
  { shown, primary, reason }: { shown: string; primary: string; reason: string | null },
) {
  if (shown === primary) return null;
  return <p className="provenance">
    This composition is {shown}, not {primary}. {primary} publishes no holdings file this
    site can parse{reason ? ` (${reason})` : ""}, so a comparison fund from the same sector
    is shown instead. Its portfolio is built differently and its weights are its own.
  </p>;
}

/**
 * What the fundamentals below actually cover.
 *
 * The SEC walk cannot fetch every company in one run, so a page can hold
 * figures for part of its fund. Printing a "sector median" over that subset
 * without saying so is the part that misleads: Energy's median was taken with
 * XOM absent, and XOM is a fifth of the fund.
 */
function CompsCoverage({ coverage }: { coverage: FactsCoverage }) {
  if (!coverage.constituents) return null;
  const share = `${Math.round(coverage.weightCovered * 100)}% of the fund by weight`;
  if (coverage.reliable) {
    return <p className="provenance">
      Reported figures for {coverage.covered} of {coverage.constituents} constituents, {share}.
    </p>;
  }
  const missingLargest = coverage.largest && !coverage.largest.covered
    ? ` The largest holding, ${coverage.largest.ticker} at ${percent(coverage.largest.weight)} of the fund, is among them.`
    : "";
  return <p className="provenance">
    Reported figures for {coverage.covered} of {coverage.constituents} constituents, {share}.
    {missingLargest} Sector percentiles are withheld until coverage is complete enough to mean
    something: a median of whichever companies have been collected is not a median of the sector.
    The company rows below are each as filed.
  </p>;
}

const COMPS_DEFINITION = "Every company held by this sector's fund that files with the SEC, with the figures it reported for its most recent period. The sector rows at the top are percentiles across those companies, so you can see where any one of them sits against its peers.";

// Three bars cannot show a trend, and drawing them invites one to be read as
// one. Below this the panel states its coverage instead.
const MINIMUM_QUARTERS = 4;

/**
 * What Form D actually covers, which is rarely the window the reader picked.
 *
 * The panel used to describe its contents as "this window", which claimed the
 * selected range. The collector holds published quarters plus however much of
 * the quarter in progress has been crawled, so the real range is usually
 * narrower at both ends, and saying so is the difference between a gap and a
 * finding.
 */
function FormDCoverage(
  { coverage, start, end }: { coverage: Coverage; start: string; end: string },
) {
  const note = coverageNote(coverage, start, end);
  return note ? <p className="provenance">{note}</p> : null;
}

/**
 * Says when a sector total is really one filing.
 *
 * Form D amounts are what the filer typed and the SEC does not check them, so a
 * single claim can carry a whole sector: Republic Airways was 76% of Transport
 * and Madison Air Solutions half of Industrials. Presented as a total, that
 * reads as a market size rather than as one unverified number.
 */
function FormDConcentration({ offerings }: { offerings: Offering<IndustryPayload["formD"][number]>[] }) {
  const biggest = largestShare(offerings);
  if (!biggest || biggest.share < DOMINANCE_THRESHOLD) return null;
  return <p className="provenance">
    One offering is {percent(biggest.share)} of the reported total here:{" "}
    {biggest.offering.latest.issuer_name} at {money(biggest.offering.amountSold ?? 0)}. Amounts on
    Form D are what the filer typed and the SEC does not verify them, so read this total as one
    large claim plus everything else, not as a measured figure.
  </p>;
}

/**
 * The four counts that have to agree, stated as one sentence a reader can check.
 *
 * Before this, the panel showed a filing count and an offering count with no
 * relationship between them, so both could not be true at once. The identity is
 * printed only when it actually holds for this window.
 */
function FormDReconciliation(
  { counts, issuers, undated, debt }:
  { counts: FormDCounts; issuers: number; undated: number; debt: DebtSplit },
) {
  if (!counts.filings) return null;
  const { filings, offerings, amendments, orphanOfferings } = counts;
  // Composed as one string rather than as sibling JSX expressions, because JSX
  // puts whitespace between lines and it lands in front of the punctuation.
  const sentence = [
    `${plural(filings, "filing")} from ${plural(issuers, "issuer")} resolve to ${plural(offerings, "offering")}`,
    amendments ? `, because ${plural(amendments, "filing")} ${verb(amendments, "restates", "restate")} an offering already counted` : "",
    ".",
    orphanOfferings
      ? ` ${plural(orphanOfferings, "offering")} appear here only as amendments, their originals having been filed before the data begins, so ${orphanOfferings === 1 ? "its start date is not known and it is" : "their start dates are not known and they are"} left out of the quarterly chart below while staying in the table.${undated > 0 ? ` That is why the bars total less than the figure above: ${money(undated)} of the money shown sits in offerings with no quarter to put it in.` : ""}`
      : "",
    counts.reconciles
      ? ` Filings equal offerings plus restatements, less the ${plural(orphanOfferings, "offering")} with no original here: ${offerings.toLocaleString()} + ${amendments.toLocaleString()} \u2212 ${orphanOfferings.toLocaleString()} = ${filings.toLocaleString()}.`
      : " These counts do not reconcile, which means an offering here carries more than one original filing.",
    debt.unclassified > 0
      ? ` The debt share is measured over the ${money(debt.classified)} whose filers said what kind of security they were selling; a further ${money(debt.unclassified)} ticked no box and is counted in the total but not in that share.`
      : "",
    debt.mixed > 0
      ? ` ${debt.mixed.toLocaleString()} offering${debt.mixed === 1 ? " sells" : "s sell"} equity and debt together and ${debt.mixed === 1 ? "is" : "are"} counted in full as debt, because the form does not ask how the money splits.`
      : "",
  ].join("");
  return <p className="provenance">{sentence}</p>;
}

/**
 * Who actually raised the money. The panel above answers "how much"; without
 * this a reader cannot see which companies the total is made of, or that most
 * Form D filers are funds rather than operating businesses.
 */
function FormDIssuers({ offerings }: { offerings: Offering<IndustryPayload["formD"][number]>[] }) {
  const [open, setOpen] = useState(false);
  if (!offerings.length) return null;
  const ranked = [...offerings].sort((a, b) => (b.amountSold ?? -1) - (a.amountSold ?? -1));
  const shown = open ? ranked : ranked.slice(0, 10);
  const coIssued = offerings.filter((row) => (row.latest.issuer_count ?? 1) > 1).length;
  const amended = offerings.filter((row) => row.amendments > 0).length;
  const flagged = offerings.filter((row) => row.latest.pooled_name_match).length;
  return <div style={{ marginTop: 24 }}>
    <ChartHeading title="Who raised it" term="One row per offering" definition="Every offering behind the totals above, largest first. An offering appears once: where a company amended its filing, the row shows the most recent figure it reported, not the sum of its filings. Started is the date of the original filing, so amending does not move an offering to a later date." />
    <p className="provenance">Grouped by the 021 file number EDGAR keeps constant across an offering and its amendments{amended ? `; ${plural(amended, "of these has", "of these have")} been amended at least once` : ""}{coIssued ? `, and ${coIssued.toLocaleString()} name co-issuers, shown once under the primary issuer` : ""}. Industry is the issuer&rsquo;s own selection on the form. Name pattern marks {flagged.toLocaleString()} offering{flagged === 1 ? "" : "s"} whose issuer is named like a pooled vehicle; unlike the two exclusions above, a name drops nothing, because plenty of operating businesses are limited partnerships.</p>
    <div className="data-table-wrap" tabIndex={0}><table>
      <caption className="visually-hidden">Every Form D offering behind the totals above, largest first, with its dates, self-selected industry and reported amounts.</caption>
      <thead><tr><th scope="col">Issuer</th><th scope="col">Started</th><th scope="col">Latest filing</th><th scope="col">Industry (self-selected)</th><th scope="col">Name pattern</th><th scope="col">Reported raised</th><th scope="col">Offering size</th><th scope="col">Place</th></tr></thead>
      <tbody>{shown.map((row) => <tr key={row.key}>
        <td>{row.latest.issuer_name}{row.latest.issuer_ticker && <Annotated className="chip-inline" note="Already an SEC reporting company. A listed company placing securities privately files this same form."> listed · {row.latest.issuer_ticker}</Annotated>}{coIssuerLabel(row.latest) && <span className="chip-inline"> {coIssuerLabel(row.latest)}</span>}</td>
        <td>{row.originUnknown
          ? <Annotated note="The original filing predates this data, so this is the date of the earliest amendment held here.">Before {row.startDate}<span className="chip-inline"> start unknown</span></Annotated>
          : row.startDate}</td>
        <td>{row.latest.filed_date}{row.amendments ? <span className="chip-inline"> +{row.amendments} amendment{row.amendments === 1 ? "" : "s"}</span> : null}</td>
        <td>{row.latest.industry_group ?? "Not stated"}</td>
        <td>{row.latest.pooled_name_match
          ? <Annotated note="The name matches a pattern common among pooled vehicles. It is a hint only: nothing is excluded on the strength of a name, because plenty of operating businesses are limited partnerships.">{row.latest.pooled_name_match}</Annotated>
          : "-"}</td>
        <td>{row.amountSold === null ? "Not reported"
          : row.amountSold === 0 ? <Annotated note="The filer reported the offering but no securities sold as of this filing.">None yet</Annotated>
          : money(row.amountSold)}</td>
        <td>{row.latest.total_offering_amount === null ? "Not reported"
          : row.latest.total_offering_amount === 0
            ? <Annotated note="The filer reported no dollar amount. A Form D covers securities issued as consideration in an acquisition as well as securities sold for cash, and the first has no offering size.">No cash amount</Annotated>
            : money(row.latest.total_offering_amount)}</td>
        <td>{placeName(row.latest.state)}</td>
      </tr>)}</tbody>
    </table></div>
    {ranked.length > 10 && <button className="chip show-more" onClick={() => setOpen(!open)}>{open ? "Show fewer" : `Show all ${ranked.length} offerings`}</button>}
  </div>;
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
  return <><ChartHeading title="Return by calendar year" term="Calendar year total return" definition={CHART_COPY.calendar.definition} /><div className="data-table-wrap" tabIndex={0}><table><caption className="visually-hidden">Total return per calendar year for each fund on this page.</caption><thead><tr><th scope="col">ETF</th>{years.map((year) => <th key={year} scope="col">{labels[year]}</th>)}</tr></thead><tbody>{tickers.map((ticker) => <tr key={ticker}><td>{ticker}</td>{years.map((year) => { const value = periods[ticker].find((item) => item.year === year)?.value; return <td className={value === undefined ? "" : value >= 0 ? "positive-cell" : "negative-cell"} key={year}>{value === undefined ? "-" : percent(value)}</td>; })}</tr>)}</tbody></table></div><ChartCaption lines={CHART_COPY.calendar.lines} more={CHART_COPY.calendar.more} /></>;
}

function OverlapMatrix({ matrix, funds }: { matrix: Record<string, Record<string, number>>; funds: string[] }) {
  const valid = funds.filter((fund) => Object.keys(matrix[fund] ?? {}).length && matrix[fund][fund] > 0);
  if (valid.length < 2) return null;
  let best: [string, string, number] | null = null;
  valid.forEach((a, i) => valid.slice(i + 1).forEach((b) => { const value = matrix[a][b]; if (!best || value > best[2]) best = [a, b, value]; }));
  // Was a grid of divs. Which pair of funds a cell belonged to lived only in a
  // title attribute, so a screen reader got a flat run of tickers and
  // percentages with no way to tell which was which, and a keyboard could not
  // reach the title at all. A table carries the pairing in its own markup.
  // The shading stops at 70% opacity because past that neither dark nor light
  // text clears 4.5:1 against it, which is what the diagonal used to do.
  const shade = (value: number) => `rgba(29,107,77,${(.06 + Math.min(value, 1) * .64).toFixed(3)})`;
  return <div style={{ marginTop: 28 }}><ChartHeading title="How much these funds own the same stocks" term="Pairwise holdings overlap" definition={CHART_COPY.overlap.definition} />{best && <p className="panel-description">{best[0]} and {best[1]} share {(best[2] * 100).toFixed(2)}% of holdings by weight. Diagonal cells are self-comparisons.</p>}<div className="data-table-wrap" tabIndex={0}><table className="overlap-table"><caption className="visually-hidden">Share of holdings by weight that each pair of funds has in common. Each row is one fund compared with every column fund.</caption><thead><tr><td />{valid.map((fund) => <th key={fund} scope="col">{fund}</th>)}</tr></thead><tbody>{valid.map((row) => <tr key={row}><th scope="row">{row}</th>{valid.map((column) => { const value = matrix[row][column]; const self = row === column; return <td className={`overlap-cell${self ? " self" : ""}`} key={`${row}:${column}`} style={{ background: shade(value) }}>{self ? "Self" : percent(value)}</td>; })}</tr>)}</tbody></table></div><ChartCaption lines={CHART_COPY.overlap.lines} more={CHART_COPY.overlap.more} /></div>;
}

type CompRow = ReturnType<typeof compsRows>[number];
// company_meta stores a single as_of per ticker, so market cap is always
// today's value regardless of the selected range. The header says so rather
// than implying it is aligned to the window.
const METRIC_LABELS: Record<string, string> = {
  marketCap: "Market cap (current)",
  revenueGrowth: "Revenue growth",
  grossMargin: "Gross margin",
  operatingMargin: "Operating margin",
  netMargin: "Net margin",
};
/** Below this many reporting companies, a percentile describes its sample. */
const MIN_QUARTILE_OBSERVATIONS = 4;

/** A revenue move this large is usually a changed company, not a changed market. */
const STRUCTURAL_GROWTH = .4;

/**
 * The marks on figures that are correctly computed and read wrongly.
 *
 * Revenue growth compares a period against the same period a year earlier, and
 * a company that sold a division is not the same company in both: DD fell
 * 44.92% on the Qnity spin and DLTR 42.73% on Family Dollar, which look like
 * collapsing demand. Net margin above operating margin is likewise real and
 * looks like an error: income below the operating line, such as AMZN's equity
 * investment gains, can exceed operating profit. Neither can be detected from
 * the filed facts alone, so the page marks them rather than adjusting them.
 */
function growthNote(value: number | null): string | null {
  if (value === null || Math.abs(value) < STRUCTURAL_GROWTH) return null;
  return "A move this size usually means the company changed rather than its market: a spin-off, "
    + "a divestiture or a large acquisition changes what is being compared against last year. The "
    + "filed facts do not say which, so this is not adjusted.";
}

function marginNote(operating: number | null, net: number | null): string | null {
  if (operating === null || net === null || net <= operating) return null;
  return "Net margin above operating margin is not an error: income arising below the operating "
    + "line, such as investment gains or a tax benefit, can exceed operating profit for the period.";
}

/**
 * An annotation a keyboard and a screen reader can both get at.
 *
 * `title` reaches a mouse hover and nothing else: it is not focusable, it does
 * not appear on touch, and support for announcing it is uneven. The same words
 * now go into the accessibility tree as visually hidden text, and the tooltip
 * stays for the mouse users who already have it.
 */
function Annotated({ className, note, children }: { className?: string; note: string; children: ReactNode }) {
  return <span className={className} title={note}>{children}<span className="visually-hidden"> ({note})</span></span>;
}

function Marked({ value, note }: { value: string; note: string | null }) {
  return note
    ? <Annotated className="marked" note={note}>{value}<sup aria-hidden="true">*</sup></Annotated>
    : <>{value}</>;
}

/**
 * Multiples the vendor computed, kept away from the facts the companies filed.
 *
 * The panel above states that nothing in it is estimated, which is true because
 * every cell is a filed XBRL value. A trailing P/E is not one: it divides a
 * price by an earnings basis the vendor picks, and the two belong in different
 * panels with different attribution rather than in one table that would make
 * the first claim false.
 */
function VendorMultiples(
  { meta, holdings }: { meta: CompanyMeta[]; holdings: IndustryPayload["holdings"] },
) {
  const [open, setOpen] = useState(false);
  const weights = new Map(holdings.map((row) => [row.constituent_ticker, row.weight]));
  const rows = meta
    .filter((row) => weights.has(row.ticker))
    .filter((row) => row.trailing_pe !== null || row.forward_pe !== null
      || row.price_to_book !== null || row.dividend_yield !== null)
    .sort((a, b) => (b.market_cap ?? -1) - (a.market_cap ?? -1));
  if (!rows.length) {
    return <Unavailable>
      No vendor multiples are held for this fund&rsquo;s constituents. The reported figures above do
      not depend on them.
    </Unavailable>;
  }
  const shown = open ? rows : rows.slice(0, 20);
  return <>
    <div className="data-table-wrap" tabIndex={0}><table>
      <caption className="visually-hidden">Valuation multiples and dividend yield for each company in the fund.</caption>
      <thead><tr><th scope="col">Company</th><th scope="col">Weight</th><th scope="col">Trailing P/E</th><th scope="col">Forward P/E</th><th scope="col">Price to book</th><th scope="col">Dividend yield</th></tr></thead>
      <tbody>{shown.map((row) => <tr key={row.ticker}>
        <td><Link href={`/company/${row.ticker}`}>{row.ticker}</Link></td>
        <td>{percent(weights.get(row.ticker) ?? null, 2)}</td>
        <td>{number(row.trailing_pe)}</td>
        <td>{number(row.forward_pe)}</td>
        <td>{number(row.price_to_book)}</td>
        <td>{percent(row.dividend_yield)}</td>
      </tr>)}</tbody>
    </table></div>
    {rows.length > 20 && <button className="chip show-more" onClick={() => setOpen(!open)}>
      {open ? "Show fewer" : `Show all ${rows.length}`}
    </button>}
  </>;
}

/**
 * A column header that sorts the table.
 *
 * The handler used to sit on the `th` itself: no keyboard could reach it
 * (WCAG 2.1.1), and nothing on the page said which column the order was on. A
 * real button carries Enter and Space without a key handler of its own, and
 * `aria-sort` on the cell is what a screen reader reads when it enters the
 * column.
 */
function SortHeader({ active, direction, label, onSort }: {
  active: boolean; direction: "ascending" | "descending"; label: string; onSort: () => void;
}) {
  return <th aria-sort={active ? direction : "none"} scope="col">
    <button className="sort-header" onClick={onSort} type="button">
      {label}
      <span aria-hidden="true" className="sort-arrow">{active ? (direction === "ascending" ? "\u2191" : "\u2193") : ""}</span>
    </button>
  </th>;
}

function CompsTable({ rows, coverage }: { rows: CompRow[]; coverage: FactsCoverage }) {
  const [sortKey, setSortKey] = useState<keyof CompRow>("marketCap");
  // Company is a ticker, so it sorts A to Z; every other column is a number and
  // sorts largest first. The ticker branch used to fall through to the numeric
  // subtraction, which returns NaN for two strings: the rows only looked
  // alphabetical because that comparator left the incoming order alone.
  const ordered = [...rows].sort((a, b) => sortKey === "ticker"
    ? String(a.ticker).localeCompare(String(b.ticker))
    : ((b[sortKey] as number | null) ?? -Infinity) - ((a[sortKey] as number | null) ?? -Infinity));
  // Banks, Communication Services and Energy report no gross profit at all, so
  // the column was a full width of dashes on those pages.
  const metrics: (keyof CompRow)[] =
    (["marketCap", "revenueGrowth", "grossMargin", "operatingMargin", "netMargin"] as (keyof CompRow)[])
      .filter((metric) => rows.some((row) => typeof row[metric] === "number"));
  // A percentile over an arbitrary subset is not a sector percentile. They are
  // shown only when the fundamentals cover most of the fund and include its
  // largest holding; otherwise the reader gets the constituent rows and a
  // statement of what is missing.
  const summaries = coverage.reliable ? [
    { ticker: "Sector 25th percentile", q: .25 }, { ticker: "Sector median", q: .5 }, { ticker: "Sector 75th percentile", q: .75 },
  ] : [];
  const metricsWithData = (metric: keyof CompRow) =>
    rows.filter((row) => typeof row[metric] === "number").length;
  return <div className="data-table-wrap" tabIndex={0}><table><caption className="visually-hidden">Reported SEC XBRL fundamentals for every company in the fund, one row each, with the sector percentiles above them. Every column heading is a button that sorts the table.</caption><thead><tr><SortHeader active={sortKey === "ticker"} direction="ascending" label="Company" onSort={() => setSortKey("ticker")} /><th scope="col">Period</th>{metrics.map((metric) => <SortHeader active={sortKey === metric} direction="descending" key={metric} label={METRIC_LABELS[metric] ?? metric} onSort={() => setSortKey(metric)} />)}</tr></thead><tbody>{summaries.map((summary) => <tr key={summary.ticker}><td><strong>{summary.ticker}</strong></td><td>-</td>{metrics.map((metric) => { const observations = metricsWithData(metric); const value = observations < MIN_QUARTILE_OBSERVATIONS ? null : quantile(rows.map((row) => typeof row[metric] === "number" ? row[metric] as number : null), summary.q); return <td key={metric}>{value === null ? <Annotated note={`${plural(observations, "company")} in this fund reported it, too few for a percentile`}>-</Annotated> : metric === "marketCap" ? money(value) : percent(value)}</td>; })}</tr>)}{ordered.map((row) => <tr key={row.ticker}><td><Link href={`/company/${row.ticker}`}>{row.ticker}</Link></td><td>{row.period}</td><td>{row.marketCap === null ? "-" : money(row.marketCap)}</td><td><Marked value={percent(row.revenueGrowth)} note={growthNote(row.revenueGrowth)} /></td><td>{percent(row.grossMargin)}</td><td>{percent(row.operatingMargin)}</td><td><Marked value={percent(row.netMargin)} note={marginNote(row.operatingMargin, row.netMargin)} /></td></tr>)}</tbody></table></div>;
}

/**
 * What the macro line does, in a sentence.
 *
 * These series run to tens of thousands of daily observations, so the tabular
 * alternative the shorter charts get would be unreadable. The endpoints and the
 * extremes are what a sighted reader takes from the shape, so those are stated.
 */
function describeSeries(points: SeriesPoint[], meta: MacroMeta) {
  const values = points.map((point) => Number(point.value));
  const first = points[0], last = points[points.length - 1];
  const low = Math.min(...values), high = Math.max(...values);
  return `From ${unitValue(Number(first.value), meta.units)} on ${fullDate(String(first.date))} `
    + `to ${unitValue(Number(last.value), meta.units)} on ${fullDate(String(last.date))}, `
    + `over ${plural(points.length, "observation")}. `
    + `Lowest ${unitValue(low, meta.units)}, highest ${unitValue(high, meta.units)}.`;
}

function MacroChart({ meta, points }: { meta: MacroMeta; points: SeriesPoint[] }) {
  return <div className="chart-shell"><ChartHeading title={meta.label} definition={meta.definition ?? undefined} />{points.length ? <ResponsiveContainer width="100%" height={220}><LineChart data={points} role="img" aria-label={`Line chart of ${meta.label}${meta.units ? ` in ${meta.units}` : ""}. ${describeSeries(points, meta)}`}><CartesianGrid stroke="#e4e6df" vertical={false} /><XAxis dataKey="date" minTickGap={40} tick={{ fontSize: 9 }} tickFormatter={axisDate} /><YAxis tickFormatter={(value) => number(Number(value))} tick={{ fontSize: 9 }} /><Tooltip formatter={(value) => unitValue(Number(value), meta.units)} labelFormatter={(value) => fullDate(String(value))} /><Line dataKey="value" dot={false} stroke="#1d6b4d" /></LineChart></ResponsiveContainer> : <ChartEmpty source={meta.source} />}{meta.blurb && <ChartCaption lines={meta.blurb} />}<div className="as-of" style={{ textAlign: "left" }}>{meta.source} · {meta.units ?? "units unavailable"}<br />Data through {stampDate(points.at(-1)?.date ?? null)}{meta.last_release_date && <> · Released {stampDate(meta.last_release_date)}</>} · Ingest: {stamp(meta.as_of)}</div></div>;
}
