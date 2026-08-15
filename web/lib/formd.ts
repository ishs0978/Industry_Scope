import type { FormD } from "./types";

export type OfferingFiling = Pick<
  FormD,
  "accession_no" | "cik" | "filed_date" | "total_offering_amount"
  | "submission_type" | "previous_accession_no"
>;

/** EDGAR files amendments as "D/A"; originals are "D". */
export function isAmendment(filing: Pick<FormD, "submission_type">): boolean {
  return (filing.submission_type ?? "").trim().toUpperCase().startsWith("D/A");
}

/**
 * Collapse a Form D chain to one filing per offering, keeping the most recent.
 *
 * An amendment restates the cumulative amount raised rather than reporting a new
 * increment, so summing `amount_sold` across every row counts an amended
 * offering two or more times.
 *
 * Filings are grouped by the previousAccessionNumber chain where the filer
 * supplied one. An amendment that omits that link falls back to matching an
 * earlier filing from the same issuer for the same total offering amount.
 * Originals never merge on that fallback, so two genuinely separate offerings
 * of the same size stay separate.
 */
export function latestFilingPerOffering<T extends OfferingFiling>(filings: T[]): T[] {
  const ordered = [...filings].sort((a, b) =>
    a.filed_date.localeCompare(b.filed_date) || a.accession_no.localeCompare(b.accession_no));

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

  const offeringKey = (filing: OfferingFiling) =>
    filing.cik === null || filing.total_offering_amount === null
      ? null
      : `${filing.cik}:${filing.total_offering_amount}`;

  const representative = new Map<string, string>();
  for (const filing of ordered) {
    const previous = filing.previous_accession_no;
    // Only chain to a filing that is actually in this set; a link pointing
    // outside the window cannot be resolved and the filing stands alone.
    if (previous && parent.has(previous)) union(filing.accession_no, previous);

    const key = offeringKey(filing);
    if (key === null) continue;
    const earlier = representative.get(key);
    if (earlier === undefined) representative.set(key, filing.accession_no);
    else if (isAmendment(filing)) union(filing.accession_no, earlier);
  }

  const latest = new Map<string, T>();
  for (const filing of ordered) {
    const root = find(filing.accession_no);
    const current = latest.get(root);
    // `ordered` is ascending, so a later filing always supersedes.
    if (current === undefined || filing.filed_date >= current.filed_date) latest.set(root, filing);
  }
  return [...latest.values()].sort((a, b) =>
    a.filed_date.localeCompare(b.filed_date) || a.accession_no.localeCompare(b.accession_no));
}
