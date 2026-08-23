import { packRows, unpackRows, type Packed } from "./wire";
import type { FormD } from "./types";

export type OfferingFiling = Pick<
  FormD,
  "accession_no" | "cik" | "filed_date" | "total_offering_amount" | "amount_sold"
  | "submission_type" | "previous_accession_no" | "file_num" | "is_amendment"
  | "is_equity_type" | "is_debt_type" | "is_option_to_acquire_type"
>;

/**
 * One offering: an original filing and every amendment that restates it.
 *
 * `amountSold` is the latest filing's figure, never a sum. Form D asks for the
 * cumulative total raised to date, so adding an amendment to the filing it
 * amends counts the same money twice.
 */
export type Offering<T extends OfferingFiling> = {
  /** The 021-XXXXXX file number where there is one, else the earliest accession. */
  key: string;
  /** Every filing in the group, oldest first. */
  filings: T[];
  /** The filing whose figures are current. */
  latest: T;
  /** Cumulative amount sold as of the latest filing; null means not reported. */
  amountSold: number | null;
  /** Filing date of the original, which is when the offering began. */
  startDate: string;
  /** The original is not in this data, so `startDate` is an amendment's date. */
  originUnknown: boolean;
  amendments: number;
};

export type FormDCounts = {
  /** Distinct accessions: what the SEC received. */
  filings: number;
  /** Distinct offerings: what was actually being raised. */
  offerings: number;
  /** Accessions that restate an earlier filing. */
  amendments: number;
  /** Offerings whose original is not in this data. */
  orphanOfferings: number;
  /** Filings belonging to those offerings. */
  orphanAmendments: number;
  /** Whether filings = offerings + amendments - orphanOfferings holds here. */
  reconciles: boolean;
};

/**
 * EDGAR files amendments as "D/A"; the data sets carry an explicit flag.
 *
 * The flag is preferred where present because it is the filer's own answer on
 * the form; the form type is the fallback for a row that predates it.
 */
export function isAmendment(
  filing: Pick<FormD, "submission_type"> & Partial<Pick<FormD, "is_amendment">>,
): boolean {
  if (filing.is_amendment !== null && filing.is_amendment !== undefined) return filing.is_amendment;
  return (filing.submission_type ?? "").trim().toUpperCase().startsWith("D/A");
}

const byFiling = (a: OfferingFiling, b: OfferingFiling) =>
  a.filed_date.localeCompare(b.filed_date) || a.accession_no.localeCompare(b.accession_no);

/**
 * Collapse filings into the offerings they describe.
 *
 * EDGAR assigns each offering a 021-XXXXXX file number and keeps it constant
 * across the original and every amendment, which makes it the offering's
 * identity. Filings that carry no file number fall back to the
 * previousAccessionNumber chain, and a chain link pointing outside this set
 * cannot be resolved, so that filing stands alone.
 *
 * Both rules feed one union-find pass rather than being tried in sequence, so a
 * group is still joined when some of its filings have a file number and others
 * only have a chain link.
 */
export function groupOfferings<T extends OfferingFiling>(filings: T[]): Offering<T>[] {
  const ordered = [...filings].sort(byFiling);
  const parent = new Map<string, string>();
  for (const filing of ordered) parent.set(filing.accession_no, filing.accession_no);

  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = key;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  const firstForFileNumber = new Map<string, string>();
  for (const filing of ordered) {
    if (!filing.file_num) continue;
    const earlier = firstForFileNumber.get(filing.file_num);
    if (earlier === undefined) firstForFileNumber.set(filing.file_num, filing.accession_no);
    else union(filing.accession_no, earlier);
  }
  for (const filing of ordered) {
    const previous = filing.previous_accession_no;
    if (previous && parent.has(previous)) union(filing.accession_no, previous);
  }

  const grouped = new Map<string, T[]>();
  for (const filing of ordered) {
    const root = find(filing.accession_no);
    const group = grouped.get(root);
    if (group) group.push(filing);
    else grouped.set(root, [filing]);
  }

  return [...grouped.values()]
    .map((group) => {
      const earliest = group[0];
      const latest = group[group.length - 1];
      const originals = group.filter((filing) => !isAmendment(filing)).length;
      return {
        key: group.find((filing) => filing.file_num)?.file_num ?? earliest.accession_no,
        filings: group,
        latest,
        // Cumulative as of the latest filing. Never summed across the group.
        amountSold: latest.amount_sold,
        // The original's filing date, so an amendment does not move an
        // offering into the quarter it was amended in.
        startDate: earliest.filed_date,
        // Defined as "no original in this data" rather than "the earliest
        // filing is an amendment", so it agrees exactly with the orphan count.
        originUnknown: originals === 0,
        amendments: group.length - originals,
      };
    })
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.key.localeCompare(b.key));
}

