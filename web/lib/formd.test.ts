import { describe, expect, it } from "vitest";
import { isAmendment, latestFilingPerOffering, type OfferingFiling } from "./formd";

type Filing = OfferingFiling & { amount_sold: number | null };

const filing = (
  accession_no: string,
  filed_date: string,
  amount_sold: number | null,
  extra: Partial<Filing> = {},
): Filing => ({
  accession_no,
  filed_date,
  cik: "0000000001",
  total_offering_amount: 10_000_000,
  amount_sold,
  submission_type: "D",
  previous_accession_no: null,
  ...extra,
});

const raised = (filings: Filing[]) =>
  latestFilingPerOffering(filings).reduce((sum, row) => sum + (row.amount_sold ?? 0), 0);

describe("Form D offering deduplication", () => {
  it("identifies amendments by submission type", () => {
    expect(isAmendment({ submission_type: "D/A" })).toBe(true);
    expect(isAmendment({ submission_type: "D" })).toBe(false);
    expect(isAmendment({ submission_type: null })).toBe(false);
  });

  it("counts an amended offering once, using the restated amount", () => {
    const filings = [
      filing("0001", "2026-01-15", 4_000_000),
      filing("0002", "2026-05-20", 9_000_000, { submission_type: "D/A", previous_accession_no: "0001" }),
    ];
    // Summing both rows would report 13,000,000 for a 9,000,000 offering.
    expect(raised(filings)).toBe(9_000_000);
    expect(latestFilingPerOffering(filings).map((row) => row.accession_no)).toEqual(["0002"]);
  });

  it("collapses a multi-step amendment chain to the newest filing", () => {
    const filings = [
      filing("0001", "2026-01-15", 4_000_000),
      filing("0002", "2026-03-01", 6_000_000, { submission_type: "D/A", previous_accession_no: "0001" }),
      filing("0003", "2026-06-01", 9_500_000, { submission_type: "D/A", previous_accession_no: "0002" }),
    ];
    expect(raised(filings)).toBe(9_500_000);
  });

  it("falls back to issuer and offering size when the chain link is missing", () => {
    const filings = [
      filing("0001", "2026-01-15", 4_000_000),
      filing("0002", "2026-05-20", 9_000_000, { submission_type: "D/A" }),
    ];
    expect(raised(filings)).toBe(9_000_000);
  });

  it("keeps separate offerings from the same issuer separate", () => {
    // Two originals, never merged by the fallback even at the same size.
    const filings = [
      filing("0001", "2026-01-15", 4_000_000),
      filing("0002", "2026-05-20", 5_000_000),
    ];
    expect(raised(filings)).toBe(9_000_000);
    expect(latestFilingPerOffering(filings)).toHaveLength(2);
  });

  it("keeps different issuers separate", () => {
    const filings = [
      filing("0001", "2026-01-15", 4_000_000),
      filing("0002", "2026-05-20", 6_000_000, { cik: "0000000002", submission_type: "D/A" }),
    ];
    expect(raised(filings)).toBe(10_000_000);
  });

  it("leaves a filing standing alone when its chain target is outside the window", () => {
    const filings = [
      filing("0009", "2026-05-20", 9_000_000, {
        submission_type: "D/A", previous_accession_no: "0001", total_offering_amount: null,
      }),
    ];
    expect(latestFilingPerOffering(filings).map((row) => row.accession_no)).toEqual(["0009"]);
  });

  it("returns every filing unchanged when there are no amendments", () => {
    const filings = [
      filing("0001", "2026-01-15", 1_000_000, { total_offering_amount: 1_000_000 }),
      filing("0002", "2026-02-15", 2_000_000, { total_offering_amount: 2_000_000 }),
      filing("0003", "2026-03-15", null, { total_offering_amount: 3_000_000 }),
    ];
    expect(latestFilingPerOffering(filings)).toHaveLength(3);
    expect(raised(filings)).toBe(3_000_000);
  });
});
