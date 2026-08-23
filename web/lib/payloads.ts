import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  getCompanyPayload, getEtfPayload, getHomePerformance, getIndustryPayload,
  type HomeData,
} from "./data";
import type { CompanyPayload, EtfPayload, WireIndustryPayload } from "./types";

/**
 * Where a page gets its data.
 *
 * Pages ask here rather than querying Postgres directly. If the export written
 * by the deploy workflow is present, that is used and no connection is opened;
 * otherwise the database loader runs, which is what makes `next dev` work
 * against a live database with no export step.
 *
 * The split exists because rendering from the database did not scale. Each of
 * the 84 pages ran its own queries, so a single build pulled the same rows
 * dozens of times over and a month of rebuilds exhausted the data transfer
 * allowance. When that happened every page rendered empty and the empty version
 * was cached over the real one.
 */
const DATA_DIR = path.resolve(process.cwd(), "data");

async function fromFile<T>(relative: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, relative), "utf8")) as T;
  } catch (error) {
    // A missing file means "not exported", which is a normal answer here: fall
    // through to the database. Anything else is a real problem worth raising.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function industryPayload(slug: string): Promise<WireIndustryPayload | null> {
  return (await fromFile<WireIndustryPayload>(`sectors/${slug}.json`)) ?? getIndustryPayload(slug);
}

export async function etfPayload(ticker: string): Promise<EtfPayload | null> {
  const symbol = ticker.toUpperCase();
  const exported = await fromFile<Omit<EtfPayload, "benchmark" | "riskFree">>(`etf/${symbol}.json`);
  if (!exported) return getEtfPayload(symbol);
  // The benchmark and risk-free series are identical for every fund and are
  // stored once rather than in all 56 payloads.
  const shared = await sharedSeries();
  return { ...exported, benchmark: shared.benchmark, riskFree: shared.riskFree } as EtfPayload;
}

let sharedCache: Promise<{ benchmark: EtfPayload["benchmark"]; riskFree: EtfPayload["riskFree"] }> | null = null;

function sharedSeries() {
  if (!sharedCache) {
    sharedCache = fromFile<{ benchmark: EtfPayload["benchmark"]; riskFree: EtfPayload["riskFree"] }>("shared.json")
      .then((value) => value ?? { benchmark: [], riskFree: [] });
  }
  return sharedCache;
}

export async function companyPayload(ticker: string): Promise<CompanyPayload | null> {
  const symbol = ticker.toUpperCase();
  const exported = await fromFile<CompanyPayload>(`companies/${symbol}.json`);
  if (exported) return exported;
  // An export exists but this company is not in it, which means it is not held
  // by any tracked fund. Asking the database would only confirm that slowly.
  if (await exportExists()) return null;
  return getCompanyPayload(symbol);
}

export async function homeData(): Promise<HomeData> {
  return (await fromFile<HomeData>("home.json")) ?? getHomePerformance();
}

let exportPresent: boolean | null = null;

/** Whether this build has an export at all, cached for the process. */
export async function exportExists(): Promise<boolean> {
  if (exportPresent === null) exportPresent = (await fromFile<unknown>("meta.json")) !== null;
  return exportPresent;
}

export async function exportedAt(): Promise<string | null> {
  const meta = await fromFile<{ generated_at?: string }>("meta.json");
  return meta?.generated_at ?? null;
}
