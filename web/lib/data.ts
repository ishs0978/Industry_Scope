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

export function macroIdsForSector(slug: string): string[] {
  const mapPath = path.resolve(process.cwd(), "config", "fred_map.yaml");
  const config = YAML.parse(fs.readFileSync(mapPath, "utf8")) as {
    common?: { series_id: string }[];
    risk_free?: { series_id: string }[];
    sectors?: Record<string, { series_id: string }[]>;
  };
  return [
    ...(config.common ?? []), ...(config.risk_free ?? []), ...(config.sectors?.[slug] ?? []),
  ].map((item) => item.series_id);
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
      sql`SELECT ticker,date,adj_close::float,close::float,volume FROM prices WHERE ticker = ANY(${tickers}) ORDER BY date`,
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
          SELECT h.fund_ticker,h.as_of,h.constituent_ticker,h.constituent_name,h.weight::float,h.sub_sector
          FROM holdings h JOIN latest_valid latest USING (fund_ticker,as_of)
          ORDER BY h.fund_ticker,h.weight DESC`,
      sql`SELECT series_id,label,units,frequency,source,last_release_date,next_release_date,realtime_start,as_of FROM macro_meta
          WHERE series_id = ANY(${macroIds}) OR (${includeEia} AND series_id LIKE 'EIA:%') OR series_id LIKE ${`BLS:${slug}:%`} ORDER BY source,label`,
      sql`SELECT series_id,date,value::float FROM macro_series
          WHERE series_id = ANY(${macroIds}) OR (${includeEia} AND series_id LIKE 'EIA:%') OR series_id LIKE ${`BLS:${slug}:%`} ORDER BY series_id,date`,
      sql`SELECT cf.cik,cf.ticker,cf.fiscal_period,cf.metric,cf.value::float,cf.filed_date FROM company_facts cf
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
      sql`SELECT accession_no,filed_date,cik,issuer_name,sic_code,sector_slug,total_offering_amount::float,amount_sold::float,state,submission_type,previous_accession_no FROM form_d WHERE sector_slug=${slug} ORDER BY filed_date`,
      sql`SELECT id,sector_slug,published_date,source,headline,abstract,section,url FROM headlines WHERE sector_slug=${slug} ORDER BY published_date`,
      sql`SELECT sector_slug,date,article_volume::float,avg_tone::float FROM news_volume WHERE sector_slug=${slug} ORDER BY date`,
      sql`SELECT id,start_date,end_date,sectors,title,blurb,source_url,impact FROM events WHERE sectors && ARRAY[${slug},'all']::text[] ORDER BY start_date`,
      sql`SELECT DISTINCT ON (source) source,started_at,finished_at,status,rows_written,error_message,details
          FROM ingest_runs WHERE source NOT LIKE 'holdings:%' ORDER BY source,started_at DESC`,
    ]);
    for (const run of freshness) {
      if (run.status === "failed") errors.push({ source: run.source, reason: run.error_message ?? "Last ingest failed" });
    }
    const macro = gateMacroByFreshness(
      macroMeta as unknown as IndustryPayload["macro"]["meta"],
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

export async function getHomePerformance(): Promise<Record<string, { prices: { date: string; value: number }[]; error?: string }>> {
  const result: Record<string, { prices: { date: string; value: number }[]; error?: string }> = {};
  if (!process.env.DATABASE_URL) return result;
  const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
  try {
    // YTD is measured from the prior year-end close, so the first trading day's
    // move is inside the window rather than discarded as the baseline.
    const rows = await sql`SELECT ticker,date,adj_close::float AS value FROM prices
      WHERE date >= (SELECT max(date) FROM prices WHERE date < date_trunc('year',current_date))
      ORDER BY ticker,date`;
    for (const row of rows) {
      (result[row.ticker] ??= { prices: [] }).prices.push({ date: String(row.date), value: Number(row.value) });
    }
  } catch (error) {
    result.__error = { prices: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    await sql.end({ timeout: 5 });
  }
  return result;
}
