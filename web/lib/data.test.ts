import { describe, expect, it } from "vitest";
import { gateMacroByFreshness, macroSourceAllowed, serializable, isDatabaseUnreachable } from "./data";

describe("macro source gates", () => {
  it("test_eia_energy_only", () => {
    expect(macroSourceAllowed("energy", "EIA")).toBe(true);
    for (const slug of ["semiconductors", "consumer-discretionary", "gold-metals"]) {
      expect(macroSourceAllowed(slug, "EIA")).toBe(false);
    }
  });

  it("suppresses observations from a failed source", () => {
    const meta = [
      { series_id: "EIA:ONE", source: "EIA" },
      { series_id: "FRED:ONE", source: "FRED" },
    ];
    const series = meta.map((item) => ({ series_id: item.series_id }));
    expect(gateMacroByFreshness(meta, series, [{ source: "eia", status: "failed" }])).toEqual({
      meta: [{ series_id: "FRED:ONE", source: "FRED" }],
      series: [{ series_id: "FRED:ONE" }],
    });
  });

  it("redacts source credentials from public freshness errors", () => {
    const payload = serializable({ error: "https://api.example.test/data?api_key=secret-value&length=5" });
    expect(payload.error).toBe("https://api.example.test/data?api_key=[REDACTED]&length=5");
  });
});

describe("a dead database must not replace good pages", () => {
  it("recognises the failures that mean the database is unreachable", () => {
    // The exact message Neon returned when the quota ran out. Caught and
    // swallowed, it rendered every page empty and Next cached that over the
    // last good version of the site.
    expect(isDatabaseUnreachable(new Error(
      "connection failed: ERROR:  Your project has exceeded the data transfer quota.",
    ))).toBe(true);
    for (const message of [
      "write CONNECTION_DESTROYED ep-x.aws.neon.tech:5432",
      "connect ETIMEDOUT 10.0.0.1:5432",
      "Connection terminated unexpectedly",
      "password authentication failed for user",
      "sorry, too many clients already",
    ]) {
      expect(isDatabaseUnreachable(new Error(message))).toBe(true);
    }
  });

  it("still lets a query fail on its own without taking the page down", () => {
    // One broken source should show its own error, not blank the page.
    expect(isDatabaseUnreachable(new Error('relation "form_d" does not exist'))).toBe(false);
    expect(isDatabaseUnreachable(new Error("column sic_code does not exist"))).toBe(false);
    expect(isDatabaseUnreachable(new Error("division by zero"))).toBe(false);
  });
});
