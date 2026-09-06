/**
 * C29 - what an assistive technology perceives on IndustryScope.
 *
 * lib/a11y.test.ts is a source-text tripwire by its own admission: it regexes
 * component files in a node environment because there was no browser in this
 * suite. This file adds the browser, and asks the questions a regex cannot:
 *
 *   1. Key tasks driven through the ACCESSIBILITY TREE - role, accessible
 *      name, value and state as Chromium computes them.
 *   2. Live regions: whether changing the date range, which silently recomputes
 *      eight panels, produces an announcement at all.
 *   3. CHART ALTERNATIVES: for every chart, the text a non-visual user actually
 *      receives, printed verbatim, so a reader can judge whether it carries the
 *      same information as the picture.
 *   4. axe-core, reporting `incomplete` alongside `violations`.
 *
 * WHAT THIS ESTABLISHES: the roles, names, values and alternative text carried
 * by the accessibility tree, and what axe did and did not manage to check.
 *
 * WHAT IT DOES NOT: no screen reader is run. This cannot show what NVDA, JAWS
 * or VoiceOver speak, in what order, or whether the wording is usable by a
 * person who cannot see the chart. Nothing here is a claim of WCAG conformance.
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const SECTOR = "/industry/technology";

/**
 * Record what the page's live regions would hand to a screen reader.
 *
 * One entry per region per MutationObserver callback, which is one microtask
 * checkpoint and therefore the granularity at which the browser raises a single
 * accessibility notification. Writes in separate React commits stay separate.
 */
async function armRecorder(page: Page) {
  await page.evaluate(() => {
    (window as any).__ann = [];
    const observer = new MutationObserver((records) => {
      const batch = new Map<Element, string>();
      for (const record of records) {
        const node =
          record.target.nodeType === 1
            ? (record.target as Element)
            : record.target.parentElement;
        const host = node?.closest(
          "[aria-live], [role='status'], [role='alert'], [role='log']"
        );
        if (!host) continue;
        const text = (host.textContent ?? "").trim();
        if (!text) continue;
        batch.set(host, text);
      }
      for (const [host, text] of batch) {
        (window as any).__ann.push({
          politeness:
            host.getAttribute("aria-live") ??
            (host.getAttribute("role") === "alert" ? "assertive" : "polite"),
          text,
        });
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

const heard = (page: Page) =>
  page.evaluate(() => (window as any).__ann as { politeness: string; text: string }[]);

/* ── 1. Key tasks through the accessibility tree ───────────────────────── */

test.describe("the accessibility tree for the key tasks", () => {
  test("the home search is a named control and its results are reachable", async ({ page }) => {
    await page.goto("/");
    const search = page.getByRole("textbox", { name: "Search industries" });
    await expect(search).toHaveCount(1);

    await search.fill("tech");
    const links = page.locator(".sector-card");
    await expect(links.first()).toBeVisible();
    const named = await links.evaluateAll((els) =>
      els.slice(0, 3).map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 70))
    );
    // eslint-disable-next-line no-console
    console.log("\n[aria tree] home search results\n  " + named.join("\n  "));
    expect(named.length).toBeGreaterThan(0);
  });

  test("the date-range group exposes its presets as a pressed/unpressed set", async ({ page }) => {
    await page.goto(SECTOR);
    const group = page.getByRole("group", { name: "Date range" });
    await expect(group).toHaveCount(1);

    const snapshot = await group.ariaSnapshot();
    // eslint-disable-next-line no-console
    console.log("\n[aria tree] date-range group\n" + snapshot);

    // Exactly one preset reads as the current one, or a screen-reader user
    // cannot tell which window they are looking at.
    const pressed = await group
      .getByRole("button")
      .evaluateAll((els) =>
        els
          .filter((el) => el.getAttribute("aria-pressed") === "true")
          .map((el) => (el.textContent ?? "").trim())
      );
    expect(pressed).toHaveLength(1);

    await group.getByRole("button", { name: "3Y" }).click();
    const after = await group
      .getByRole("button")
      .evaluateAll((els) =>
        els
          .filter((el) => el.getAttribute("aria-pressed") === "true")
          .map((el) => (el.textContent ?? "").trim())
      );
    expect(after).toEqual(["3Y"]);
  });

  test("the comps table announces its sort state", async ({ page }) => {
    await page.goto(SECTOR);
    const header = page.locator("th[aria-sort]").first();
    await expect(header).toHaveCount(1);
    const before = await header.getAttribute("aria-sort");
    await header.getByRole("button").click();
    const after = await header.getAttribute("aria-sort");
    // eslint-disable-next-line no-console
    console.log(`\n[aria tree] comps sort: aria-sort "${before}" -> "${after}"`);
    expect(["ascending", "descending", "none"]).toContain(after);
    expect(after).not.toBe(before);
  });

  test("no focusable control computes to an empty accessible name", async ({ page }) => {
    await page.goto(SECTOR);
    const unnamed = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>(
          'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex="0"]'
        )
      )) {
        if (el.closest("[aria-hidden='true']")) continue;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const labelled = el.getAttribute("aria-labelledby");
        const fromIds = labelled
          ? labelled
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ")
          : "";
        const name = (
          el.getAttribute("aria-label") ||
          fromIds ||
          ((el as HTMLInputElement).labels
            ? Array.from((el as HTMLInputElement).labels!)
                .map((l) => l.textContent)
                .join(" ")
            : "") ||
          el.textContent ||
          el.getAttribute("title") ||
          ""
        ).trim();
        if (!name) out.push(`${el.tagName.toLowerCase()}.${el.className || "?"}`);
      }
      return out;
    });
    expect(unnamed, "controls a screen reader would announce as unlabelled").toEqual([]);
  });
});

