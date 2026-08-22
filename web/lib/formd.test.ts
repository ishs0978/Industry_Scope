import { describe, expect, it } from "vitest";
import {
  coIssuerLabel, coverageNote, debtSplit, formDCounts, groupOfferings, isAmendment,
  packFormD, totalRaised, unpackFormD, FORM_D_COLUMNS, type OfferingFiling,
} from "./formd";

const filing = (
  accession_no: string,
  filed_date: string,
  amount_sold: number | null,
  extra: Partial<OfferingFiling> = {},
): OfferingFiling => ({
  accession_no,
  filed_date,
  cik: "0000000001",
  total_offering_amount: 10_000_000,
  amount_sold,
  submission_type: "D",
  previous_accession_no: null,
  file_num: null,
  is_amendment: false,
  is_equity_type: false,
  is_debt_type: false,
  is_option_to_acquire_type: false,
  ...extra,
});

const amendment = (
  accession_no: string,
  filed_date: string,
  amount_sold: number | null,
  extra: Partial<OfferingFiling> = {},
) => filing(accession_no, filed_date, amount_sold, {
  submission_type: "D/A", is_amendment: true, ...extra,
});

const raised = (filings: OfferingFiling[]) =>
  totalRaised(groupOfferings(filings).map((offering) => offering.latest));

describe("amendment detection", () => {
  it("prefers the filer's own flag and falls back to the form type", () => {
    expect(isAmendment({ submission_type: "D", is_amendment: true })).toBe(true);
    expect(isAmendment({ submission_type: "D/A", is_amendment: false })).toBe(false);
    expect(isAmendment({ submission_type: "D/A" })).toBe(true);
    expect(isAmendment({ submission_type: "D" })).toBe(false);
    expect(isAmendment({ submission_type: null })).toBe(false);
  });
});

