import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import YAML from "yaml";
import {
  fundByTicker, fundGroupsForSector, groupsForSector, sectorBySlug,
  type CompanyGroup, type FundGroup,
} from "./registry";
import { SECTOR_FACT_METRICS } from "./comps";
import { packFormD } from "./formd";
import { packRows } from "./wire";
import { MACRO_POINT_COLUMNS, PRICE_COLUMNS } from "./types";
import type {
  CompanyPayload, FundComparison, GroupFundExposure, GroupMember, SectorGroup, EtfPayload, FundHolder, IndustryPayload, MacroPoint, Price,
  WireIndustryPayload, Sector, SourceError,
} from "./types";

/**
 * One connection pool for the whole process.
 *
 * Every loader used to open its own pool and close it in a finally block. That
 * was fine when a build rendered 26 pages; at 84 it meant 84 connect and
 * disconnect cycles against Neon, which timed a page out after 60 seconds and
 * later killed a connection mid-build. Neon is also happier with a few
 * long-lived connections than with a churn of short ones.
 *
 * Nothing calls end() any more: the pool lives as long as the process, and Node
 * exiting closes the sockets.
 */
/**
 * The connection string, without the whitespace a paste tends to carry.
 *
 * A connection string pasted into a secrets field picks up a trailing newline
 * remarkably easily, and Postgres reads it as part of the last parameter:
 * sslmode becomes "require\n", which is not a valid mode. Every query then
 * fails with an error that says nothing about newlines.
 */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim() || undefined;
}

let pool: ReturnType<typeof postgres> | null = null;

function db() {
  if (!pool) {
    pool = postgres(databaseUrl()!, {
      ssl: "require", max: 10, idle_timeout: 30, connect_timeout: 30,
    });
  }
  return pool;
}

/**
 * The benchmark and risk-free series, fetched once per process.
 *
 * Every fund page measures beta against SPY and Sharpe against the 3-month
 * Treasury, so building 57 of them re-ran the same two queries 57 times and
 * pulled SPY's whole history each round. That was most of the work in the build
 * and it timed pages out. Both series are identical for every page.
 */
let sharedSeries: Promise<{ benchmark: Price[]; riskFree: MacroPoint[] }> | null = null;

function benchmarkAndRiskFree() {
  if (!sharedSeries) {
    const sql = db();
    sharedSeries = Promise.all([
      sql`SELECT ticker,date::text AS date,adj_close::float,close::float,volume FROM prices
          WHERE ticker='SPY' ORDER BY date`,
      sql`SELECT series_id,date::text AS date,value::float FROM macro_series
          WHERE series_id='DGS3MO' ORDER BY date`,
    ]).then(([benchmark, riskFree]) => ({
      benchmark: benchmark as unknown as Price[],
      riskFree: riskFree as unknown as MacroPoint[],
    }));
  }
  return sharedSeries;
}

/**
 * Whether an error means the database could not be reached at all.
 *
 * This decides whether a page may render without data, and getting it wrong is
 * what broke the site. Every loader used to catch everything and return an
 * empty payload, so when Neon refused connections the pages still rendered
 * "successfully" with nothing in them, and Next cached that over the last good
 * version. A transient outage should never be able to replace real content.
 *
 * Throwing instead means the opposite happens: a revalidation that cannot reach
 * the database leaves the previously generated page in place, and a build that
 * cannot reach it fails rather than shipping an empty site. Both are the safe
 * direction. A query that fails for its own reasons is still caught per source,
 * because one broken source should not take down a page that can show the rest.
 */
export function isDatabaseUnreachable(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return [
    "data transfer quota", "exceeded", "connection", "econnrefused", "etimedout",
    "timeout", "terminated", "password authentication", "too many clients",
    "could not connect", "getaddrinfo", "socket",
  ].some((needle) => message.includes(needle));
}

export const EMPTY_SOURCE_REASON = "DATABASE_URL is not configured; no live data was queried.";

function emptyPayload(sector: Sector, reason = EMPTY_SOURCE_REASON): WireIndustryPayload {
  return {
    sector, prices: packRows<Price>(PRICE_COLUMNS, []), etfMeta: [], holdings: [],
    macro: { meta: [], series: packRows<MacroPoint>(MACRO_POINT_COLUMNS, []) },
    companyFacts: [], companyMeta: [], formD: packFormD([]), groups: [], fundComparisons: [], headlines: [], newsVolume: [], events: [],
    freshness: [], errors: [{ source: "Neon Postgres", reason }],
  };
}

