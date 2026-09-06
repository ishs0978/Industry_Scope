import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards for the accessibility defects an axe-core run found on the rendered
 * pages, kept here because there is no browser in this test suite.
 *
 * These are two different kinds of check and only one of them is a real test.
 * The contrast block computes WCAG ratios from the palette and would have
 * caught the failures on its own. The markup block reads source text, which
 * catches a regression written the same way the code is written today and
 * nothing else; it is a tripwire, not a proof. Neither replaces running axe
 * against the built site, which is what found these in the first place.
 */

const web = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(web, relative), "utf8");

const CHART_COMPONENTS = [
  "components/IndustryDashboard.tsx",
  "components/HomeExplorer.tsx",
  "components/CompanyDetail.tsx",
  "components/EtfDetail.tsx",
];

function channel(value: number) {
  const ratio = value / 255;
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  const [red, green, blue] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

export function contrast(foreground: string, background: string) {
  const [first, second] = [luminance(foreground), luminance(background)];
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function token(name: string) {
  const match = read("app/globals.css").match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!match) throw new Error(`--${name} is not defined in globals.css`);
  return match[1];
}

describe("palette contrast", () => {
  // axe measured --amber at 3.25 against paper and --muted at 4.28 against the
  // event card, on 11px text. Both are body text, so both need 4.5.
  it.each([
    ["--muted", "muted", "--paper", () => token("paper")],
    ["--muted", "muted", "--panel", () => token("panel")],
    ["--muted", "muted", "the event card", () => "#e8eee7"],
    ["--amber", "amber", "--paper", () => token("paper")],
    ["--amber", "amber", "--panel", () => token("panel")],
  ])("%s clears 4.5:1 on %s", (_label, name, _on, background) => {
    expect(contrast(token(name), background())).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the overlap shading light enough for the text on top of it", () => {
    // The diagonal cells were white on 78% green, which is 4.02:1, and dark text
    // on the same fill is 4.08:1 - there is no readable colour at that opacity.
    const source = read("components/IndustryDashboard.tsx");
    const ramp = source.match(/rgba\(29,107,77,\$\{\(([\d.]+) \+ Math\.min\(value, 1\) \* ([\d.]+)\)/);
    expect(ramp, "the overlap shading ramp moved; re-check the contrast").not.toBeNull();
    const heaviest = Number(ramp![1]) + Number(ramp![2]);
    const blended = [29, 107, 77].map((value, index) =>
      Math.round(value * heaviest + [251, 250, 246][index] * (1 - heaviest)));
    const hex = `#${blended.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    expect(contrast(token("ink"), hex)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("chart and control markup", () => {
  it("gives every chart an accessible name, or hides it as decoration", () => {
    // recharts sets role="application" and tabIndex 0 on every chart it draws.
    // Unnamed, that is a tab stop that announces nothing, once per chart.
    for (const file of CHART_COMPONENTS) {
      const charts = read(file).match(/<(?:Line|Area|Bar|Composed)Chart[^>]*>/g) ?? [];
      expect(charts.length, `${file} has no charts; the pattern moved`).toBeGreaterThan(0);
      for (const chart of charts) {
        expect(
          /aria-label=/.test(chart) || /aria-hidden=\{true\}/.test(chart),
          `${file}: ${chart.slice(0, 60)} has no accessible name`,
        ).toBe(true);
      }
    }
  });

  it("keeps a decorative chart out of the tab order as well as out of the tree", () => {
    // aria-hidden on something still focusable is its own violation.
    const sparkline = read("components/HomeExplorer.tsx").match(/<LineChart[^>]*>/)![0];
    expect(sparkline).toContain("aria-hidden={true}");
    expect(sparkline).toContain("tabIndex={-1}");
  });

  it("names every select", () => {
    for (const file of CHART_COMPONENTS) {
      for (const element of read(file).match(/<select[^>]*>/g) ?? []) {
        expect(/aria-label=|aria-labelledby=|id=/.test(element), `${file}: ${element}`).toBe(true);
      }
    }
  });

  it("leaves no aria-label on an element with no role to carry it", () => {
    // A bare div takes no accessible name, so the label is dropped in silence.
    for (const file of CHART_COMPONENTS) {
      for (const element of read(file).match(/<div[^>]*aria-label=[^>]*>/g) ?? []) {
        expect(/role=/.test(element), `${file}: ${element.slice(0, 90)}`).toBe(true);
      }
    }
  });

  it("makes every scrolling table reachable from the keyboard", () => {
    for (const file of [...CHART_COMPONENTS, "components/DetailUi.tsx", "app/methodology/page.tsx"]) {
      for (const element of read(file).match(/<div className="data-table-wrap"[^>]*>/g) ?? []) {
        expect(element, `${file}: ${element}`).toContain("tabIndex={0}");
      }
    }
  });

  it("puts a real button in every sortable column header", () => {
    // The handler used to sit on the `th`, which no keyboard can reach. The
    // button is what carries Enter and Space; `aria-sort` is what a screen
    // reader reads when it enters the column.
    const source = read("components/IndustryDashboard.tsx");
    expect(source).not.toMatch(/<th[^>]*onClick=/);
    expect(source).toMatch(/<th aria-sort=\{active \? direction : "none"\} scope="col">/);
    expect(source).toMatch(/<button className="sort-header" onClick=\{onSort\} type="button">/);
    // Every sortable column goes through that one header component.
    expect((source.match(/<SortHeader /g) ?? []).length).toBe(2);
  });

  it("gives the sort button a focus style of its own", () => {
    // `th` is a sticky cell on a pale background; without this the focus ring
    // is the browser default drawn over the header colour.
    expect(read("app/globals.css")).toContain(".sort-header:focus-visible { outline: 2px solid var(--green);");
  });

  it("keeps the overlap matrix a table, not a grid of unlabelled cells", () => {
    // Which pair of funds a cell belonged to used to live only in a title
    // attribute, which no keyboard can reach.
    const source = read("components/IndustryDashboard.tsx");
    expect(source).toContain("overlap-table");
    expect(source).not.toContain("overlap-grid");
    expect(source).toMatch(/<th key=\{fund\} scope="col">/);
    expect(source).toMatch(/<th scope="row">\{row\}<\/th>/);
  });
});

/**
 * The eight items the earlier records listed as outstanding. Same two kinds of
 * check as above: where a claim can be computed it is computed, and where it
 * can only be read out of the source it says so. What actually measured these
 * is `.agent-work/a11y-audit.mjs` and `.agent-work/motion-and-target-probe.mjs`
 * against a running browser; these are the tripwires that keep the fixes.
 */

const MAIN_FILES = [
  "components/IndustryDashboard.tsx",
  "components/HomeExplorer.tsx",
  "components/EtfDetail.tsx",
  "components/CompanyDetail.tsx",
  "app/methodology/page.tsx",
];

const TABLE_FILES = [
  "components/IndustryDashboard.tsx",
  "components/DetailUi.tsx",
  "components/EtfDetail.tsx",
  "components/CompanyDetail.tsx",
  "app/methodology/page.tsx",
];

/** Every `<table>` in a file, as the source text between its tags. */
function tablesIn(file: string) {
  return read(file).split(/<table[^>]*>/).slice(1).map((rest) => rest.split("</table>")[0]);
}

describe("page structure", () => {
  it("puts a skip link to the main landmark ahead of the header", () => {
    // Without it the first tab press on every page lands on the wordmark and
    // the only way past the header is to tab through it.
    const layout = read("app/layout.tsx");
    expect(layout).toContain('<a className="skip-link" href="#main-content">');
    expect(
      layout.indexOf('className="skip-link"'),
      "the skip link has to come before the header or it is not the first tab stop",
    ).toBeLessThan(layout.indexOf('className="site-header"'));
    const css = read("app/globals.css");
    expect(css).toContain(".skip-link:focus");
  });

  it("gives every main landmark the id and focus target the skip link needs", () => {
    // Following the link has to move focus, not just the scroll position, and a
    // bare `main` is not focusable.
    for (const file of MAIN_FILES) {
      const mains = read(file).match(/<main[^>]*>/g) ?? [];
      expect(mains.length, `${file} renders no main landmark`).toBeGreaterThan(0);
      for (const element of mains) {
        expect(element, `${file}: ${element}`).toContain('id="main-content"');
        expect(element, `${file}: ${element}`).toContain("tabIndex={-1}");
      }
    }
  });

  it("puts every chart title in the heading outline", () => {
    // 22 chart titles on /industry/energy were styled divs, so a reader
    // navigating by heading met eight section headings and none of the charts.
    const dashboard = read("components/IndustryDashboard.tsx");
    expect(dashboard).toContain('<h3 className="chart-title">{title}</h3>');
    // A title that doubles as the disclosure control is a heading wrapping the
    // button. That nesting is the only valid one: a button's children are
    // presentational, so role="heading" inside it is dropped.
    expect(dashboard).toContain('{asLabel ? toggle : <h3 className="chart-heading-title">{toggle}</h3>}');
    // The one deliberate exception: the two hero stat cells sit above the first
    // h2 and are stat labels, not charts.
    expect((dashboard.match(/<ChartHeading asLabel /g) ?? []).length).toBe(2);
    expect(read("components/DetailUi.tsx")).toContain('<h3 className="chart-title">{title}</h3>');
    for (const file of [...CHART_COMPONENTS, "components/DetailUi.tsx"]) {
      expect(read(file), `${file} still renders a chart title as a plain div`)
        .not.toMatch(/<div className="chart-title"/);
    }
    // The heading element must not repaint the title it wraps.
    expect(read("app/globals.css")).toMatch(/\.chart-heading h3[^{]*\{[^}]*font-size: inherit/);
  });
});

describe("targets, motion and focus", () => {
  it("gives the event markers a target a finger can hit", () => {
    // Measured at 4x14 CSS px against the 24x24 of WCAG 2.5.8. The mark stays
    // 4x14; the button around it grows.
    const css = read("app/globals.css");
    const rule = css.match(/\.event-marker \{([^}]*)\}/);
    expect(rule, "the .event-marker rule moved").not.toBeNull();
    expect(rule![1]).toMatch(/height: 24px/);
    expect(rule![1]).toMatch(/width: 24px/);
    const mark = css.match(/\.event-marker::before \{([^}]*)\}/);
    expect(mark, "the visible tick is not drawn by a pseudo-element").not.toBeNull();
    expect(mark![1]).toMatch(/width: 4px/);
    expect(mark![1]).toMatch(/height: 14px/);
  });

  it("makes a link inside a sentence distinguishable without colour", () => {
    // Every prose link on the site inherited its colour from the paragraph and
    // carried no underline, so colour was not even the distinction: there was
    // none at all.
    const css = read("app/globals.css");
    // One line, so the selector list is what is captured and not the comment
    // above it: [^{}\n] cannot cross a newline.
    const block = css.match(/\n([^{}\n]*)\{ text-decoration: underline;/);
    expect(block, "no prose-link underline rule").not.toBeNull();
    const selectors = block![1].split(",").map((selector) => selector.trim());
    for (const prose of ["p a", "li a", ".event-window a"]) {
      expect(selectors, `${prose} is not underlined`).toContain(prose);
    }
    // Scoped deliberately. Cards, chips, nav items and table cells are whole
    // targets inside their own container rather than runs of text in a
    // sentence, and underlining them would repaint the site to no purpose.
    for (const chrome of ["a", "nav a", ".sector-card a", ".explore-links a", "td a", "th a", ".search-results a"]) {
      expect(selectors, `${chrome} should not be in the prose rule`).not.toContain(chrome);
    }
  });

  it("does not force a smooth scroll on a reader who asked for less motion", () => {
    // scrollIntoView({ behavior: "auto" }) defers to the element's computed
    // scroll-behavior, so an unconditional `html { scroll-behavior: smooth }`
    // silently overrules the prefers-reduced-motion branch in the component.
    const css = read("app/globals.css");
    const htmlRule = css.match(/\nhtml \{([^}]*)\}/);
    expect(htmlRule, "the html rule moved").not.toBeNull();
    expect(htmlRule![1], "smooth scrolling is still unconditional").not.toMatch(/scroll-behavior/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*html \{ scroll-behavior: smooth; \}/);
    // The component branch this protects.
    expect(read("components/IndustryDashboard.tsx"))
      .toContain('behavior: reduced ? "auto" : "smooth"');
  });

  it("gives the dark range bar a focus ring that can be seen against it", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.range-bar button:focus-visible[^{]*\{[^}]*outline: 2px solid var\(--lime\)/);
    // 1.4.11 wants 3:1 for a focus indicator. The app's usual green does not
    // reach it on this background, which is why this control differs, and
    // Chrome's own default is no better.
    expect(contrast(token("lime"), token("ink"))).toBeGreaterThanOrEqual(3);
    expect(contrast(token("green"), token("ink"))).toBeLessThan(3);
  });
});

describe("data tables", () => {
  it("gives every table a caption and a scope on every header cell", () => {
    for (const file of TABLE_FILES) {
      const tables = tablesIn(file);
      expect(tables.length, `${file} has no tables; the pattern moved`).toBeGreaterThan(0);
      tables.forEach((table, index) => {
        expect(
          /<caption className="visually-hidden">/.test(table),
          `${file} table ${index + 1} has no caption`,
        ).toBe(true);
        // `<th[^>]*>` also matches `<thead>`; this does not.
        const headers = table.match(/<th(?:\s[^>]*)?>/g) ?? [];
        expect(headers.length, `${file} table ${index + 1} has no th at all`).toBeGreaterThan(0);
        for (const header of headers) {
          expect(/scope="(col|row)"/.test(header), `${file} table ${index + 1}: ${header}`).toBe(true);
        }
      });
    }
  });

  it("does not leave an explanation reachable only by a mouse hover", () => {
    // A title attribute is not focusable, does not appear on touch, and is
    // announced inconsistently. One helper now owns every one of them and puts
    // the same words in the accessibility tree beside the tooltip.
    const dashboard = read("components/IndustryDashboard.tsx");
    expect(dashboard).toMatch(/function Annotated\(/);
    expect(dashboard).toContain('<span className={className} title={note}>');
    expect(dashboard).toContain('<span className="visually-hidden"> ({note})</span>');
    // Seven annotation sites went through the helper: five in the issuer table,
    // one in the comps quartile rows, and Marked, which every comps row uses.
    expect((dashboard.match(/<Annotated[\s>]/g) ?? []).length).toBeGreaterThanOrEqual(7);
    // Nothing sets a literal title on a plain span or a table cell any more.
    expect(dashboard, "a literal title attribute is back on a span")
      .not.toMatch(/<span[^>]{0,120} title="/);
    expect(dashboard, "a title attribute is back on a table cell")
      .not.toMatch(/<td [^>]*\stitle=/);
    // The event markers said the date in the tooltip and only the headline in
    // the hidden label, so the date was mouse-only too.
    expect(dashboard).toContain('<span className="visually-hidden">{event.start_date} · {event.title}</span>');
    // The home page's fund and company chips said the sector or the company
    // name to a mouse and the ticker to everyone else.
    const home = read("components/HomeExplorer.tsx");
    const chips = home.match(/<Link[^>]*\stitle=[\s\S]*?<\/Link>/g) ?? [];
    expect(chips.length, "the home page chips moved").toBe(2);
    for (const chip of chips) {
      expect(chip, `HomeExplorer: ${chip.slice(0, 80)}`).toContain('className="visually-hidden"');
    }
  });
});
