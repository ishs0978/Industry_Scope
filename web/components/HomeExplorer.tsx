"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import { formatPercent, formatPrice, formatPriceChange, formatSignedPercent, stamp, stampDate } from "@/lib/format";
import type { Sector } from "@/lib/types";
import type { CompanyGroup } from "@/lib/registry";
import type { HomeCompany } from "@/lib/data";

type Performance = Record<string, { prices: { date: string; value: number; close: number | null }[]; error?: string }>;

// Ingest runs once a day, so the newest row is always the previous session's
// close. Labelling it "Price" would teach a reader opening this mid-morning
// that the site is wrong; "Close · 13 Aug" is simply correct.
// Returns null rather than throwing. An unparseable date should drop the close
// line, never take down the whole page with RangeError: Invalid time value.
const closeDay = (value: string): string | null => {
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? null
    : new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", timeZone: "UTC" }).format(parsed);
};

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function distance(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) {
    matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return matrix[a.length][b.length];
}

/**
 * Ways into the pages behind the sector grid.
 *
 * Every fund, every company and every curated group has had its own page for a
 * while, and none of them was reachable from here: the landing page offered a
 * search box and a grid of sectors and gave no sign the rest existed. These are
 * entry points, not a second navigation; each one lands on the page that owns
 * the subject.
 */
function Explore(
  { funds, groups, companies }:
  { funds: { ticker: string; sector: Sector }[]; groups: CompanyGroup[]; companies: HomeCompany[] },
) {
  return <section>
    <div className="section-heading"><h2>Go deeper</h2><span className="eyebrow">Funds · groups · companies</span></div>
    <div className="explore">
      <div className="explore-col">
        <h3>Every fund</h3>
        <p>Fees, risk against the S&amp;P 500, drawdown and full composition, one page each.</p>
        <div className="explore-links">
          {/* The chip showed a ticker and put the sector in a title attribute,
              which reaches a mouse hover and nothing else. */}
          {funds.map((fund) => <Link href={`/etf/${fund.ticker}`} key={fund.ticker} title={fund.sector.name}>
            {fund.ticker}<span className="visually-hidden"> · {fund.sector.name}</span>
          </Link>)}
        </div>
      </div>
      <div className="explore-col">
        <h3>Groups worth watching</h3>
        <p>Companies grouped by what they do rather than by the fund that holds them, with the funds that give exposure to each.</p>
        <div className="explore-links">
          {groups.map((group) => <Link href={`/industry/${group.sector}#groups`} key={group.slug}>
            {group.name}
          </Link>)}
        </div>
      </div>
      <div className="explore-col">
        <h3>Largest companies</h3>
        <p>Valuation, analyst targets, reported margins and yearly returns. Every company in a fund has a page; these are the biggest.</p>
        {companies.length
          ? <div className="explore-links">
              {companies.map((company) => <Link href={`/company/${company.ticker}`} key={company.ticker} title={company.name ?? company.ticker}>
                {company.ticker}{company.name && <span className="visually-hidden"> · {company.name}</span>}
              </Link>)}
            </div>
          // An empty row reads as a broken column rather than a missing list.
          // Say which source is absent, the same way every other panel does.
          : <p className="grid-note">Company rankings need market caps from the database, which is unavailable. Open any sector and its companies are still listed there.</p>}
      </div>
    </div>
  </section>;
}

