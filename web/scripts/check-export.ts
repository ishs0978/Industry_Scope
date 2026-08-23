/**
 * Refuse to ship an export that contradicts what the pages claim about it.
 *
 * Every check here corresponds to something that reached the deployed site and
 * looked like data: a fund whose largest holding had no fundamentals while the
 * page printed sector percentiles, a margin of several thousand percent, three
 * identical quartiles computed from one company, a period label from 2019 sat
 * under a heading about the latest quarter. None of it errored. The pipeline
 * was working; the output was wrong, and nothing was positioned to notice.
 *
 * Errors fail the build, because they mean a bug upstream. Warnings print and
 * pass, because they describe real states of public data that the pages now
 * disclose rather than hide: one filer's Form D can genuinely be most of a
 * sector, and a wire story genuinely runs in twenty papers.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { compsRows, factsCoverage, periodEndValue } from "../lib/comps";
import { groupOfferings, largestShare, unpackFormD, DOMINANCE_THRESHOLD } from "../lib/formd";
import type { WireIndustryPayload } from "../lib/types";

const DATA = path.resolve(process.cwd(), "data");

/** A margin outside this is arithmetic on mismatched units, not a business. */
const MAX_ABSOLUTE_MARGIN = 1;
/** Below this many companies, a quartile describes its sample, not a sector. */
const MIN_QUARTILE_SAMPLE = 4;
/** A fiscal period older than this is not the latest reported period. */
const MAX_PERIOD_AGE_DAYS = 400;
/** More copies than this of one headline is a wire story filling a page. */
const MAX_SAME_HEADLINE = 2;
/**
 * Vercel refuses a prerendered response above 19.07 MB, and the exported JSON
 * for a sector is that response almost byte for byte. Banks once shipped at
 * 21.26 MB and the page simply did not exist in production. These payloads grow
 * on their own as price history accumulates, so the warning has to come with
 * room to act on it rather than at the point of failure.
 */
const PAYLOAD_LIMIT_MB = 19.07;
const PAYLOAD_WARN_MB = 15;

type Problem = { level: "error" | "warning"; where: string; message: string };

/**
 * The end of a fiscal-period label, as a date.
 *
 * Shares its parsing with the page, which sorts periods by the same value, so
 * the guard cannot disagree with the table it is checking. A label that does
 * not parse returns null: the period column is displayed as filed, and
 * inventing a date for it would hide the thing worth seeing.
 */
export function periodEnd(period: string | null): Date | null {
  if (!period) return null;
  const value = periodEndValue(period);
  return value ? new Date(value) : null;
}

/** Whether three quartiles are the same number, which one company guarantees. */
export function flatQuartiles(values: (number | null)[]): boolean {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 3 && present.every((value) => value === present[0]);
}