type MacroConfigEntry = { series_id: string; definition?: string; blurb?: string };

function macroConfigForSector(slug: string): MacroConfigEntry[] {
  const mapPath = path.resolve(process.cwd(), "config", "fred_map.yaml");
  const config = YAML.parse(fs.readFileSync(mapPath, "utf8")) as {
    common?: MacroConfigEntry[];
    risk_free?: MacroConfigEntry[];
    sectors?: Record<string, MacroConfigEntry[]>;
  };
  return [...(config.common ?? []), ...(config.risk_free ?? []), ...(config.sectors?.[slug] ?? [])];
}

/**
 * EIA and BLS series are matched by pattern rather than listed in fred_map, so
 * they arrived with no definition while every FRED chart had one. These are
 * derived from the series shape: BLS CES codes end 01 for employment and 03 for
 * average hourly earnings.
 */
function agencyCopy(seriesId: string): { definition: string; blurb: string } | null {
  if (seriesId.startsWith("BLS:")) {
    if (seriesId.endsWith("01")) return {
      definition: "The number of people on payrolls in this industry, from the Bureau of Labor Statistics Current Employment Statistics survey.",
      blurb: "A headcount, not a revenue measure. Hiring follows demand rather than leading it, and the first print is revised in each of the next two months.",
    };
    if (seriesId.endsWith("03")) return {
      definition: "Average hourly earnings for production and non-supervisory workers in this industry, from the same BLS survey.",
      blurb: "The labour cost of an hour of work here. In a labour-intensive industry this reaches margins before it reaches prices.",
    };
    return null;
  }
  if (seriesId === "EIA:WCESTUS1") return {
    definition: "Commercial crude oil held in US storage, excluding the Strategic Petroleum Reserve, reported weekly by the EIA.",
    blurb: "Inventory is the running balance between what arrives and what refineries process. A build means supply outran throughput that week.",
  };
  if (seriesId === "EIA:WPULEUS3") return {
    definition: "The share of US refinery capacity actually in use, reported weekly by the EIA.",
    blurb: "Refiners run hard when margins are good and cut runs for maintenance or weak demand, so this is the throughput side of the crude balance.",
  };
  return null;
}

export function macroIdsForSector(slug: string): string[] {
  return macroConfigForSector(slug).map((item) => item.series_id);
}

/**
 * Display rank. The sector's own indicators come first, then its EIA and BLS
 * series, then the market-wide ones.
 *
 * Ranking by position in fred_map put `common` and `risk_free` at the front, so
 * an energy page led with VIX, the dollar index and the 3-month Treasury while
 * crude, gas, gasoline, inventories and refinery utilization sat behind the
 * "show all" disclosure. The generic series are context; the sector's own are
 * the reason the panel exists.
 */
export function macroRelevance(slug: string): (seriesId: string, source: string) => number {
  const mapPath = path.resolve(process.cwd(), "config", "fred_map.yaml");
  const config = YAML.parse(fs.readFileSync(mapPath, "utf8")) as {
    common?: MacroConfigEntry[]; risk_free?: MacroConfigEntry[];
    sectors?: Record<string, MacroConfigEntry[]>;
  };
  const sector = new Map((config.sectors?.[slug] ?? []).map((e, i) => [e.series_id, i]));
  const generic = new Map([...(config.common ?? []), ...(config.risk_free ?? [])].map((e, i) => [e.series_id, i]));
  return (seriesId, source) => {
    const own = sector.get(seriesId);
    if (own !== undefined) return own;                       // this sector's FRED series
    if (/^(EIA|BLS)$/i.test(source)) return 1_000;           // this sector's agency series
    const g = generic.get(seriesId);
    return g === undefined ? 3_000 : 2_000 + g;              // market-wide context last
  };
}

export function macroSourceAllowed(slug: string, source: string): boolean {
  return source.toUpperCase() !== "EIA" || slug === "energy";
}

export function gateMacroByFreshness<
  TMeta extends { series_id: string; source: string },
  TPoint extends { series_id: string },