export default function HomeExplorer({ sectors, performance, pricesThrough, lastChecked, funds, groups, companies }: { sectors: Sector[]; performance: Performance; pricesThrough: string | null; lastChecked: string | null; funds: { ticker: string; sector: Sector }[]; groups: CompanyGroup[]; companies: HomeCompany[] }) {
  const [query, setQuery] = useState("");
  const search = useMemo(() => {
    const q = normalize(query);
    if (!q) return { matches: [] as Sector[], suggestions: [] as Sector[] };
    const ranked = sectors.map((sector) => {
      const candidates = [sector.name, ...sector.aliases].map(normalize);
      const exact = candidates.some((value) => value === q || value.includes(q));
      const score = exact ? 1 : Math.max(...candidates.map((value) => 1 - distance(q, value) / Math.max(q.length, value.length)));
      return { sector, score };
    }).sort((a, b) => b.score - a.score);
    const matches = ranked.filter((item) => item.score >= .62).map((item) => item.sector);
    return { matches, suggestions: matches.length ? [] : ranked.slice(0, 3).map((item) => item.sector) };
  }, [query, sectors]);
  const shown = search.matches.length ? search.matches : search.suggestions;

  return (
    <main id="main-content" tabIndex={-1}>
      <section className="home-hero">
        <div className="eyebrow">Built only from public data</div>
        <h1>See the whole industry.</h1>
        <p>Market performance, fund composition, SEC fundamentals, private capital, macro indicators, and sourced events-aligned to one date range.</p>
        <div className="search-wrap">
          <input aria-label="Search industries" placeholder="Search semiconductors, banking, renewable energy…" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && <div className="search-results">
            {!search.matches.length && <div className="search-note">No direct registry match. Closest sectors:</div>}
            {shown.map((sector) => <Link href={`/industry/${sector.slug}`} key={sector.slug}><span>{sector.name}</span><span className="ticker">{sector.primary_etf}</span></Link>)}
          </div>}
        </div>
      </section>

      <Explore funds={funds} groups={groups} companies={companies} />

      <section>
        <div className="section-heading"><h2>All industries</h2><span className="eyebrow">{sectors.length} sectors</span></div>
        <div className="grid-notes">
          <p className="grid-note">This registry mixes broad GICS sector funds with narrower thematic funds. Semiconductors, Technology, Software &amp; Cloud, AI &amp; Robotics and Cybersecurity overlap heavily by design, so compare them against each other rather than adding them together.</p>
          <p className="grid-note">The overlap is not only in technology. Industrials holds the railroads, parcel carriers and airlines that Transport &amp; Shipping is made of: UNP, CSX, NSC, UPS, FDX, DAL, EXPD and CHRW are 10.6% of XLI. Materials &amp; Mining holds Newmont at 8.0% of XLB, which is also a top holding of the gold miners fund. Sector totals across this grid count those companies more than once.</p>
          {/* prices.py stores Yahoo's Adj Close, which reinvests dividends, so
              "adjusted close" alone would not tell a reader whether XLU's number
              includes its yield. Say total return, and print both dates. */}
          <p className="grid-note">Total return, dividends reinvested. Prices through {stampDate(pricesThrough)}. Last checked {stamp(lastChecked)}.</p>
          <p className="grid-note">Each line is that fund&rsquo;s price path so far this year, scaled to its own range. Compare the shapes, not the heights.</p>
        </div>
        {performance.__error?.error && <div className="source-error">Neon Postgres: {performance.__error.error}</div>}
        <div className="sector-grid">
          {sectors.map((sector) => {
            const prices = performance[sector.primary_etf]?.prices ?? [];
            const ytd = prices.length > 1 && prices[0].value > 0 ? prices.at(-1)!.value / prices[0].value - 1 : null;
            // Close-to-close, both from `close`. On an ex-dividend day this
            // differs slightly from the adjusted return, which matches every
            // other quote source and must not be "fixed" with adj_close.
            const last = prices.at(-1);
            const previous = prices.at(-2);
            const change = last?.close != null && previous?.close != null ? last.close - previous.close : null;
            const changePercent = change !== null && previous?.close ? change / previous.close : null;
            return <Link className="sector-card" href={`/industry/${sector.slug}`} key={sector.slug}>
              <div className="sector-card-top"><h3>{sector.name}</h3><span className="ticker">{sector.primary_etf}</span></div>
              <div className={`return ${ytd !== null && ytd < 0 ? "negative" : ""}`}>{ytd === null ? "Unavailable" : formatPercent(ytd)} <small>YTD</small></div>
              {last?.close != null && <div className="close-line">
                {formatPrice(last.close)} {closeDay(last.date) && <span className="close-day">Close · {closeDay(last.date)}</span>}
                {change !== null && <span className={change >= 0 ? "up" : "down"}> {formatPriceChange(change)} ({formatSignedPercent(changePercent)})</span>}
              </div>}
              {/* Recharts defaults the y-domain to [0, dataMax], which compressed a
                  $290 fund's 56% move against the top of a box starting at zero.
                  Amplitude then encoded price level rather than return. */}
              <div className="mini-chart">{prices.length > 1 && <ResponsiveContainer width="100%" height="100%"><LineChart data={prices} aria-hidden={true} tabIndex={-1}><YAxis hide domain={["dataMin", "dataMax"]} /><Line dataKey="value" dot={false} stroke={ytd !== null && ytd < 0 ? "#a4463f" : "#1d6b4d"} strokeWidth={1.6} /></LineChart></ResponsiveContainer>}</div>
            </Link>;
          })}
        </div>
      </section>
    </main>
  );
}
