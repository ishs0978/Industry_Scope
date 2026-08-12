"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { formatPercent } from "@/lib/format";
import type { Sector } from "@/lib/types";

type Performance = Record<string, { prices: { date: string; value: number }[]; error?: string }>;

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

export default function HomeExplorer({ sectors, performance }: { sectors: Sector[]; performance: Performance }) {
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
    <main>
      <section className="home-hero">
        <div className="eyebrow">Public industry intelligence</div>
        <h1>See the whole industry.</h1>
        <p>Market performance, fund composition, SEC fundamentals, private capital, macro indicators, and sourced events—aligned to one date range.</p>
        <div className="search-wrap">
          <input aria-label="Search industries" placeholder="Search semiconductors, banking, renewable energy…" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && <div className="search-results">
            {!search.matches.length && <div className="search-note">No direct registry match. Closest sectors:</div>}
            {shown.map((sector) => <Link href={`/industry/${sector.slug}`} key={sector.slug}><span>{sector.name}</span><span className="ticker">{sector.primary_etf}</span></Link>)}
          </div>}
        </div>
      </section>

      <section>
        <div className="section-heading"><h2>Industry registry</h2><span className="eyebrow">20 sectors</span></div>
        {performance.__error?.error && <div className="source-error">Neon Postgres: {performance.__error.error}</div>}
        <div className="sector-grid">
          {sectors.map((sector) => {
            const prices = performance[sector.primary_etf]?.prices ?? [];
            const ytd = prices.length > 1 && prices[0].value > 0 ? prices.at(-1)!.value / prices[0].value - 1 : null;
            return <Link className="sector-card" href={`/industry/${sector.slug}`} key={sector.slug}>
              <div className="sector-card-top"><h3>{sector.name}</h3><span className="ticker">{sector.primary_etf}</span></div>
              <div className={`return ${ytd !== null && ytd < 0 ? "negative" : ""}`}>{ytd === null ? "Unavailable" : formatPercent(ytd)} <small>YTD</small></div>
              <div className="mini-chart">{prices.length > 1 && <ResponsiveContainer width="100%" height="100%"><LineChart data={prices}><Line dataKey="value" dot={false} stroke={ytd !== null && ytd < 0 ? "#a4463f" : "#1d6b4d"} strokeWidth={1.6} /></LineChart></ResponsiveContainer>}</div>
            </Link>;
          })}
        </div>
      </section>
    </main>
  );
}