describe("offering identity", () => {
  it("groups an original and its amendments by file number", () => {
    const offerings = groupOfferings([
      filing("0001", "2024-01-15", 4_000_000, { file_num: "021-111111" }),
      amendment("0002", "2024-06-20", 9_000_000, { file_num: "021-111111" }),
      amendment("0003", "2025-02-10", 12_000_000, { file_num: "021-111111" }),
    ]);
    expect(offerings).toHaveLength(1);
    expect(offerings[0].key).toBe("021-111111");
    expect(offerings[0].filings).toHaveLength(3);
    expect(offerings[0].amendments).toBe(2);
  });

  it("takes dollars from the latest filing and never sums the group", () => {
    // Form D reports the cumulative total raised to date, so 4 + 9 + 12 would
    // count the same money three times.
    expect(raised([
      filing("0001", "2024-01-15", 4_000_000, { file_num: "021-111111" }),
      amendment("0002", "2024-06-20", 9_000_000, { file_num: "021-111111" }),
      amendment("0003", "2025-02-10", 12_000_000, { file_num: "021-111111" }),
    ])).toBe(12_000_000);
  });

  it("dates an offering from its original, not its latest amendment", () => {
    const [offering] = groupOfferings([
      filing("0001", "2024-01-15", 4_000_000, { file_num: "021-111111" }),
      amendment("0003", "2025-02-10", 12_000_000, { file_num: "021-111111" }),
    ]);
    // The money was raised from 2024 onward. Booking it to 2025 Q1 because
    // that is when the filer amended would move it into the wrong quarter.
    expect(offering.startDate).toBe("2024-01-15");
    expect(offering.latest.accession_no).toBe("0003");
    expect(offering.originUnknown).toBe(false);
  });

  it("keeps two genuinely separate offerings apart", () => {
    // Three affiliated entities each filing their own Form D for one deal get
    // three file numbers from EDGAR, so they stay three offerings.
    const offerings = groupOfferings([
      filing("0001", "2026-08-17", 295_000_000, { file_num: "021-594432" }),
      filing("0002", "2026-08-17", 295_000_000, { file_num: "021-594436" }),
      filing("0003", "2026-08-17", 295_000_000, { file_num: "021-594427" }),
    ]);
    expect(offerings).toHaveLength(3);
    expect(totalRaised(offerings.map((offering) => offering.latest))).toBe(885_000_000);
  });

  it("falls back to the accession chain when there is no file number", () => {
    const offerings = groupOfferings([
      filing("0001", "2024-01-15", 4_000_000),
      amendment("0002", "2024-06-20", 9_000_000, { previous_accession_no: "0001" }),
    ]);
    expect(offerings).toHaveLength(1);
    expect(offerings[0].key).toBe("0001");
  });

  it("joins a group where only some filings carry a file number", () => {
    const offerings = groupOfferings([
      filing("0001", "2024-01-15", 4_000_000, { file_num: "021-111111" }),
      amendment("0002", "2024-06-20", 9_000_000, { previous_accession_no: "0001" }),
      amendment("0003", "2024-09-01", 11_000_000, { file_num: "021-111111" }),
    ]);
    expect(offerings).toHaveLength(1);
    expect(offerings[0].amountSold).toBe(11_000_000);
  });

  it("leaves a filing alone when its chain points outside the window", () => {
    const offerings = groupOfferings([
      amendment("0002", "2024-06-20", 9_000_000, { previous_accession_no: "0001" }),
    ]);
    expect(offerings).toHaveLength(1);
    expect(offerings[0].originUnknown).toBe(true);
  });

  it("distinguishes a reported zero from an unreported amount", () => {
    const offerings = groupOfferings([
      filing("0001", "2024-01-15", 0, { file_num: "021-111111" }),
      filing("0002", "2024-01-15", null, { file_num: "021-222222" }),
    ]);
    expect(offerings.map((offering) => offering.amountSold)).toEqual([0, null]);
    // A null contributes to counts only; a zero is a real datapoint.
    expect(totalRaised(offerings.map((offering) => offering.latest))).toBe(0);
  });

  it("flags an offering whose original is missing", () => {
    const [offering] = groupOfferings([
      amendment("0002", "2024-06-20", 9_000_000, { file_num: "021-111111" }),
      amendment("0003", "2024-09-01", 11_000_000, { file_num: "021-111111" }),
    ]);
    expect(offering.originUnknown).toBe(true);
    expect(offering.startDate).toBe("2024-06-20");
    // It stays in the table; only the quarterly chart drops it, because its
    // start date is an amendment's date and would land in the wrong quarter.
    expect(offering.amountSold).toBe(11_000_000);
  });
});

describe("count reconciliation", () => {
  it("reconciles filings against offerings, amendments and orphans", () => {
    const counts = formDCounts([
      // One offering, an original plus two amendments.
      filing("0001", "2024-01-15", 4_000_000, { file_num: "021-111111" }),
      amendment("0002", "2024-06-20", 9_000_000, { file_num: "021-111111" }),
      amendment("0003", "2025-02-10", 12_000_000, { file_num: "021-111111" }),
      // One offering, original only.
      filing("0004", "2024-03-01", 1_000_000, { file_num: "021-222222" }),
      // One offering whose original is not here, with two amendments.
      amendment("0005", "2024-04-01", 2_000_000, { file_num: "021-333333" }),
      amendment("0006", "2024-08-01", 3_000_000, { file_num: "021-333333" }),
    ]);
    expect(counts.filings).toBe(6);
    expect(counts.offerings).toBe(3);
    expect(counts.amendments).toBe(4);
    expect(counts.orphanOfferings).toBe(1);
    expect(counts.orphanAmendments).toBe(2);
    expect(counts.reconciles).toBe(true);
    expect(counts.filings).toBe(
      counts.offerings + counts.amendments - counts.orphanOfferings,
    );
  });

  it("subtracts orphan offerings, not orphan filings", () => {
    const counts = formDCounts([
      amendment("0005", "2024-04-01", 2_000_000, { file_num: "021-333333" }),
      amendment("0006", "2024-08-01", 3_000_000, { file_num: "021-333333" }),
      amendment("0007", "2024-09-01", 4_000_000, { file_num: "021-333333" }),
    ]);
    // Three orphan filings, but one offering. Subtracting the filings would
    // give 1 + 3 - 3 = 1 against 3 actual filings.
    expect(counts.orphanAmendments).toBe(3);
    expect(counts.orphanOfferings).toBe(1);
    expect(counts.filings).toBe(3);
    expect(counts.offerings + counts.amendments - counts.orphanOfferings).toBe(3);
    expect(counts.offerings + counts.amendments - counts.orphanAmendments).not.toBe(3);
  });

  it("reports an empty window without claiming a broken identity", () => {
    const counts = formDCounts([]);
    expect(counts).toMatchObject({ filings: 0, offerings: 0, amendments: 0, reconciles: true });
  });
});