async function checkSector(file: string, generatedAt: Date): Promise<Problem[]> {
  const wire = JSON.parse(await readFile(path.join(DATA, "sectors", file), "utf8")) as WireIndustryPayload;
  const payload = { ...wire, formD: unpackFormD(wire.formD) };
  const slug = payload.sector.slug;
  const problems: Problem[] = [];
  const fund = payload.sector.primary_etf;
  const holdings = payload.holdings.filter((row) => row.fund_ticker === fund);

  // 48: a weight of zero or less is not a position, and a blank ticker cannot
  // be resolved to a company on any page that links to one.
  for (const row of holdings) {
    if (!(row.weight > 0)) {
      problems.push({ level: "error", where: slug, message: `${fund} holds ${row.constituent_ticker} at weight ${row.weight}` });
    }
    if (!row.constituent_ticker?.trim()) {
      problems.push({ level: "error", where: slug, message: `${fund} has a holdings row with no ticker` });
    }
  }

  const summaries = compsRows(payload);
  const coverage = factsCoverage(holdings, payload.companyFacts);

  // 43: the page prints sector percentiles only when the facts cover most of
  // the fund including its largest holding. If that ever stops being true while
  // the flag still says it is, the percentiles become a claim about a subset.
  if (coverage.reliable && coverage.largest && !coverage.largest.covered) {
    problems.push({
      level: "error", where: slug,
      message: `percentiles are marked reliable but ${coverage.largest.ticker}, the largest holding at `
        + `${(coverage.largest.weight * 100).toFixed(1)}%, has no reported facts`,
    });
  }

  for (const summary of summaries) {
    // 44: plausibleMargin exists to null these out. Reaching the export means
    // a path around it, and the page would print several thousand percent.
    for (const [name, value] of [["gross", summary.grossMargin], ["operating", summary.operatingMargin], ["net", summary.netMargin]] as const) {
      if (value !== null && Math.abs(value) > MAX_ABSOLUTE_MARGIN) {
        problems.push({ level: "error", where: slug, message: `${summary.ticker} ${name} margin is ${(value * 100).toFixed(0)}%` });
      }
    }
    // 46: a label from 2019 under a heading about the latest reported period is
    // not the latest reported period.
    const end = periodEnd(summary.period);
    if (end && (generatedAt.getTime() - end.getTime()) / 86_400_000 > MAX_PERIOD_AGE_DAYS) {
      problems.push({ level: "error", where: slug, message: `${summary.ticker} reports ${summary.period}, over ${MAX_PERIOD_AGE_DAYS} days before this build` });
    }
  }

  // 45: percentiles over a handful of companies describe the handful. Utilities
  // showed 15.46% at the 25th, the median and the 75th, from one company.
  if (coverage.reliable && summaries.length < MIN_QUARTILE_SAMPLE) {
    problems.push({
      level: "error", where: slug,
      message: `percentiles are marked reliable over ${summaries.length} companies`,
    });
  }

  // 49: a filer's own number can be most of a sector, and the panel now says so.
  // This confirms the disclosure would fire rather than silently not applying.
  const offerings = groupOfferings(payload.formD);
  const biggest = largestShare(offerings);
  if (biggest && biggest.share >= DOMINANCE_THRESHOLD) {
    problems.push({
      level: "warning", where: slug,
      message: `${(biggest.share * 100).toFixed(0)}% of the Form D total is one offering `
        + `(${biggest.offering.latest.issuer_name}); the panel discloses this`,
    });
  }

  // 50: one story republished across outlets, which the ingest now collapses.
  const counts = new Map<string, number>();
  for (const headline of payload.headlines) {
    const key = headline.headline.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).join(" ");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count > MAX_SAME_HEADLINE) {
      problems.push({ level: "warning", where: slug, message: `${count} headlines share the title "${key.slice(0, 60)}"` });
    }
  }

  return problems;
}

async function main() {
  const meta = JSON.parse(await readFile(path.join(DATA, "meta.json"), "utf8")) as { generated_at: string };
  const generatedAt = new Date(meta.generated_at);
  const files = (await readdir(path.join(DATA, "sectors"))).filter((file) => file.endsWith(".json"));
  const problems = (await Promise.all(files.map((file) => checkSector(file, generatedAt)))).flat();

  // 47: one ticker with two market caps in one build means two writers, and the
  // number a reader sees then depends on which page they opened.
  const caps = new Map<string, Set<number>>();
  for (const file of files) {
    const payload = JSON.parse(await readFile(path.join(DATA, "sectors", file), "utf8")) as WireIndustryPayload;
    for (const row of payload.companyMeta) {
      if (row.market_cap === null) continue;
      const seen = caps.get(row.ticker) ?? new Set<number>();
      seen.add(row.market_cap);
      caps.set(row.ticker, seen);
    }
  }
  for (const [ticker, values] of caps) {
    if (values.size > 1) {
      problems.push({ level: "error", where: "market caps", message: `${ticker} has ${values.size} different market caps in one build` });
    }
  }

  for (const file of files) {
    const bytes = (await stat(path.join(DATA, "sectors", file))).size / 1_048_576;
    const level = bytes >= PAYLOAD_LIMIT_MB ? "error" : bytes >= PAYLOAD_WARN_MB ? "warning" : null;
    if (level) {
      problems.push({
        level, where: file.replace(".json", ""),
        message: `payload is ${bytes.toFixed(2)} MB against Vercel's ${PAYLOAD_LIMIT_MB} MB limit`,
      });
    }
  }

  const errors = problems.filter((problem) => problem.level === "error");
  const warnings = problems.filter((problem) => problem.level === "warning");
  for (const problem of warnings) console.warn(`warning  ${problem.where}: ${problem.message}`);
  for (const problem of errors) console.error(`ERROR    ${problem.where}: ${problem.message}`);
  console.log(`\nChecked ${files.length} sectors: ${errors.length} error(s), ${warnings.length} warning(s).`);
  if (errors.length) process.exit(1);
}

if (process.argv[1]?.includes("check-export")) main();