/**
 * The four counts that have to agree, computed once from one grouping.
 *
 * filings = offerings + amendments - orphanOfferings.
 *
 * An offering holding an original and k amendments contributes 1 + k filings
 * and 1 offering, so the amendments cancel. An offering whose original is
 * missing contributes only amendments, and is still one offering, so it is
 * counted once too often and subtracted back out. The subtraction is over
 * orphan offerings, not orphan filings: an offering with three amendments and
 * no original is one unit of over-count, not three.
 *
 * `reconciles` is reported rather than assumed. The identity needs every
 * offering that has an original to have exactly one, which is true of every
 * filing since 2019 but is not something this data guarantees.
 */
export function formDCounts<T extends OfferingFiling>(filings: T[]): FormDCounts {
  const offerings = groupOfferings(filings);
  const orphans = offerings.filter((offering) => offering.originUnknown);
  const counts = {
    filings: new Set(filings.map((filing) => filing.accession_no)).size,
    offerings: offerings.length,
    amendments: filings.filter(isAmendment).length,
    orphanOfferings: orphans.length,
    orphanAmendments: orphans.reduce((sum, offering) => sum + offering.filings.length, 0),
  };
  return {
    ...counts,
    reconciles:
      counts.filings === counts.offerings + counts.amendments - counts.orphanOfferings,
  };
}

/**
 * Total reported raised, summed over distinct accessions.
 *
 * Issuers are a many-to-one attribute of a filing, never a multiplier: a Form D
 * naming three co-issuers still reports one amount, once. Summing a list that
 * has been widened to issuer grain multiplies that amount by the issuer count.
 * Keying the sum on accession makes that impossible to reintroduce by accident,
 * whatever shape the caller's array arrived in.
 *
 * A null amount is not reported and contributes to counts only, so it is not
 * folded in as a zero.
 */
export function totalRaised(filings: Pick<FormD, "accession_no" | "amount_sold">[]): number {
  const byAccession = new Map<string, number>();
  for (const filing of filings) {
    if (filing.amount_sold !== null) byAccession.set(filing.accession_no, filing.amount_sold);
  }
  return [...byAccession.values()].reduce((sum, value) => sum + value, 0);
}

/**
 * The co-issuer marker for one row, or null when the filing names one issuer.
 *
 * A filing with co-issuers is one offering reporting one amount. Giving each
 * co-issuer its own table row would imply the amount was raised several times.
 */
export function coIssuerLabel(filing: Pick<FormD, "issuer_count">): string | null {
  const count = filing.issuer_count ?? 1;
  if (count <= 1) return null;
  return `+${count - 1} co-issuer${count === 2 ? "" : "s"}`;
}


export type DebtSplit = {
  /** Debt dollars over classified dollars, or null when nothing is classified. */
  share: number | null;
  /** Reported dollars in offerings that include a debt security. */
  debt: number;
  /** Reported dollars in offerings that stated any security type. */
  classified: number;
  /** Reported dollars in offerings that ticked no security type at all. */
  unclassified: number;
  /** Offerings selling both equity and debt, counted in full under debt. */
  mixed: number;
};

/**
 * How much of a sector's private money is debt rather than equity.
 *
 * The security-type boxes are not exclusive: an offering can sell equity and
 * debt together, and one that does is counted in full under debt, so this is
 * the share of money in offerings that involve debt rather than a split of
 * every dollar. `mixed` says how many offerings that affects.
 *
 * Offerings ticking no box at all are left out of both sides rather than
 * treated as equity. They are 30% of reported dollars, so folding them into the
 * denominator would halve the figure on nothing but an assumption. `unclassified`
 * carries them so the panel can say what the share is not measured over.
 */
export function debtSplit<T extends OfferingFiling>(offerings: Offering<T>[]): DebtSplit {
  let debt = 0;
  let classified = 0;
  let unclassified = 0;
  let mixed = 0;
  for (const offering of offerings) {
    if (offering.amountSold === null) continue;
    const filing = offering.latest;
    const stated = filing.is_equity_type || filing.is_debt_type || filing.is_option_to_acquire_type;
    if (!stated) {
      unclassified += offering.amountSold;
      continue;
    }
    classified += offering.amountSold;
    if (filing.is_debt_type) {
      debt += offering.amountSold;
      if (filing.is_equity_type) mixed += 1;
    }
  }
  return { share: classified > 0 ? debt / classified : null, debt, classified, unclassified, mixed };
}