/* ── 2. Chart alternatives ─────────────────────────────────────────────── */

test.describe("every chart has a non-visual equivalent", () => {
  test("the sector dashboard's charts each carry an alternative, printed here", async ({
    page,
  }) => {
    await page.goto(SECTOR);
    await page.waitForLoadState("networkidle");
    // recharts' ResponsiveContainer renders nothing until it has measured its
    // box, which happens a frame after networkidle. Without this wait the page
    // looks chartless and the test passes for the wrong reason.
    await page.waitForSelector(".recharts-wrapper svg", { state: "attached" });

    const { charts, legendIcons } = await page.evaluate(() => {
      // recharts puts the chart component's role/aria-label on the wrapper
      // div, and separately gives every legend swatch its own
      // role="img" aria-label="X legend icon". The swatches are chrome, not
      // data, so they are counted but kept out of the chart list.
      const all = Array.from(document.querySelectorAll<HTMLElement>("[role='img']"));
      const surfaces = all.filter((el) => !el.closest(".recharts-legend-wrapper"));
      // The swatches carry an aria-label but no role, so they are named nodes
      // in the tree without being role="img"; they have to be found separately.
      const legend = Array.from(
        document.querySelectorAll<HTMLElement>("svg[aria-label]")
      ).filter((el) => /legend icon$/.test(el.getAttribute("aria-label") ?? ""));

      const out: {
        heading: string;
        alternative: string;
        hidden: boolean;
        table: string | null;
      }[] = [];
      for (const surface of surfaces) {
        const shell =
          surface.closest(".chart-shell") ??
          surface.closest("figure") ??
          surface.closest("section");
        const heading =
          shell?.querySelector("h2, h3, h4, figcaption")?.textContent?.trim() ?? "(no heading)";
        // The tabular alternative, if the chart has one.
        const details = shell?.querySelector("details");
        const table = details
          ? `"${details.querySelector("summary")?.textContent?.trim()}" -> caption ` +
            `"${details.querySelector("caption")?.textContent?.trim() ?? "(none)"}" ` +
            `[${details.querySelectorAll("thead th").length} cols x ` +
            `${details.querySelectorAll("tbody tr").length} rows]`
          : null;
        out.push({
          heading,
          alternative: (surface.getAttribute("aria-label") ?? "").trim(),
          hidden:
            surface.getAttribute("aria-hidden") === "true" ||
            !!surface.closest("[aria-hidden='true']"),
          table,
        });
      }
      return {
        charts: out,
        legendIcons: legend.map((el) => (el.getAttribute("aria-label") ?? "").trim()),
      };
    });

    // eslint-disable-next-line no-console
    console.log(`\n[chart alternatives] ${SECTOR} - ${charts.length} chart(s)`);
    for (const c of charts) {
      // eslint-disable-next-line no-console
      console.log(
        `\n  ${c.heading}` +
          (c.hidden
            ? "\n    marked decorative (aria-hidden), the numbers are in the surrounding text"
            : `\n    announced as: "${c.alternative}"`) +
          (c.table ? `\n    table       : ${c.table}` : "\n    table       : none")
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `\n  [tree noise] recharts also exposes ${legendIcons.length} legend swatches as ` +
        `role="img": ${JSON.stringify(legendIcons.slice(0, 4))}${legendIcons.length > 4 ? " ..." : ""}` +
        `\n  Each duplicates the legend text beside it, so a screen reader reads the ` +
        `series name twice. Not a violation; it is verbosity recharts adds.`
    );

    expect(charts.length, "the dashboard should render charts to check").toBeGreaterThan(3);
    const silent = charts.filter((c) => !c.hidden && c.alternative.length === 0);
    expect(
      silent.map((c) => c.heading),
      "charts that are neither decorative nor described"
    ).toEqual([]);
    // A description that only names the chart type tells a non-visual reader
    // nothing about the data.
    const thin = charts.filter((c) => !c.hidden && c.alternative.length < 40);
    expect(
      thin.map((c) => `${c.heading}: ${c.alternative}`),
      "descriptions too short to convey the data"
    ).toEqual([]);
  });

  test("a macro series without a table states its endpoints and extremes", async ({ page }) => {
    await page.goto(SECTOR);
    await page.waitForLoadState("networkidle");
    await page.waitForSelector(".recharts-wrapper svg", { state: "attached" });
    const macro = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[role='img'][aria-label]"))
        .map((el) => el.getAttribute("aria-label") ?? "")
        .filter((label) => /observation/.test(label))
    );
    // eslint-disable-next-line no-console
    console.log("\n[chart alternative] macro series descriptions");
    for (const m of macro) console.log(`  "${m}"`);

    expect(macro.length, "at least one macro series should be on the page").toBeGreaterThan(0);
    for (const label of macro) {
      // The four facts a sighted reader takes from the line: where it starts,
      // where it ends, how many points, and the range.
      expect(label).toMatch(/From .+ on .+ to .+ on .+/);
      expect(label).toMatch(/\d+ observations?/);
      expect(label).toMatch(/Lowest .+, highest .+/);
    }
  });

  test("the company page's yearly-return bars have a real table beside them", async ({ page }) => {
    await page.goto("/company/AAPL");
    await page.waitForLoadState("networkidle");
    await page.waitForSelector(".recharts-wrapper svg", { state: "attached" });
    const details = page.locator("details").filter({ hasText: "Show the numbers" });
    await expect(details.first()).toHaveCount(1);
    await details.first().locator("summary").click();

    const caption = (await details.first().locator("caption").textContent())?.trim();
    const columns = await details.first().locator("thead th").allTextContents();
    const firstRow = await details.first().locator("tbody tr").first().allTextContents();
    // eslint-disable-next-line no-console
    console.log(
      `\n[chart alternative] company yearly returns` +
        `\n  summary : "Show the numbers"` +
        `\n  caption : "${caption}"` +
        `\n  columns : ${JSON.stringify(columns)}` +
        `\n  row 1   : ${JSON.stringify(firstRow)}`
    );
    expect(caption && caption.length > 0).toBe(true);
    expect(columns.length).toBeGreaterThan(1);
    // A row header on the first cell, so a screen reader can say which year a
    // number belongs to while reading across.
    await expect(details.first().locator("tbody th[scope='row']").first()).toHaveCount(1);
  });

  test("the overlap matrix is a table with both axes labelled", async ({ page }) => {
    // The matrix only renders where two funds both have a holdings snapshot;
    // the technology export only carries one, so use a sector that has three.
    await page.goto("/industry/energy");
    await page.waitForLoadState("networkidle");
    // Peers are opt-in through the chips above the growth chart.
    const chips = page.locator(".peer-chips button");
    const count = await chips.count();
    for (let i = 0; i < count; i++) {
      const chip = chips.nth(i);
      if ((await chip.getAttribute("aria-pressed")) !== "true") await chip.click();
    }
    const table = page.locator("table.overlap-table");
    await expect(table, "adding every peer should produce the overlap matrix").toHaveCount(1);
    const caption = (await table.locator("caption").first().textContent())?.trim();
    const colHeaders = await table.locator("th[scope='col']").allTextContents();
    const rowHeaders = await table.locator("th[scope='row']").allTextContents();
    const cells = (await table.locator("tbody td").allTextContents()).map((t) => t.trim());
    const firstCell = cells[0];
    // The diagonal reads "Self"; the number is in the off-diagonal cells.
    const offDiagonal = cells.find((t) => t !== "Self");
    // eslint-disable-next-line no-console
    console.log(
      `\n[chart alternative] holdings overlap matrix` +
        `\n  caption : "${caption}"` +
        `\n  columns : ${JSON.stringify(colHeaders)}` +
        `\n  rows    : ${JSON.stringify(rowHeaders)}` +
        `\n  cell 1,1: "${firstCell}" (the diagonal is a self-comparison)` +
        `\n  first off-diagonal cell: "${offDiagonal}"`
    );
    expect(colHeaders.length).toBeGreaterThan(0);
    expect(rowHeaders.length).toBeGreaterThan(0);
    // The shading is a second encoding of a number that is written in the cell,
    // so the number must be there.
    expect(offDiagonal, "the shading must be redundant with a written number").toMatch(/\d/);
  });
});

