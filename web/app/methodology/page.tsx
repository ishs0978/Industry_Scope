import type { Metadata } from "next";

export const metadata: Metadata = { title: "Methodology" };

export default function MethodologyPage() {
  return <main className="methodology">
    <div className="eyebrow">Methods and limits</div>
    <h1>How IndustryScope works.</h1>

    <p className="lede">Every number on this site comes from a public source, is stored before it is
    shown, and is calculated with a formula written below. Nothing is estimated, forecast, or filled
    in. When a source fails, the panel says so instead of showing a plausible number.</p>

        <section className="method-block">
      <h2>How the data moves</h2>
      <div className="method-body">
<p>Collection and presentation are separate. A scheduled Python job calls each source on its own
    cadence, writes what it gets to PostgreSQL, and records whether the attempt succeeded. The website
    reads only PostgreSQL. It never calls a market, government, or news API while you are looking at a
    page, so a source going down changes what is labeled stale, not what loads.</p>
    <p>A failed download never overwrites good data. The previous value stays, and the panel is marked
    with the date it was collected. Each chart shows two dates: the latest observation in the series,
    and when the job last ran. Those answer different questions and are never merged.</p>
      </div>
    </section>

    <section className="method-block">
      <h2>Where each number comes from</h2>
      <div className="method-body">
<p>Sources publish on their own schedules. The job runs daily, but that does not make every
    number daily. This table is the honest version.</p>

    <div className="data-table-wrap">
      <table>
        <thead><tr><th>Source</th><th>What it provides</th><th>How often it changes</th></tr></thead>
        <tbody>
          <tr><td>Yahoo Finance</td><td>Daily prices, adjusted close, volume, fund assets, expense ratios</td><td>Each trading day after the US close</td></tr>
          <tr><td>State Street</td><td>Fund holdings and weights</td><td>Daily. Implemented for State Street funds only</td></tr>
          <tr><td>SEC XBRL</td><td>Company revenue, margins, assets</td><td>Whenever a company files, not on a schedule</td></tr>
          <tr><td>SEC Form D</td><td>Private fundraising filings</td><td>Whenever a company files</td></tr>
          <tr><td>FRED</td><td>Interest rates and macro series</td><td>Varies by series. Each chart shows its own release date</td></tr>
          <tr><td>EIA</td><td>Petroleum inventories, refinery utilization</td><td>Weekly to monthly. Energy pages only</td></tr>
          <tr><td>BLS</td><td>Industry payrolls and hourly earnings</td><td>Monthly. First estimates are revised in each of the next two months</td></tr>
          <tr><td>GDELT</td><td>News article counts and tone</td><td>Continuous</td></tr>
          <tr><td>NYT Archive</td><td>Headlines, abstracts, links</td><td>Monthly, once a month has completed</td></tr>
        </tbody>
      </table>
    </div>

    <p>BLS figures shown are the most recent published values, including revisions. A number you saw
    last month may have changed because BLS revised it, not because this site changed.</p>
      </div>
    </section>

    <section className="method-block">
      <h2>How returns are calculated</h2>
      <div className="method-body">
<p><strong>All returns on this site are total returns.</strong> They assume dividends were
    reinvested on the day they were paid. A utilities fund yielding 3% will therefore show a higher
    return here than a price chart on a broker site, and both are correct for what they measure.</p>

    <p>The one number that is not a return is the closing price shown on each card and in the sector
    header. That is the fund&rsquo;s last traded close, not a dividend-adjusted figure, so it matches
    what a broker shows. This is also why the day change on that line will not equal the return
    measured over the same day on an ex-dividend date.</p>
    <p>The 52-week range is built from those same closing prices. A broker usually quotes the range
    from intraday highs and lows, which are wider, so the range here will sit slightly inside the one
    on a quote page.</p>
    <p>Total return can differ from another site&rsquo;s figure for the same fund by a few hundredths
    of a point, because providers do not all reinvest a dividend on the same day or at the same price.
    The arithmetic behind every number here is written above.</p>

    <figure className="diagram">
      <svg viewBox="0 0 900 170" role="img" aria-labelledby="ytd-title ytd-desc">
        <title id="ytd-title">Where year to date is measured from</title>
        <desc id="ytd-desc">Year to date is measured from the final close of the prior year, so the first trading day of January is inside the return rather than being used as the baseline.</desc>
        <g fontSize="13" fontFamily="Inter, system-ui, sans-serif">
          <path d="M60 96 H840" stroke="#d8ddd5" strokeWidth="2"/>
          <circle cx="150" cy="96" r="6" fill="#1d6b4d"/>
          <text x="150" y="76" textAnchor="middle" fontWeight="600" fill="#1d6b4d">31 Dec</text>
          <text x="150" y="128" textAnchor="middle" fontSize="12" fill="#647269">baseline used here</text>
          <circle cx="300" cy="96" r="6" fill="#a4463f"/>
          <text x="300" y="76" textAnchor="middle" fill="#a4463f">2 Jan</text>
          <text x="300" y="128" textAnchor="middle" fontSize="12" fill="#a4463f">the common mistake</text>
          <circle cx="800" cy="96" r="6" fill="#17221d"/>
          <text x="800" y="76" textAnchor="middle" fill="#17221d">today</text>
          <path d="M150 148 H800" stroke="#1d6b4d" strokeWidth="1.5" markerEnd="url(#mk3)"/>
          <text x="470" y="166" textAnchor="middle" fontSize="12" fill="#1d6b4d">the whole year&rsquo;s move, including 2 January</text>
          <defs><marker id="mk3" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#1d6b4d"/></marker></defs>
        </g>
      </svg>
      <figcaption>Starting on 1 January silently discards the first trading day from every fund.</figcaption>
    </figure>

    <ul>
      <li><strong>Return over a period</strong> is the ending adjusted close divided by the beginning
      adjusted close, minus one.</li>

      <li><strong>Year to date</strong> is measured from the last close of the prior year, not from
      January 1. The first trading day of the year is part of the year&rsquo;s return.</li>

      <li><strong>Value of $100 invested</strong> applies that same ratio to a starting balance. It
      shows what the math produces. It is not a record of a real investment, a recommendation, or a
      prediction.</li>

      <li><strong>Calendar year returns</strong> use the same prices and boundaries. Each day&rsquo;s
      return counts toward the year it ends in, so multiplying every year in the table reproduces the
      total shown above it. Partial years are labeled with their actual start and end dates.</li>

      <li><strong>Annualized return</strong> converts total return to a yearly rate using elapsed
      calendar days and 365.25 days per year.</li>

      <li><strong>Volatility</strong> is the standard deviation of daily returns, multiplied by the
      square root of 252 to express it as an annual figure. Higher means the fund moved around more
      day to day.</li>

      <li><strong>Sharpe ratio</strong> subtracts the 3-month Treasury yield from each day&rsquo;s
      return, then divides the average of what is left by the standard deviation of that same excess
      series, annualized. It asks how much return you got for the amount of bouncing around you sat
      through.</li>

      <li><strong>Beta</strong> compares the fund&rsquo;s daily moves with SPY&rsquo;s. One means it
      moved with the market. Above one means it amplified the market. Only dates where both traded are
      used.</li>

      <li><strong>Maximum drawdown</strong> is the largest fall from a previous high. The panel names
      the peak date, the low date, whether it recovered, and how long that took.</li>

      <li><strong>Holdings overlap</strong> adds up the smaller of the two weights for every stock two
      funds share. A fund compared with itself is always 100%, which is why the diagonal reads Self.</li>

      <li><strong>HHI</strong> squares each holding&rsquo;s weight and adds them up, on the standard 0
      to 10,000 scale. A fund holding one stock scores 10,000. A fund holding 100 equal stocks scores
      100. Higher means more concentrated.</li>
    </ul>
      </div>
    </section>

    <section className="method-block">
      <h2>Company fundamentals</h2>
      <div className="method-body">
<p>Company figures come from the SEC&rsquo;s XBRL Company Facts and Frames endpoints, requested
    with the descriptive user agent the SEC requires and below their rate limit.</p>
    <p>Filers do not all use the same tags for the same idea. Where a company reports revenue under
    more than one tag, the same tag is used on both sides of any growth comparison. If the earlier
    period does not carry that tag, the cell is left blank. A missing tag stays blank and is never
    read as zero.</p>
    <p>Market capitalization is the current value. It is not aligned to the date range you selected,
    and the column says so.</p>
      </div>
    </section>

    <section className="method-block">
      <h2>Private fundraising</h2>
      <div className="method-body">
<p>Form D filings come from EDGAR full indexes and the primary XML submission. Dollar amounts are
    shown only where the company reported one; many do not.</p>
    <p>Companies amend Form D filings, and an amendment restates the cumulative amount raised rather
    than a new increment. Dollar totals therefore count only the most recent filing for each offering.
    Filing counts include amendments and are labeled that way.</p>
    <p>Sector assignment uses the industry the issuer selects on the form itself. EDGAR leaves its own
    SIC field blank for most private issuers, so that field alone left the great majority of filings
    attributed to nothing; the filer&rsquo;s own answer is both better populated and closer to the
    truth. Where a filing carries no industry, the SIC code is used as a fallback, resolved to the
    sector claiming the longest matching prefix, and no two sectors may claim the same prefix.</p>
    <p>Issuers that describe themselves as pooled investment funds are deliberately left unassigned. A
    fund raising capital is not an operating industry, and counting one would overstate whichever
    sector it landed in. Those filings are the majority of all Form D submissions, so the counts and
    dollar figures on a sector page describe a minority of filings by design, not a collection gap.</p>
      </div>
    </section>

    <section className="method-block">
      <h2>News and events</h2>
      <div className="method-body">
<p>The NYT Archive API supplies headline, abstract, publication date, section, and a link. Full
    article text is neither requested nor stored. GDELT supplies daily article counts and average tone
    as numbers, not text.</p>
    <p>Event annotations are written by hand into a reviewable file in the repository, are checked
    against a primary source before they are added, and are displayed word for word. An event with no
    description is not displayed at all. Each one states what happened and how it reached this
    particular industry. None of them says what a price did.</p>
    <p>Selecting an event shows the sector&rsquo;s return, the S&amp;P 500&rsquo;s return, and the
    difference over that window. Those are arithmetic over dates you can see. Returns over an event
    window are coincident, not causal, and the panel says so. IndustryScope does not generate
    market commentary and does not explain why a price moved.</p>
      </div>
    </section>

    <section className="method-block">
      <h2>What the summaries are</h2>
      <div className="method-body">
<p>The plain-language lines on each dashboard are built from the rows on that dashboard and the
    formulas above. They contain no analyst opinion, no forecast, and no third-party narrative.</p>
      </div>
    </section>

    <section className="method-block">
      <h2>Known limits</h2>
      <div className="method-body">
<ul>
      <li>An ETF is not an industry. Funds are built by their issuers to different definitions, so two
      funds covering the same theme will hold different companies.</li>
      <li>Some funds appear inside others. Semiconductor, software, cybersecurity and AI funds all hold
      companies that also sit in the broad technology fund. Comparing them is useful; adding them is not.</li>
      <li>Adjusted closes are refreshed for a trailing window on each run, so rows older than that
      window may sit on the adjustment basis they were first written with. Yahoo restates adjusted
      close across the whole history whenever a dividend is paid. This does not affect year-to-date,
      and it can affect multi-year returns, annualized return and drawdown. A full-history refresh
      exists and is run on demand rather than on every schedule.</li>
      <li>Holdings feeds are implemented for State Street funds. Other issuers are marked unsupported
      rather than approximated, so composition panels are unavailable for those funds.</li>
      <li>XBRL tags vary between filers, so some fundamental cells will be blank for some companies.
      Growth is left blank rather than computed across two different tags or against a guessed prior
      period.</li>
      <li>Form D sector mapping depends on SIC metadata and is approximate. SIC 7372 covers prepackaged
      software generally and resolves to Software &amp; Cloud, so genuinely cybersecurity-focused
      issuers filing under it are counted there.</li>
      <li>Form D amendments are collected from the current quarter&rsquo;s index onward, so an offering
      amended in an earlier quarter may still show its original reported amount.</li>
      <li>News keyword matching produces false positives and misses relevant coverage. The stories that
      move a whole sector are often the ones least likely to contain a sector keyword.</li>
      <li>The NYT Archive API publishes only completed months, so there is a gap of up to a month at
      the front that will never fill.</li>
      <li>Gold is a commodity, not an operating industry. That sector leads with the miners, which are
      operating companies, and keeps bullion alongside them for comparison.</li>
      <li>Source failures are shown, not hidden. Old holdings may appear with a dated stale warning.
      A fund that fails validation has its derived numbers suppressed rather than estimated, on the
      site and in the exported workbook alike.</li>
    </ul>
      </div>
    </section>

    <section className="method-block">
      <h2>Verification</h2>
      <div className="method-body">
<p>Fund identity, current quote, assets, expense ratio, and holdings are spot-checked against
    StockAnalysis. Assets and expense ratio are keyed to the composition tab shown. Yahoo does not
    publish a usable expense ratio for every fund; a figure outside 0.01% to 2.00% is rejected as a
    unit error and reads Unavailable rather than showing a confident 0.00%.</p>
      </div>
    </section>

    <section className="method-block">
      <h2>Changelog</h2>
      <div className="method-body">
<ul>
      <li><strong>August 14, 2026</strong> Year-to-date on the home page was measured from January 1,
      which meant the first trading day of the year was excluded from every sector. Corrected to
      measure from the prior year&rsquo;s final close. All headline figures changed.</li>
      <li><strong>August 14, 2026</strong> Sector sparklines were drawn on an axis starting at zero,
      which flattened every line regardless of the return. Corrected to fit each line to its own range.</li>
      <li><strong>August 14, 2026</strong> Form D amendments were being discarded before they reached
      the database, so an offering that was later amended kept its original reported amount and
      sector totals were understated. Amendments are now collected, and dollar totals count each
      offering once using its most recent filing.</li>
      <li><strong>August 14, 2026</strong> The Sharpe ratio used the volatility of raw returns in the
      denominator instead of the volatility of excess returns. Corrected to use the excess series on
      both sides.</li>
      <li><strong>August 14, 2026</strong> Concentration was reported on a 0 to 1 scale and rounded to
      two decimals, so most funds displayed 0.00. Moved to the standard 0 to 10,000 scale.</li>
      <li><strong>August 14, 2026</strong> Expense ratios sourced from a percentage field were divided
      by 100 a second time, which could show a real fee as 0.00%. Implausible values are now rejected
      and reported as unavailable.</li>
      <li><strong>August 14, 2026</strong> Revenue growth could pair one XBRL revenue tag against a
      different one, or against a prior period chosen by position rather than by fiscal alignment.
      Both now return a blank cell instead of a number.</li>
      <li><strong>August 14, 2026</strong> Technology was missing from the registry despite ten of the
      other eleven GICS sectors being present. Added. Three SIC prefixes were claimed by two sectors
      at once, which sent software filings to cybersecurity and every electric utility filing to clean
      energy; the registry now rejects duplicate claims outright.</li>
      <li><strong>August 14, 2026</strong> Every curated event carried an empty description and the
      newest was dated September 2024. All events were given a sourced two-sentence description,
      entries through June 2026 were added, and the collector now raises an alarm when the newest
      event is more than 90 days old.</li>
      <li><strong>August 15, 2026</strong> A fact-check against the deployed site found this page
      still describing Form D sector assignment as SIC-based after the code moved to the issuer&rsquo;s
      own industry selection. Corrected, and the exclusion of pooled investment funds is now stated.
      The margins panel showed &ldquo;data through unavailable&rdquo; because it was handed a fiscal
      period where a date belonged, source failures printed their Python exception class to the
      reader, and a day change signed its dollar half but not its percent half. All corrected.</li>
      <li><strong>August 12, 2026</strong> A verification pass found the calendar table omitted the
      prior year-end boundary. On stored prices, corrected full-year results are SMH 39.10% and SOXX
      12.92% for 2024, and GLD 63.68%, GDX 154.77% and SIL 166.16% for 2025. The gap between miners
      and bullion remains after correction.</li>
      <li><strong>August 12, 2026</strong> Isolated missing trading sessions were found in stored
      prices. Collection now re-fetches a trailing window each run so gaps are repaired. Missing
      values are never interpolated.</li>
    </ul>
      </div>
    </section>

  </main>;
}