describe("accession-level dollar totals", () => {
  const co = (accession_no: string, amount_sold: number | null, issuer_count: number) => ({
    accession_no, amount_sold, issuer_count,
  });

  it("counts an offering once however many issuers it names", () => {
    // The staging tables key issuers by accession plus sequence, so a filing
    // with three co-issuers has three issuer rows and one $295M offering.
    // Widening to issuer grain and summing would report $885M.
    const widened = [co("0001", 295_000_000, 3), co("0001", 295_000_000, 3), co("0001", 295_000_000, 3)];
    expect(totalRaised(widened)).toBe(295_000_000);
  });

  it("still adds genuinely separate accessions", () => {
    expect(totalRaised([co("0001", 295_000_000, 1), co("0002", 295_000_000, 1)])).toBe(590_000_000);
  });

  it("treats an unreported amount as absent, not zero", () => {
    expect(totalRaised([co("0001", null, 1), co("0002", 10, 1)])).toBe(10);
  });

  it("labels co-issuers instead of emitting a row each", () => {
    expect(coIssuerLabel({ issuer_count: 3 })).toBe("+2 co-issuers");
    expect(coIssuerLabel({ issuer_count: 2 })).toBe("+1 co-issuer");
    expect(coIssuerLabel({ issuer_count: 1 })).toBeNull();
    expect(coIssuerLabel({ issuer_count: null })).toBeNull();
  });
});

describe("debt and equity split", () => {
  const typed = (
    accession_no: string, amount_sold: number | null,
    types: Partial<Pick<OfferingFiling, "is_equity_type" | "is_debt_type" | "is_option_to_acquire_type">>,
  ) => filing(accession_no, "2024-01-15", amount_sold, {
    file_num: `021-${accession_no}`,
    is_equity_type: false, is_debt_type: false, is_option_to_acquire_type: false, ...types,
  });

  it("measures debt against classified dollars only", () => {
    const split = debtSplit(groupOfferings([
      typed("0001", 300, { is_debt_type: true }),
      typed("0002", 700, { is_equity_type: true }),
      // Ticked nothing: not evidence of equity, so it stays out of both sides.
      typed("0003", 9_000, {}),
    ]));
    expect(split.share).toBe(0.3);
    expect(split.classified).toBe(1_000);
    expect(split.unclassified).toBe(9_000);
  });

  it("counts an offering selling both in full under debt and says so", () => {
    const split = debtSplit(groupOfferings([
      typed("0001", 500, { is_debt_type: true, is_equity_type: true }),
      typed("0002", 500, { is_equity_type: true }),
    ]));
    // The boxes are not exclusive and the form gives no split, so the panel
    // reports money involving debt rather than inventing a proportion.
    expect(split.share).toBe(0.5);
    expect(split.mixed).toBe(1);
  });

  it("reads the amendment's security type, not the original's", () => {
    const split = debtSplit(groupOfferings([
      typed("0001", 100, { is_equity_type: true }),
      { ...typed("0002", 400, { is_debt_type: true }), file_num: "021-0001",
        submission_type: "D/A", is_amendment: true },
    ]));
    expect(split.share).toBe(1);
    expect(split.classified).toBe(400);
  });

  it("returns null rather than zero when nothing is classified", () => {
    expect(debtSplit(groupOfferings([typed("0001", 100, {})])).share).toBeNull();
    expect(debtSplit([]).share).toBeNull();
  });

  it("ignores offerings with no reported amount", () => {
    const split = debtSplit(groupOfferings([
      typed("0001", null, { is_debt_type: true }),
      typed("0002", 100, { is_equity_type: true }),
    ]));
    expect(split.share).toBe(0);
    expect(split.classified).toBe(100);
  });
});