/* ── 3. Live regions ───────────────────────────────────────────────────── */

test.describe("status changes are announced", () => {
  test("changing the date range announces the new window", async ({ page }) => {
    await page.goto(SECTOR);
    await page.waitForLoadState("networkidle");

    const group = page.getByRole("group", { name: "Date range" });
    // Pick a preset that is not the one already selected, or setPreset is a
    // no-op, React never re-renders and the test would "prove" silence.
    const current = await group
      .getByRole("button")
      .evaluateAll((els) =>
        els.find((el) => el.getAttribute("aria-pressed") === "true")?.textContent?.trim()
      );
    const target = ["1Y", "5Y", "10Y"].find((value) => value !== current)!;

    await armRecorder(page);
    await group.getByRole("button", { name: target, exact: true }).click();
    await page.waitForTimeout(600);

    const announcements = await heard(page);
    // eslint-disable-next-line no-console
    console.log(
      `\n[announced] switching the date range ${current} -> ${target}\n  ` +
        JSON.stringify(announcements)
    );

    // One control silently recomputes every panel on the page. Without a status
    // message a screen-reader user gets no signal that anything happened at
    // all: WCAG 2.1 SC 4.1.3.
    expect(announcements.length, "changing the range must announce something").toBeGreaterThan(0);
    expect(announcements.at(-1)!.politeness).toBe("polite");
    expect(announcements.at(-1)!.text).toContain(`Showing ${target}`);
    // The window itself, not just its label: "5Y" alone does not say which
    // dates the charts now cover.
    expect(announcements.at(-1)!.text).toMatch(/\w{3} \d{1,2}, \d{4} to \w{3} \d{1,2}, \d{4}/);
    // Announced once per change, not once per panel that re-rendered.
    expect(announcements).toHaveLength(1);
  });

  test("an idle page announces nothing (control)", async ({ page }) => {
    await page.goto(SECTOR);
    await page.waitForLoadState("networkidle");
    await armRecorder(page);
    await page.waitForTimeout(500);
    expect(await heard(page)).toEqual([]);
  });
});

