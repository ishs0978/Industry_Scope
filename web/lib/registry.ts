import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Sector } from "./types";

let cached: Sector[] | null = null;

export function sectors(): Sector[] {
  if (cached) return cached;
  const registryPath = path.resolve(process.cwd(), "config", "sectors.yaml");
  const document = YAML.parse(fs.readFileSync(registryPath, "utf8")) as { sectors: Sector[] };
  cached = document.sectors;
  return cached;
}

export function sectorBySlug(slug: string): Sector | undefined {
  return sectors().find((sector) => sector.slug === slug);
}

/** Every fund the site tracks, with the sector each one belongs to. */
export function fundsWithSector(): { ticker: string; sector: Sector; primary: boolean }[] {
  const seen = new Map<string, { ticker: string; sector: Sector; primary: boolean }>();
  for (const sector of sectors()) {
    for (const [index, ticker] of [sector.primary_etf, ...sector.comparison_etfs].entries()) {
      // A fund can appear under one sector only; the first claim wins, and the
      // sector that names it primary always claims it because those come first.
      if (!seen.has(ticker)) seen.set(ticker, { ticker, sector, primary: index === 0 });
    }
  }
  return [...seen.values()];
}

export function fundByTicker(ticker: string) {
  return fundsWithSector().find((fund) => fund.ticker === ticker.toUpperCase());
}

export type CompanyGroup = {
  slug: string; name: string; sector: string; blurb: string; tickers: string[];
};

let cachedGroups: CompanyGroup[] | null = null;

/**
 * Named groups of companies that cut across the sector registry.
 *
 * The registry answers which fund tracks an industry. These answer which
 * companies people actually talk about, which the holdings data cannot: the
 * issuer files carry a sub-sector column whose every value is literally "-".
 * They are curated, so they are opinions about membership rather than facts
 * from a filing, and the page says so.
 */
export function companyGroups(): CompanyGroup[] {
  if (cachedGroups) return cachedGroups;
  const groupsPath = path.resolve(process.cwd(), "config", "company_groups.yaml");
  const document = YAML.parse(fs.readFileSync(groupsPath, "utf8")) as { groups: CompanyGroup[] };
  cachedGroups = document.groups ?? [];
  return cachedGroups;
}

export function groupsForSector(slug: string): CompanyGroup[] {
  return companyGroups().filter((group) => group.sector === slug);
}