export type Coverage = { earliest: string | null; latest: string | null };

/**
 * What Form D actually covers, said plainly against the range the reader picked.
 *
 * The panel used to describe its contents as "this window", which claimed the
 * selected range. Form D holds published quarters plus however much of the
 * quarter in progress has been crawled, so the real range is usually narrower
 * at both ends. Stating the two separately is the difference between a reader
 * seeing a quiet quarter and seeing a gap in collection.
 *
 * Returns null when there is nothing to describe.
 */
export function coverageNote(coverage: Coverage, start: string, end: string): string | null {
  const { earliest, latest } = coverage;
  if (!earliest || !latest) return null;
  const startsLater = earliest > start;
  const endsEarlier = latest < end;
  const head = `Form D coverage for this sector runs ${earliest} to ${latest}.`;
  if (!startsLater && !endsEarlier) return `${head} That covers the whole of the selected range.`;
  const gaps = [
    startsLater ? `nothing before ${earliest} has been collected` : "",
    endsEarlier ? `nothing after ${latest} has been filed or collected yet` : "",
  ].filter(Boolean);
  return `${head} The selected range is ${start} to ${end}, so the panel below covers less than the range you picked: ${gaps.join(", and ")}.`;
}


export const FORM_D_COLUMNS = [
  "accession_no", "filed_date", "cik", "issuer_name", "sic_code", "sector_slug", "issuer_ticker",
  "total_offering_amount", "amount_sold", "state", "submission_type",
  "previous_accession_no", "industry_group", "file_num", "is_amendment",
  "issuer_count", "pooled_name_match", "is_equity_type", "is_debt_type",
  "is_option_to_acquire_type",
] as const satisfies readonly (keyof FormD)[];

export type PackedFormD = Packed<FormD>;
export const packFormD = (rows: FormD[]): PackedFormD => packRows(FORM_D_COLUMNS, rows);
export const unpackFormD = (packed: PackedFormD): FormD[] => unpackRows(packed);


/**
 * The offerings that have actually taken money.
 *
 * Zero is a real answer on Form D and 19,093 filings give it: the offering is
 * declared and nothing has closed yet. Averaged in as a raise it answers a
 * different question from the one the label asks, and it halves the result:
 * Real Estate's median offering read $1.0m against the $2.59m typical of the
 * offerings that have taken money.
 */
export function raisedOfferings<T extends OfferingFiling>(offerings: Offering<T>[]): Offering<T>[] {
  return offerings.filter((offering) => offering.amountSold !== null && offering.amountSold > 0);
}


/**
 * The share of a sector's reported total sitting in its single largest offering.
 *
 * Form D amounts are what the filer typed and the SEC does not check them, so
 * one number can carry a whole sector: Republic Airways was 76% of Transport,
 * Madison Air Solutions half of Industrials, and a $10B claim from an unknown
 * entity is indistinguishable from a real one in the data. A total resting on a
 * single unverified filing should say so rather than read as a market size.
 */
export function largestShare<T extends OfferingFiling>(
  offerings: Offering<T>[],
): { share: number; offering: Offering<T> } | null {
  const reported = offerings.filter((offering) => offering.amountSold !== null);
  // With a handful of offerings the largest is inevitably a large share of the
  // total, and saying so tells a reader nothing: three equal offerings put the
  // biggest at a third. The warning is about a total that reads as a sector
  // aggregate while resting on one filing, which needs enough filings to look
  // like an aggregate in the first place.
  if (reported.length < MIN_OFFERINGS_FOR_DOMINANCE) return null;
  const total = reported.reduce((sum, offering) => sum + (offering.amountSold ?? 0), 0);
  if (total <= 0) return null;
  const biggest = reported.reduce((a, b) => ((b.amountSold ?? 0) > (a.amountSold ?? 0) ? b : a));
  return { share: (biggest.amountSold ?? 0) / total, offering: biggest };
}

/** Above this, one filing is the sector total rather than part of it. */
export const DOMINANCE_THRESHOLD = 0.3;
export const MIN_OFFERINGS_FOR_DOMINANCE = 5;
