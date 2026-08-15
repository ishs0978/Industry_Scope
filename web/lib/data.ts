import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import YAML from "yaml";
import { sectorBySlug } from "./registry";
import type { IndustryPayload, Sector, SourceError } from "./types";

export const EMPTY_SOURCE_REASON = "DATABASE_URL is not configured; no live data was queried.";

function emptyPayload(sector: Sector, reason = EMPTY_SOURCE_REASON): IndustryPayload {
  return {
    sector, prices: [], etfMeta: [], holdings: [], macro: { meta: [], series: [] },
    companyFacts: [], companyMeta: [], formD: [], headlines: [], newsVolume: [], events: [],
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

export async function getIndustryPayload(slug: string): Promise<IndustryPayload | null> {
  const sector = sectorBySlug(slug);
  if (!sector) return null;
  if (!process.env.DATABASE_URL) return emptyPayload(sector);

  // Every `date` column is cast to text so the components receive bare
  // YYYY-MM-DD. The driver hands back a JS Date, which serializable() turns into
  // a full ISO timestamp; that broke `row.date <= end` for the final day of any
  // range, because "2026-08-14T00:00:00.000Z" sorts after "2026-08-14".
  // timestamptz columns are left alone: M20 renders those with a clock time.
  const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 4, idle_timeout: 20 });
  const tickers = [sector.primary_etf, ...sector.comparison_etfs, "SPY"];
  const macroIds = macroIdsForSector(slug);
  const includeEia = macroSourceAllowed(slug, "EIA");
  const errors: SourceError[] = [];
  try {
    const [
      prices, etfMeta, holdings, macroMeta, macroSeries, companyFacts, companyMeta,
      formD, headlines, newsVolume, events, freshness,
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
          WHERE cf.ticker IN (
            SELECT constituent_ticker FROM holdings
            WHERE fund_ticker=${sector.primary_etf} AND as_of=(
              SELECT as_of FROM holdings WHERE fund_ticker=${sector.primary_etf}
              GROUP BY as_of HAVING count(*) >= 5 AND sum(weight) BETWEEN 0.98 AND 1.02
              ORDER BY as_of DESC LIMIT 1
            )
          )`,
      sql`SELECT ticker,market_cap::float,as_of FROM company_meta WHERE ticker IN
          (SELECT constituent_ticker FROM holdings
           WHERE fund_ticker=${sector.primary_etf} AND as_of=(
             SELECT as_of FROM holdings WHERE fund_ticker=${sector.primary_etf}
             GROUP BY as_of HAVING count(*) >= 5 AND sum(weight) BETWEEN 0.98 AND 1.02
             ORDER BY as_of DESC LIMIT 1
           ))`,
      sql`SELECT accession_no,filed_date::text AS filed_date,cik,issuer_name,sic_code,sector_slug,total_offering_amount::float,amount_sold::float,state,submission_type,previous_accession_no,industry_group FROM form_d WHERE sector_slug=${slug} ORDER BY filed_date`,
      sql`SELECT id,sector_slug,published_date,source,headline,abstract,section,url FROM headlines WHERE sector_slug=${slug} ORDER BY published_date`,
      sql`SELECT sector_slug,date::text AS date,article_volume::float,avg_tone::float FROM news_volume WHERE sector_slug=${slug} ORDER BY date`,
      sql`SELECT id,start_date::text AS start_date,end_date::text AS end_date,sectors,title,blurb,source_url,impact FROM events WHERE sectors && ARRAY[${slug},'all']::text[] ORDER BY start_date`,
      sql`SELECT DISTINCT ON (source) source,started_at,finished_at,status,rows_written,error_message,details
          FROM ingest_runs WHERE source NOT LIKE 'holdings:%' ORDER BY source,started_at DESC`,
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
    const described = (macroMeta as unknown as IndustryPayload["macro"]["meta"]).map((row) => ({
      ...row,
      definition: copy.get(row.series_id)?.definition ?? null,
      blurb: copy.get(row.series_id)?.blurb ?? null,
    }));
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
      sector, prices, etfMeta, holdings, macro,
      companyFacts, companyMeta, formD, headlines, newsVolume, events, freshness, errors,
    } as unknown as IndustryPayload);
  } catch (error) {
    return emptyPayload(sector, error instanceof Error ? error.message : String(error));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export type HomePricePoint = { date: string; value: number; close: number | null };
export type HomePerformance = Record<string, { prices: HomePricePoint[]; error?: string }>;
export type HomeData = {
  performance: HomePerformance;
  /** Latest observation in the price table. */
  pricesThrough: string | null;
  /** When the price ingest last finished, which is a different question. */
  lastChecked: string | null;
};

export async function getHomePerformance(): Promise<HomeData> {
  const result: HomePerformance = {};
  let pricesThrough: string | null = null;
  let lastChecked: string | null = null;
  if (!process.env.DATABASE_URL) return { performance: result, pricesThrough, lastChecked };
  const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
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
  } catch (error) {
    result.__error = { prices: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    await sql.end({ timeout: 5 });
  }
  return { performance: result, pricesThrough, lastChecked };
}