/* ── 4. axe, with the incomplete count ─────────────────────────────────── */

test.describe("axe result completeness", () => {
  test("the scan reports how much it could not check", async ({ page }) => {
    const rows: Record<string, unknown>[] = [];
    for (const [name, url] of [
      ["home", "/"],
      ["sector dashboard", SECTOR],
      ["company", "/company/AAPL"],
      ["methodology", "/methodology"],
    ] as const) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      rows.push({
        page: name,
        violations: result.violations.length,
        violationRules:
          result.violations.map((v) => `${v.id}(${v.impact}):${v.nodes.length}`).join(", ") || "-",
        incomplete: result.incomplete.length,
        incompleteNodes: result.incomplete.reduce((n, r) => n + r.nodes.length, 0),
        incompleteRules: result.incomplete.map((r) => `${r.id}:${r.nodes.length}`).join(", ") || "-",
        passes: result.passes.length,
      });
    }
    // eslint-disable-next-line no-console
    console.log("\n[axe] violations AND incomplete\n" + JSON.stringify(rows, null, 2));

    // `incomplete` is deliberately not asserted to zero: a rule that returns
    // incomplete declined to decide, and reporting only violations would turn
    // that into a green tick. It is recorded so a reader can see how much of
    // each page the tool actually judged.
    expect(rows.map((r) => `${r.page}:${r.violations}`)).toEqual(rows.map((r) => `${r.page}:0`));
  });
});
