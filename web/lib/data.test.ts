import { describe, expect, it } from "vitest";
import { gateMacroByFreshness, macroSourceAllowed, serializable } from "./data";

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