describe("coverage against the selected range", () => {
  const c = (earliest: string | null, latest: string | null) => ({ earliest, latest });

  it("says so plainly when coverage fills the range", () => {
    expect(coverageNote(c("2019-01-02", "2026-08-21"), "2021-08-21", "2026-08-21"))
      .toBe("Form D coverage for this sector runs 2019-01-02 to 2026-08-21. That covers the whole of the selected range.");
  });

  it("names both ends when the data is narrower than the range picked", () => {
    // Picking Max asks for the whole price history, which starts long before
    // Form D was collected. Reporting that as a quiet decade would be a lie.
    const note = coverageNote(c("2019-01-02", "2026-08-21"), "1998-12-22", "2026-12-31")!;
    expect(note).toContain("The selected range is 1998-12-22 to 2026-12-31");
    expect(note).toContain("nothing before 2019-01-02 has been collected");
    expect(note).toContain("nothing after 2026-08-21 has been filed or collected yet");
    expect(note.endsWith(".")).toBe(true);
    expect(note).not.toContain(" .");
  });

  it("names only the end that falls short", () => {
    const early = coverageNote(c("2019-01-02", "2026-08-21"), "2010-01-01", "2026-08-21")!;
    expect(early).toContain("nothing before");
    expect(early).not.toContain("nothing after");
    const late = coverageNote(c("2019-01-02", "2026-06-30"), "2019-01-02", "2026-08-21")!;
    expect(late).toContain("nothing after 2026-06-30");
    expect(late).not.toContain("nothing before");
  });

  it("says nothing when there is no Form D data at all", () => {
    expect(coverageNote(c(null, null), "2019-01-01", "2026-01-01")).toBeNull();
  });
});

describe("wire packing", () => {
  const row = filing("0001", "2024-01-15", 4_000_000, {
    file_num: "021-111111", is_debt_type: true,
  }) as unknown as Parameters<typeof packFormD>[0][number];

  it("round-trips every column", () => {
    const restored = unpackFormD(packFormD([row]));
    expect(restored).toHaveLength(1);
    for (const column of FORM_D_COLUMNS) {
      expect(restored[0][column]).toEqual((row as never)[column]);
    }
  });

  it("sends each column name once instead of once per row", () => {
    const many = Array.from({ length: 500 }, () => row);
    const packed = JSON.stringify(packFormD(many)).length;
    const objects = JSON.stringify(many).length;
    // The whole point: repeating nineteen key names per row is what pushed the
    // banks page past the size limit for a prerendered response.
    expect(packed).toBeLessThan(objects / 2);
  });

  it("decodes using the columns on the payload, not the current constant", () => {
    // A response cached before a column was added still has to decode.
    const legacy = { columns: ["accession_no", "amount_sold"], rows: [["0009", 42]] } as const;
    const restored = unpackFormD(legacy as unknown as Parameters<typeof unpackFormD>[0]);
    expect(restored[0].accession_no).toBe("0009");
    expect(restored[0].amount_sold).toBe(42);
  });

  it("handles an empty payload", () => {
    expect(unpackFormD(packFormD([]))).toEqual([]);
  });
});
