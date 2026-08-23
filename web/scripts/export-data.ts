/**
 * Write every page's data to disk so the site can be built without a database.
 *
 * The site used to query Postgres while rendering, once per page. With 84 pages
 * that meant the same rows leaving the database over and over: SPY's whole price
 * history was fetched 57 times in a single build, once per fund page. A month of
 * that exceeded the database's data transfer allowance and every page went
 * blank, because a rebuild with no database still counts as a successful render.
 *
 * This runs once, in the workflow that already holds the credentials, reads each
 * table a handful of times instead of hundreds, and writes the finished payloads
 * next to the source. Vercel then builds from those files and never opens a
 * connection at all.
 *
 * It deliberately calls the same loaders the pages call, rather than
 * reimplementing their queries, so the exported payload cannot drift from what
 * a database-backed render would have produced.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { databaseUrl, getCompanyPayload, getEtfPayload, getHomePerformance, getIndustryPayload } from "../lib/data";
import { fundsWithSector, sectors } from "../lib/registry";

const OUT = path.resolve(process.cwd(), "data");

async function write(relative: string, value: unknown): Promise<number> {
  const target = path.join(OUT, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const body = JSON.stringify(value);
  await writeFile(target, body);
  return Buffer.byteLength(body);
}

/** Every company held by a fund, which is exactly the set with its own page. */
async function constituents(): Promise<string[]> {
  const sql = postgres(databaseUrl()!, { ssl: "require", max: 2 });
  try {
    const rows = await sql`SELECT DISTINCT constituent_ticker AS ticker FROM holdings
      WHERE constituent_ticker IS NOT NULL AND constituent_ticker <> '' ORDER BY 1`;
    return rows.map((row) => String(row.ticker));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  if (!databaseUrl()) {
    console.error("DATABASE_URL is required to export site data.");
    process.exit(1);
  }
  const started = Date.now();
  let bytes = 0;
  const counts = { sectors: 0, funds: 0, companies: 0 };

  bytes += await write("home.json", await getHomePerformance());

  for (const sector of sectors()) {
    const payload = await getIndustryPayload(sector.slug);
    if (!payload) continue;
    bytes += await write(`sectors/${sector.slug}.json`, payload);
    counts.sectors += 1;
  }

  for (const fund of fundsWithSector()) {
    const payload = await getEtfPayload(fund.ticker);
    if (!payload) continue;
    bytes += await write(`etf/${fund.ticker}.json`, payload);
    counts.funds += 1;
  }

  // A company with no data returns null and simply gets no file; the page then
  // renders its own "not found" rather than an empty shell.
  for (const ticker of await constituents()) {
    const payload = await getCompanyPayload(ticker);
    if (!payload) continue;
    bytes += await write(`companies/${ticker}.json`, payload);
    counts.companies += 1;
  }

  bytes += await write("meta.json", { generated_at: new Date().toISOString(), ...counts });
  console.log(
    `exported ${counts.sectors} sectors, ${counts.funds} funds, ${counts.companies} companies `
    + `(${(bytes / 1e6).toFixed(1)} MB) in ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
}

main().catch((error) => {
  // Failing loudly is the point: shipping a build with no data is what broke
  // the site, so an export that cannot read the database must stop the deploy.
  console.error("Export failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
