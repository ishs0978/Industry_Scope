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

function macroIdsForSector(slug: string): string[] {
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

const serializable = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function getIndustryPayload(slug: string): Promise<IndustryPayload | null> {
  const sector = sectorBySlug(slug);
  if (!sector) return null;
  if (!process.env.DATABASE_URL) return emptyPayload(sector);

  const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 4, idle_timeout: 20 });
  const tickers = [sector.primary_etf, ...sector.comparison_etfs, "SPY"];
  const macroIds = macroIdsForSector(slug);
  const errors: SourceError[] = [];
  try {
    const [
      prices, etfMeta, holdings, macroMeta, macroSeries, companyFacts, companyMeta,
      formD, headlines, newsVolume, events, freshness,
    ] = await Promise.all([
      sql`SELECT ticker,date,adj_close::float,close::float,volume FROM prices WHERE ticker = ANY(${tickers}) ORDER BY date`,
      sql`SELECT ticker,name,expense_ratio::float,aum::float,issuer,as_of,holdings_status,holdings_error FROM etf_meta WHERE ticker = ANY(${tickers})`,
      sql`SELECT fund_ticker,as_of,constituent_ticker,constituent_name,weight::float,sub_sector
          FROM holdings WHERE fund_ticker = ANY(${tickers}) ORDER BY fund_ticker,as_of,weight DESC`,
      sql`SELECT series_id,label,units,frequency,source,last_release_date,next_release_date,realtime_start,as_of FROM macro_meta
          WHERE series_id = ANY(${macroIds}) OR series_id LIKE 'EIA:%' OR series_id LIKE ${`BLS:${slug}:%`} ORDER BY source,label`,
      sql`SELECT series_id,date,value::float FROM macro_series
          WHERE series_id = ANY(${macroIds}) OR series_id LIKE 'EIA:%' OR series_id LIKE ${`BLS:${slug}:%`} ORDER BY series_id,date`,
      sql`SELECT cf.cik,cf.ticker,cf.fiscal_period,cf.metric,cf.value::float,cf.filed_date FROM company_facts cf
          WHERE cf.ticker IN (SELECT constituent_ticker FROM holdings WHERE fund_ticker=${sector.primary_etf} AND as_of=(SELECT max(as_of) FROM holdings WHERE fund_ticker=${sector.primary_etf}))`,
      sql`SELECT ticker,market_cap::float,as_of FROM company_meta WHERE ticker IN
          (SELECT constituent_ticker FROM holdings WHERE fund_ticker=${sector.primary_etf} AND as_of=(SELECT max(as_of) FROM holdings WHERE fund_ticker=${sector.primary_etf}))`,
      sql`SELECT accession_no,filed_date,cik,issuer_name,sic_code,sector_slug,total_offering_amount::float,amount_sold::float,state FROM form_d WHERE sector_slug=${slug} ORDER BY filed_date`,
      sql`SELECT id,sector_slug,published_date,source,headline,abstract,section,url FROM headlines WHERE sector_slug=${slug} ORDER BY published_date`,
      sql`SELECT sector_slug,date,article_volume::float,avg_tone::float FROM news_volume WHERE sector_slug=${slug} ORDER BY date`,
      sql`SELECT id,start_date,end_date,sectors,title,blurb,source_url,impact FROM events WHERE sectors && ARRAY[${slug},'all']::text[] ORDER BY start_date`,
      sql`SELECT DISTINCT ON (source) source,started_at,finished_at,status,rows_written,error_message,details FROM ingest_runs ORDER BY source,started_at DESC`,
    ]);
    for (const run of freshness) {
      if (run.status === "failed") errors.push({ source: run.source, reason: run.error_message ?? "Last ingest failed" });
    }
    return serializable({
      sector, prices, etfMeta, holdings, macro: { meta: macroMeta, series: macroSeries },
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
    const rows = await sql`SELECT ticker,date,adj_close::float AS value FROM prices WHERE date >= date_trunc('year',current_date) ORDER BY ticker,date`;
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
