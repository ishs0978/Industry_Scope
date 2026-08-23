import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The reader has to prefer the exported file and only fall back to the database
 * when there is no export, because falling back for a company that simply is
 * not in the export would reopen the connections this whole change removes.
 */
function withExport(files: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), "export-"));
  for (const [relative, value] of Object.entries(files)) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(value));
  }
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  return dir;
}

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe("payload source", () => {
  it("reads a sector from the export without touching the database", async () => {
    withExport({ "data/meta.json": { generated_at: "x" }, "data/sectors/energy.json": { sector: { slug: "energy" } } });
    const { industryPayload } = await import("./payloads");
    const payload = await industryPayload("energy");
    expect((payload as { sector: { slug: string } })?.sector.slug).toBe("energy");
  });

  it("reports when an export is present at all", async () => {
    withExport({ "data/meta.json": { generated_at: "2026-08-23T00:00:00Z" } });
    const { exportExists, exportedAt } = await import("./payloads");
    expect(await exportExists()).toBe(true);
    expect(await exportedAt()).toBe("2026-08-23T00:00:00Z");
  });

  it("treats a company missing from a present export as unknown, not as a query", async () => {
    // Every company held by a fund is exported, so absence is the answer. Asking
    // the database would open a connection to be told the same thing.
    withExport({ "data/meta.json": { generated_at: "x" } });
    const { companyPayload } = await import("./payloads");
    expect(await companyPayload("NOTHELD")).toBeNull();
  });

  it("has no export when the directory is empty", async () => {
    withExport({});
    const { exportExists } = await import("./payloads");
    expect(await exportExists()).toBe(false);
  });
});