>(
  meta: TMeta[],
  series: TPoint[],
  freshness: { source: string; status: string }[],
): { meta: TMeta[]; series: TPoint[] } {
  const failed = new Set(freshness.filter((run) => run.status === "failed").map((run) => run.source.toLowerCase()));
  const visibleMeta = meta.filter((item) => !failed.has(item.source.toLowerCase()));
  const visibleIds = new Set(visibleMeta.map((item) => item.series_id));
  return { meta: visibleMeta, series: series.filter((item) => visibleIds.has(item.series_id)) };
}

export const serializable = <T>(value: T): T => JSON.parse(
  JSON.stringify(value).replace(
    /([?&](?:api_key|api-key|registrationkey)=)[^&"\s]+/gi,
    "$1[REDACTED]",
  ),
) as T;

export async function getIndustryPayload(slug: string): Promise<WireIndustryPayload | null> {
  const sector = sectorBySlug(slug);
  if (!sector) return null;
  if (!databaseUrl()) return emptyPayload(sector);

  // Every `date` column is cast to text so the components receive bare
  // YYYY-MM-DD. The driver hands back a JS Date, which serializable() turns into
  // a full ISO timestamp; that broke `row.date <= end` for the final day of any
  // range, because "2026-08-14T00:00:00.000Z" sorts after "2026-08-14".
  // timestamptz columns are left alone: M20 renders those with a clock time.
  const sql = db();
  const tickers = [sector.primary_etf, ...sector.comparison_etfs, "SPY"];
  const macroIds = macroIdsForSector(slug);
  const includeEia = macroSourceAllowed(slug, "EIA");
  const errors: SourceError[] = [];
  const sectorGroups = groupsForSector(slug);
  const groupTickers = [...new Set(sectorGroups.flatMap((group) => group.tickers))];
  const comparisons = fundGroupsForSector(slug);
  const comparisonTickers = [...new Set(comparisons.flatMap((group) => group.tickers))];
  try {
    const [
      prices, etfMeta, holdings, macroMeta, macroSeries, companyFacts, companyMeta,
      formD, headlines, newsVolume, events, freshness, groupWeekly, groupMeta, groupHoldings, comparisonPrices,
    ] = await Promise.all([
      sql`SELECT ticker,date::text AS date,adj_close::float,close::float,volume FROM prices WHERE ticker = ANY(${tickers}) ORDER BY date`,
      sql`SELECT ticker,name,expense_ratio::float,aum::float,issuer,as_of,holdings_status,holdings_error FROM etf_meta WHERE ticker = ANY(${tickers})`,
      sql`WITH valid_snapshots AS (
            SELECT fund_ticker,as_of
            FROM holdings
            WHERE fund_ticker = ANY(${tickers})
            GROUP BY fund_ticker,as_of
            HAVING count(*) >= 5 AND sum(weight) BETWEEN 0.98 AND 1.02
          ), latest_valid AS (
            SELECT DISTINCT ON (fund_ticker) fund_ticker,as_of
            FROM valid_snapshots ORDER BY fund_ticker,as_of DESC
          )
          SELECT h.fund_ticker,h.as_of::text AS as_of,h.constituent_ticker,h.constituent_name,h.weight::float,h.sub_sector
          FROM holdings h JOIN latest_valid latest USING (fund_ticker,as_of)
          ORDER BY h.fund_ticker,h.weight DESC`,
      sql`SELECT series_id,label,units,frequency,source,last_release_date::text AS last_release_date,next_release_date::text AS next_release_date,realtime_start::text AS realtime_start,as_of FROM macro_meta
          WHERE series_id = ANY(${macroIds}) OR (${includeEia} AND series_id LIKE 'EIA:%') OR series_id LIKE ${`BLS:${slug}:%`} ORDER BY source,label`,
      sql`SELECT series_id,date::text AS date,value::float FROM macro_series
          WHERE series_id = ANY(${macroIds}) OR (${includeEia} AND series_id LIKE 'EIA:%') OR series_id LIKE ${`BLS:${slug}:%`} ORDER BY series_id,date`,
      sql`SELECT cf.cik,cf.ticker,cf.fiscal_period,cf.metric,cf.value::float,cf.filed_date::text AS filed_date FROM company_facts cf
          WHERE cf.metric = ANY(${SECTOR_FACT_METRICS}) AND cf.ticker IN (
            SELECT constituent_ticker FROM holdings
            WHERE fund_ticker=${sector.primary_etf} AND as_of=(
              SELECT as_of FROM holdings WHERE fund_ticker=${sector.primary_etf}
              GROUP BY as_of HAVING count(*) >= 5 AND sum(weight) BETWEEN 0.98 AND 1.02
              ORDER BY as_of DESC LIMIT 1
            )
          )`,
      sql`SELECT ticker,market_cap::float,as_of,trailing_pe::float,forward_pe::float,
          price_to_book::float,dividend_yield::float FROM company_meta WHERE ticker IN
          (SELECT constituent_ticker FROM holdings
           WHERE fund_ticker=${sector.primary_etf} AND as_of=(
             SELECT as_of FROM holdings WHERE fund_ticker=${sector.primary_etf}
             GROUP BY as_of HAVING count(*) >= 5 AND sum(weight) BETWEEN 0.98 AND 1.02
             ORDER BY as_of DESC LIMIT 1
           ))`,
      sql`SELECT accession_no,filed_date::text AS filed_date,cik,issuer_name,sic_code,sector_slug,total_offering_amount::float,amount_sold::float,state,submission_type,previous_accession_no,industry_group,file_num,is_amendment,issuer_count,pooled_name_match,is_equity_type,is_debt_type,is_option_to_acquire_type,issuer_ticker FROM form_d WHERE sector_slug=${slug} ORDER BY filed_date`,
      sql`SELECT id,sector_slug,published_date,source,headline,abstract,section,url FROM headlines WHERE sector_slug=${slug} ORDER BY published_date`,
      sql`SELECT sector_slug,date::text AS date,article_volume::float,avg_tone::float FROM news_volume WHERE sector_slug=${slug} ORDER BY date`,
      sql`SELECT id,start_date::text AS start_date,end_date::text AS end_date,sectors,title,blurb,source_url,impact FROM events WHERE sectors && ARRAY[${slug},'all']::text[] ORDER BY start_date`,
      sql`SELECT DISTINCT ON (source) source,started_at,finished_at,status,rows_written,error_message,details
          FROM ingest_runs WHERE source NOT LIKE 'holdings:%' ORDER BY source,started_at DESC`,
      groupTickers.length
        ? sql`SELECT ticker,week_ending::text AS week_ending,adj_close::float FROM company_prices
              WHERE ticker = ANY(${groupTickers}) ORDER BY ticker,week_ending`
        : Promise.resolve([]),
      groupTickers.length
        ? sql`SELECT ticker,name,market_cap::float FROM company_meta WHERE ticker = ANY(${groupTickers})`
        : Promise.resolve([]),
      // How much of each tracked fund these companies actually are. Only the
      // newest snapshot that passed validation counts, so a fund never reports
      // an exposure built from a half-parsed holdings file.
      groupTickers.length
        ? sql`SELECT h.fund_ticker, h.constituent_ticker, h.weight::float, h.as_of::text AS as_of
              FROM holdings h
              WHERE h.constituent_ticker = ANY(${groupTickers}) AND h.as_of = (
                SELECT as_of FROM holdings WHERE fund_ticker = h.fund_ticker
                GROUP BY as_of HAVING count(*) >= 5 AND sum(weight) BETWEEN 0.98 AND 1.02
                ORDER BY as_of DESC LIMIT 1)`
        : Promise.resolve([]),
      comparisonTickers.length
        ? sql`SELECT ticker,date::text AS date,adj_close::float FROM prices
              WHERE ticker = ANY(${comparisonTickers}) ORDER BY ticker,date`
        : Promise.resolve([]),
    ]);
    for (const run of freshness) {
      if (run.status === "failed") errors.push({ source: run.source, reason: run.error_message ?? "Last ingest failed" });
    }
    // Present macro series in registry order rather than alphabetically, so the
    // first few shown are the ones chosen as most relevant to the sector. BLS
    // and EIA series are matched by pattern, not listed in fred_map, so they
    // sort after the configured ones.
    const rank = macroRelevance(slug);
    // Definitions and blurbs live in fred_map.yaml beside the series they
    // describe; the database stores only what FRED publishes.
    const copy = new Map(macroConfigForSector(slug).map((item) => [item.series_id, item]));
    const described = (macroMeta as unknown as WireIndustryPayload["macro"]["meta"]).map((row) => {
      const agency = agencyCopy(row.series_id);
      return {
        ...row,
        definition: copy.get(row.series_id)?.definition ?? agency?.definition ?? null,
        blurb: copy.get(row.series_id)?.blurb ?? agency?.blurb ?? null,
      };
    });
    const ordered = [...described].sort((a, b) =>
      rank(a.series_id, String(a.source)) - rank(b.series_id, String(b.source))
      || String(a.source).localeCompare(String(b.source))
      || String(a.label).localeCompare(String(b.label)));
    const macro = gateMacroByFreshness(
      ordered as unknown as IndustryPayload["macro"]["meta"],
      macroSeries as unknown as IndustryPayload["macro"]["series"],
      freshness as unknown as IndustryPayload["freshness"],
    );
    return serializable({
      sector,
      // prices and macro observations are the two largest arrays on a page and
      // spend most of their bytes restating key names; see wire.ts.
      prices: packRows(PRICE_COLUMNS, prices as unknown as IndustryPayload["prices"]),
      etfMeta, holdings,
      macro: { ...macro, series: packRows(MACRO_POINT_COLUMNS, macro.series) },
      companyFacts, companyMeta,
      formD: packFormD(formD as unknown as IndustryPayload["formD"]),
      groups: assembleGroups(sectorGroups, groupWeekly as never, groupMeta as never, groupHoldings as never),
      fundComparisons: assembleComparisons(comparisons, comparisonPrices as never),
      headlines, newsVolume, events, freshness, errors,
    } as unknown as WireIndustryPayload);
  } catch (error) {
    if (isDatabaseUnreachable(error)) throw error;
    return emptyPayload(sector, error instanceof Error ? error.message : String(error));
  }
}

export type HomePricePoint = { date: string; value: number; close: number | null };
export type HomePerformance = Record<string, { prices: HomePricePoint[]; error?: string }>;
export type HomeCompany = { ticker: string; name: string | null; market_cap: number | null };
export type HomeData = {
  performance: HomePerformance;
  /** Latest observation in the price table. */
  pricesThrough: string | null;
  /** When the price ingest last finished, which is a different question. */
  lastChecked: string | null;
  companies: HomeCompany[];
};

export async function getHomePerformance(): Promise<HomeData> {
  const result: HomePerformance = {};
  let pricesThrough: string | null = null;
  let lastChecked: string | null = null;
  let companies: HomeCompany[] = [];
  if (!databaseUrl()) return { performance: result, pricesThrough, lastChecked, companies };
  const sql = db();
  try {
    // YTD is measured from the prior year-end close, so the first trading day's
    // move is inside the window rather than discarded as the baseline.
    //
    // adj_close drives every return; close is the traded price a reader can
    // check against a broker. Mixing them produces a price that disagrees with
    // every other quote source.
    // date::text, not a bare date. The driver returns a JS Date for date
    // columns, and String() on that yields "Sat Aug 15 2026 …" rather than an
    // ISO day, which breaks both date parsing and the string comparisons the
    // components do. getIndustryPayload avoids this only because serializable()
    // JSON-round-trips its rows.
    const rows = await sql`SELECT ticker,date::text AS date,adj_close::float AS value,close::float AS close FROM prices
      WHERE date >= (SELECT max(date) FROM prices WHERE date < date_trunc('year',current_date))
      ORDER BY ticker,date`;
    for (const row of rows) {
      (result[row.ticker] ??= { prices: [] }).prices.push({
        date: String(row.date),
        value: Number(row.value),
        close: row.close === null ? null : Number(row.close),
      });
    }
    const [latest] = await sql`SELECT max(date)::text AS through FROM prices`;
    pricesThrough = latest?.through ?? null;
    const [run] = await sql`SELECT finished_at,started_at FROM ingest_runs
      WHERE source='prices' AND status='success' ORDER BY started_at DESC LIMIT 1`;
    lastChecked = (run?.finished_at ?? run?.started_at ?? null) as string | null;
    // The largest companies held by the tracked funds, purely so the home page
    // can show that company pages exist. Ranking by market cap needs no
    // judgement about which companies matter.
    companies = (await sql`SELECT ticker,name,market_cap::float FROM company_meta
      WHERE market_cap IS NOT NULL
        AND ticker IN (SELECT DISTINCT constituent_ticker FROM holdings)
      ORDER BY market_cap DESC LIMIT 12`) as unknown as HomeCompany[];
  } catch (error) {
    // Serving an empty home page is worse than serving yesterday's: Next keeps
    // the last good render when this throws.
    if (isDatabaseUnreachable(error)) throw error;
    result.__error = { prices: [], error: error instanceof Error ? error.message : String(error) };
  }
  return { performance: result, pricesThrough, lastChecked, companies };
}

const COMPANY_META_COLUMNS = `ticker,market_cap::float,as_of,name,trailing_pe::float,
  forward_pe::float,price_to_book::float,dividend_yield::float,
  target_mean_price::float,analyst_count,recommendation`;

/**
 * One fund, for its own page.
 *
 * The sector page carries every fund it compares; this carries one fund in
 * enough depth to judge it on its own: its own daily history, the benchmark and
 * risk-free series its risk figures are measured against, and what it holds.
 */
export async function getEtfPayload(ticker: string): Promise<EtfPayload | null> {
  const fund = fundByTicker(ticker);
  if (!fund) return null;
  const symbol = fund.ticker;
  const base = {
    ticker: symbol, sectorSlug: fund.sector.slug, sectorName: fund.sector.name,
    isPrimary: fund.primary,
    peers: [fund.sector.primary_etf, ...fund.sector.comparison_etfs].filter((peer) => peer !== symbol),
  };
  if (!databaseUrl()) {
    return { ...base, meta: null, prices: [], benchmark: [], riskFree: [], holdings: [],
      errors: [{ source: "Neon Postgres", reason: EMPTY_SOURCE_REASON }] };
  }
  const sql = db();
  try {
    const [meta, prices, shared, holdings] = await Promise.all([
      sql`SELECT ticker,name,expense_ratio::float,aum::float,issuer,as_of,holdings_status,holdings_error
          FROM etf_meta WHERE ticker=${symbol}`,
      sql`SELECT ticker,date::text AS date,adj_close::float,close::float,volume FROM prices
          WHERE ticker=${symbol} ORDER BY date`,
      benchmarkAndRiskFree(),
      // Only the newest snapshot that passed validation, matching the rule the
      // sector page uses, so a fund never shows a half-parsed composition.
      sql`SELECT fund_ticker,as_of,constituent_ticker,constituent_name,weight::float,sub_sector
          FROM holdings WHERE fund_ticker=${symbol} AND as_of=(
            SELECT as_of FROM holdings WHERE fund_ticker=${symbol}
            GROUP BY as_of HAVING count(*) >= 5 AND sum(weight) BETWEEN 0.98 AND 1.02
            ORDER BY as_of DESC LIMIT 1)
          ORDER BY weight DESC`,
    ]);
    return serializable({
      ...base, meta: (meta[0] ?? null), prices,
      benchmark: shared.benchmark, riskFree: shared.riskFree, holdings, errors: [],
    } as unknown as EtfPayload);
  } catch (error) {
    if (isDatabaseUnreachable(error)) throw error;
    return { ...base, meta: null, prices: [], benchmark: [], riskFree: [], holdings: [],
      errors: [{ source: "Neon Postgres", reason: error instanceof Error ? error.message : String(error) }] };
  }
}

/**
 * One company, for its own page.
 *
 * Prices here are weekly, not daily: storing daily bars for every company the
 * funds hold does not fit the database, and every question this page answers is
 * measured in years. The page says so rather than implying a daily series.
 */
export async function getCompanyPayload(ticker: string): Promise<CompanyPayload | null> {
  const symbol = ticker.toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return null;
  const base = { ticker: symbol, sectorSlug: null, sectorName: null };
  if (!databaseUrl()) {
    return { ...base, meta: null, facts: [], weekly: [], heldBy: [],
      errors: [{ source: "Neon Postgres", reason: EMPTY_SOURCE_REASON }] };
  }
  const sql = db();
  try {
    const [meta, facts, weekly, heldBy] = await Promise.all([
      sql`SELECT ${sql.unsafe(COMPANY_META_COLUMNS)} FROM company_meta WHERE ticker=${symbol}`,
      sql`SELECT cik,ticker,fiscal_period,metric,value::float,filed_date::text AS filed_date
          FROM company_facts WHERE ticker=${symbol} ORDER BY fiscal_period`,
      sql`SELECT ticker,week_ending::text AS week_ending,adj_close::float FROM company_prices
          WHERE ticker=${symbol} ORDER BY week_ending`,
      sql`SELECT h.fund_ticker,h.weight::float,h.as_of::text AS as_of FROM holdings h
          WHERE h.constituent_ticker=${symbol} AND h.as_of=(
            SELECT max(as_of) FROM holdings WHERE fund_ticker=h.fund_ticker)
          ORDER BY h.weight DESC`,
    ]);
    // A company belongs to whichever sector's fund holds the most of it, which
    // is the only attribution the holdings data supports.
    const owner = (heldBy as unknown as FundHolder[])
      .map((row) => fundByTicker(row.fund_ticker))
      .find((fund) => fund !== undefined);
    if (!(facts.length || weekly.length || meta.length)) return null;
    return serializable({
      ...base, meta: (meta[0] ?? null), facts, weekly, heldBy,
      sectorSlug: owner?.sector.slug ?? null, sectorName: owner?.sector.name ?? null,
      errors: [],
    } as unknown as CompanyPayload);
  } catch (error) {
    if (isDatabaseUnreachable(error)) throw error;
    return { ...base, meta: null, facts: [], weekly: [], heldBy: [],
      errors: [{ source: "Neon Postgres", reason: error instanceof Error ? error.message : String(error) }] };
  }
}


/**
 * Attach prices and names to a curated group, dropping members with no data.
 *
 * A ticker named in the group file only appears if the site actually holds
 * prices for it, so curating a list can never invent coverage that is not there.
 */
function assembleGroups(
  groups: CompanyGroup[],
  weekly: { ticker: string; week_ending: string; adj_close: number }[],
  meta: { ticker: string; name: string | null; market_cap: number | null }[],
  holdings: { fund_ticker: string; constituent_ticker: string; weight: number; as_of: string }[],
): SectorGroup[] {
  if (!groups.length) return [];
  const byTicker = new Map<string, { date: string; value: number }[]>();
  for (const row of weekly) {
    const points = byTicker.get(row.ticker) ?? [];
    points.push({ date: row.week_ending, value: row.adj_close });
    byTicker.set(row.ticker, points);
  }
  const metaByTicker = new Map(meta.map((row) => [row.ticker, row]));
  return groups
    .map((group) => ({
      slug: group.slug, name: group.name, blurb: group.blurb,
      funds: fundExposure(group.tickers, holdings),
      members: group.tickers
        .map((ticker): GroupMember | null => {
          const points = byTicker.get(ticker);
          if (!points || points.length < 2) return null;
          const info = metaByTicker.get(ticker);
          return { ticker, name: info?.name ?? null, market_cap: info?.market_cap ?? null, weekly: points };
        })
        .filter((member): member is GroupMember => member !== null),
    }))
    .filter((group) => group.members.length > 0);
}


/**
 * How much of each fund a group of companies makes up.
 *
 * Asking which funds give exposure to a group is a different question from
 * which companies are in it, and it is the one a reader wanting to own the
 * group actually has. Only funds whose composition parsed are here, so a fund
 * with no published holdings is absent rather than shown at zero.
 */
function fundExposure(
  tickers: string[],
  holdings: { fund_ticker: string; constituent_ticker: string; weight: number; as_of: string }[],
): GroupFundExposure[] {
  const wanted = new Set(tickers);
  const byFund = new Map<string, { weight: number; members: number; as_of: string }>();
  for (const row of holdings) {
    if (!wanted.has(row.constituent_ticker)) continue;
    const current = byFund.get(row.fund_ticker) ?? { weight: 0, members: 0, as_of: row.as_of };
    current.weight += row.weight;
    current.members += 1;
    byFund.set(row.fund_ticker, current);
  }
  return [...byFund.entries()]
    .map(([fund_ticker, value]) => ({ fund_ticker, ...value }))
    .sort((a, b) => b.weight - a.weight);
}


/** Funds charted together, keeping only those with a price history held. */
function assembleComparisons(
  groups: FundGroup[],
  prices: { ticker: string; date: string; adj_close: number }[],
): FundComparison[] {
  if (!groups.length) return [];
  const byTicker = new Map<string, { date: string; value: number }[]>();
  for (const row of prices) {
    const points = byTicker.get(row.ticker) ?? [];
    points.push({ date: row.date, value: row.adj_close });
    byTicker.set(row.ticker, points);
  }
  return groups
    .map((group) => ({
      slug: group.slug, name: group.name, blurb: group.blurb,
      series: group.tickers
        .map((ticker) => ({ ticker, points: byTicker.get(ticker) ?? [] }))
        .filter((entry) => entry.points.length > 1),
    }))
    .filter((group) => group.series.length > 1);
}
