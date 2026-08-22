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
<figure className="diagram">
  <svg viewBox="0 0 900 250" role="img" aria-labelledby="flow-title flow-desc">
    <title id="flow-title">How data reaches a page</title>
    <desc id="flow-desc">Public sources are read by a scheduled job, which writes to PostgreSQL. The website reads only PostgreSQL, so a source outage never reaches your browser.</desc>
    <g fontSize="13" fontFamily="Inter, system-ui, sans-serif">
      <rect x="6" y="14" width="196" height="212" rx="4" fill="#f8f7f0" stroke="#d8ddd5"/>
      <text x="104" y="38" textAnchor="middle" fontWeight="700" fontSize="10" letterSpacing="1.2" fill="#647269">PUBLIC SOURCES</text>
      <text x="22" y="62" fill="#17221d">Yahoo Finance</text>
      <text x="22" y="84" fill="#17221d">State Street</text>
      <text x="22" y="106" fill="#17221d">SEC XBRL</text>
      <text x="22" y="128" fill="#17221d">SEC Form D</text>
      <text x="22" y="150" fill="#17221d">FRED / EIA / BLS</text>
      <text x="22" y="172" fill="#17221d">GDELT</text>
      <text x="22" y="194" fill="#17221d">NYT Archive</text>
      <path d="M210 120 H286" stroke="#647269" strokeWidth="1.5" markerEnd="url(#mkflow)"/>
      <rect x="292" y="76" width="180" height="88" rx="4" fill="#fff" stroke="#17221d"/>
      <text x="382" y="106" textAnchor="middle" fontWeight="600" fill="#17221d">Scheduled job</text>
      <text x="382" y="126" textAnchor="middle" fontSize="12" fill="#647269">once a day, 06:00 ET</text>
      <text x="382" y="144" textAnchor="middle" fontSize="12" fill="#647269">logs every attempt</text>
      <path d="M480 120 H556" stroke="#647269" strokeWidth="1.5" markerEnd="url(#mkflow)"/>
      <rect x="562" y="76" width="150" height="88" rx="4" fill="#fff" stroke="#17221d"/>
      <text x="637" y="114" textAnchor="middle" fontWeight="600" fill="#17221d">PostgreSQL</text>
      <text x="637" y="136" textAnchor="middle" fontSize="12" fill="#647269">stored, not cached</text>
      <path d="M720 120 H788" stroke="#647269" strokeWidth="1.5" markerEnd="url(#mkflow)"/>
      <rect x="794" y="76" width="100" height="88" rx="4" fill="#1d6b4d"/>
      <text x="844" y="114" textAnchor="middle" fontWeight="600" fill="#ffffff">This page</text>
      <text x="844" y="136" textAnchor="middle" fontSize="12" fill="#cfe6da">reads only ←</text>
      <text x="382" y="196" textAnchor="middle" fontSize="12" fill="#a4463f">A source failing stops here.</text>
      <text x="382" y="214" textAnchor="middle" fontSize="12" fill="#a4463f">The panel is labelled stale; nothing is invented.</text>
      <defs><marker id="mkflow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#647269"/></marker></defs>
    </g>
  </svg>
  <figcaption>The website never calls a market, government or news API while you are looking at a page.</figcaption>
</figure>
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
<p>Form D filings come from the SEC&rsquo;s quarterly Form D data sets, which flatten every filing
    since 2008 into tables. Quarters from 2019 onward are loaded from those files. They publish only
    after a quarter closes, so the quarter in progress is assembled from EDGAR full indexes and each
    filing&rsquo;s primary XML submission, and those interim rows are replaced wholesale when the data
    set for their quarter publishes rather than merged with it. Every sector panel states the date
    range actually held, separately from the range selected, because the two are rarely the same.
    Dollar amounts are shown only where the company reported one; many do not, and a reported zero is
    kept distinct from an amount never given.</p>
<figure className="diagram">
  <svg viewBox="0 0 900 180" role="img" aria-labelledby="amend-title amend-desc">
    <title id="amend-title">How an amended offering is counted</title>
    <desc id="amend-desc">An original Form D and its amendment describe one offering. The amendment restates the cumulative amount raised, so only the most recent filing counts toward dollar totals.</desc>
    <g fontSize="13" fontFamily="Inter, system-ui, sans-serif">
      <rect x="20" y="34" width="180" height="64" rx="4" fill="#fff" stroke="#d8ddd5"/>
      <text x="110" y="58" textAnchor="middle" fontWeight="600" fill="#17221d">Form D</text>
      <text x="110" y="80" textAnchor="middle" fill="#647269">raised $4M</text>
      <path d="M208 66 H268" stroke="#647269" strokeWidth="1.5" markerEnd="url(#mkam)"/>
      <rect x="274" y="34" width="190" height="64" rx="4" fill="#fff" stroke="#d8ddd5"/>
      <text x="369" y="58" textAnchor="middle" fontWeight="600" fill="#17221d">Form D/A</text>
      <text x="369" y="80" textAnchor="middle" fill="#647269">raised $9M to date</text>
      <path d="M472 66 H532" stroke="#647269" strokeWidth="1.5" markerEnd="url(#mkam)"/>
      <rect x="538" y="34" width="200" height="64" rx="4" fill="#f0f5ee" stroke="#1d6b4d"/>
      <text x="638" y="58" textAnchor="middle" fontWeight="600" fill="#1d6b4d">Counted once</text>
      <text x="638" y="80" textAnchor="middle" fill="#17221d">$9M</text>
      <text x="369" y="132" textAnchor="middle" fontSize="12" fill="#647269">An amendment restates the total.</text>
      <text x="369" y="150" textAnchor="middle" fontSize="12" fill="#647269">It does not add to it.</text>
      <text x="638" y="132" textAnchor="middle" fill="#a4463f">Not $13M.</text>
      <defs><marker id="mkam" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#647269"/></marker></defs>
    </g>
  </svg>
  <figcaption>Filing counts still include every filing, and the stat above says so.</figcaption>
</figure>
    <p>Companies amend Form D filings, and an amendment restates the cumulative amount raised rather
    than a new increment. Dollar totals therefore count only the most recent filing for each offering.
    Filing counts include amendments and are labeled that way.</p>
    <p>An offering is identified by the file number EDGAR assigns it, the 021-XXXXXX that stays
    constant across an original and every amendment to it. Where a filing carries no file number the
    chain of superseded accession numbers is used instead. Both rules are applied together, so a group
    still joins when some of its filings carry a file number and others only a chain link. This
    replaced a guess that matched filings on the issuer and the offering size, which merged offerings
    that were merely the same size and missed offerings whose reported size changed.</p>
    <p>An offering is placed in the quarter its original filing was made, not the quarter it was last
    amended, so amending does not move money forward in time. Where the original was filed before the
    data begins, the offering has no known start quarter: it stays in the table, marked, and is left
    out of the quarterly chart, and the panel says how much money that removes. One date is in any
    case a simplification, because raising can run for years after it.</p>
    <p>Four counts are published together and reconcile exactly: filings equals offerings, plus
    filings that restate an offering already counted, less the offerings whose original is missing.
    The subtraction is over offerings rather than filings, because an offering with three amendments
    and no original is one unit of over-count, not three. The panel prints the arithmetic so a reader
    can check it, and says so plainly if it ever fails to hold.</p>
    <p>A Form D can name co-issuers, and the SEC publishes them as separate rows against one filing.
    That filing still reports one amount, once. Issuers are therefore carried as an attribute and a
    count of the filing rather than as rows of their own, and the table shows the primary issuer with
    a marker for the rest. Affiliated companies that each file their own Form D for the same deal are
    a different thing: the SEC gives each its own file number, so they remain separate offerings and
    the reported amounts are not netted against one another.</p>
<figure className="diagram">
  <svg viewBox="0 0 900 250" role="img" aria-labelledby="coiss-title coiss-desc">
    <title id="coiss-title">Co-issuers on one filing against affiliates filing separately</title>
    <desc id="coiss-desc">A single Form D naming three co-issuers reports one amount and is counted once. Three affiliated companies that each file their own Form D receive three file numbers from EDGAR and are counted as three offerings, even when the deal behind them is the same.</desc>
    <g fontSize="13" fontFamily="Inter, system-ui, sans-serif">
      <text x="20" y="22" fontWeight="600" fill="#17221d">One filing naming three issuers</text>
      <rect x="20" y="36" width="200" height="96" rx="4" fill="#fff" stroke="#d8ddd5"/>
      <text x="120" y="58" textAnchor="middle" fontSize="12" fill="#647269">one file number</text>
      <text x="120" y="80" textAnchor="middle" fill="#17221d">Issuer A</text>
      <text x="120" y="98" textAnchor="middle" fill="#17221d">Issuer B</text>
      <text x="120" y="116" textAnchor="middle" fill="#17221d">Issuer C</text>
      <path d="M228 84 H288" stroke="#647269" strokeWidth="1.5" markerEnd="url(#mkco)"/>
      <rect x="294" y="52" width="150" height="64" rx="4" fill="#f0f5ee" stroke="#1d6b4d"/>
      <text x="369" y="76" textAnchor="middle" fontWeight="600" fill="#1d6b4d">One offering</text>
      <text x="369" y="98" textAnchor="middle" fill="#17221d">$295M</text>
      <text x="20" y="160" fontSize="12" fill="#647269">One amount, reported once. Issuer B and C are shown as a marker, not as rows.</text>
      <text x="20" y="182" fontSize="12" fill="#a4463f">Counting one row per issuer would report $885M.</text>

      <line x1="470" y1="10" x2="470" y2="240" stroke="#d8ddd5"/>

      <text x="500" y="22" fontWeight="600" fill="#17221d">Three affiliates each filing their own</text>
      <rect x="500" y="36" width="150" height="30" rx="4" fill="#fff" stroke="#d8ddd5"/>
      <text x="575" y="56" textAnchor="middle" fontSize="12" fill="#17221d">021-594432 · $295M</text>
      <rect x="500" y="72" width="150" height="30" rx="4" fill="#fff" stroke="#d8ddd5"/>
      <text x="575" y="92" textAnchor="middle" fontSize="12" fill="#17221d">021-594436 · $295M</text>
      <rect x="500" y="108" width="150" height="30" rx="4" fill="#fff" stroke="#d8ddd5"/>
      <text x="575" y="128" textAnchor="middle" fontSize="12" fill="#17221d">021-594427 · $295M</text>
      <path d="M658 87 H718" stroke="#647269" strokeWidth="1.5" markerEnd="url(#mkco)"/>
      <rect x="724" y="55" width="150" height="64" rx="4" fill="#f0f5ee" stroke="#1d6b4d"/>
      <text x="799" y="79" textAnchor="middle" fontWeight="600" fill="#1d6b4d">Three offerings</text>
      <text x="799" y="101" textAnchor="middle" fill="#17221d">$295M each</text>
      <text x="500" y="160" fontSize="12" fill="#647269">Three file numbers, so three offerings, even where the deal behind them is one.</text>
      <text x="500" y="182" fontSize="12" fill="#647269">Netting them would need a judgement the filings do not support.</text>
      <defs><marker id="mkco" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#647269"/></marker></defs>
    </g>
  </svg>
  <figcaption>Both shapes appear in the data. The file number decides which is which.</figcaption>
</figure>
    <p>Every offering also records what kind of security it sells. The boxes are not exclusive, so an
    offering selling equity and debt together is counted in full as debt; the form never asks how the
    money divides. Offerings that tick no box are left out of the debt share rather than assumed to be
    equity, and the panel states how much money that leaves unmeasured.</p>
    <p>Sector assignment uses the industry the issuer selects on the form itself. EDGAR leaves its own
    SIC field blank for most private issuers, so that field alone left the great majority of filings
    attributed to nothing; the filer&rsquo;s own answer is both better populated and closer to the
    truth. Where a filing carries no industry, the SIC code is used as a fallback, resolved to the
    sector claiming the longest matching prefix, and no two sectors may claim the same prefix.</p>
    <p>Pooled investment vehicles are excluded on two of the filer&rsquo;s own answers. The first is
    the industry it selected: a fund raising capital is not an operating industry, and choosing that
    category now ends the question rather than falling through to the SIC code, which is how funds
    carrying a bank&rsquo;s SIC used to be counted as banks. The second is the securities-type box, an
    interest in a pooled investment fund, which catches vehicles that pick an operating industry
    instead, such as insurance separate accounts filing under Insurance. Those filings are the
    majority of all Form D submissions, so the counts and dollar figures on a sector page describe a
    minority of filings by design, not a collection gap.</p>
    <p>A third signal excludes nothing. Some issuer names match patterns common among vehicles, such
    as Separate Account, Collective Trust, Income Fund and the limited-partnership suffixes. A name is
    not a statement a filer made about itself, and plenty of operating businesses are limited
    partnerships, so a match is shown as a column in the table and drops no row. Vehicles that satisfy
    none of these tests stay visible rather than being removed on a guess; some large trusts do, and
    they can be seen in the table with the column blank.</p>
    <p>Reported amounts are what the filer typed. The SEC does not verify them, and the data contains
    filings claiming raises far larger than the companies behind them plausibly support. Nothing here
    screens for plausibility, so a single implausible filing can carry a sector total.</p>
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
      <li>Form D sector mapping follows the industry the issuer picks from a fixed list, which is
      coarse: one Other Technology covers everything from a chip designer to a web agency. Where no
      industry is given the SIC code is used, and that is approximate too. SIC 7372 covers prepackaged
      software generally and resolves to Software &amp; Cloud, so genuinely cybersecurity-focused
      issuers filing under it are counted there.</li>
      <li>Form D coverage starts in 2019. An offering whose original was filed before then appears
      only through its later amendments, so its start quarter is unknown and it is kept out of the
      quarterly chart while remaining in the table.</li>
      <li>Form D amounts are unverified self-reports. The SEC does not check them and no plausibility
      screen is applied here, so an implausible filing can dominate a sector total on its own.</li>
      <li>A pooled vehicle that neither picks the pooled industry nor ticks the pooled securities box
      is not excluded. Its name may match the vehicle-name column, which is shown rather than acted
      on, so some funds remain in the sector totals.</li>
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
      <li><strong>August 22, 2026</strong> Headlines came from the NYT Archive alone, which
      publishes a month at a time and only once that month has completed, so coverage was
      structurally weeks behind and, mid-month, closer to seven. GDELT indexes publishers
      continuously and now fills the front of the timeline. It matches whole articles rather than
      headlines, so a query for the energy sector returned a restaurant opening and an index
      round-up; only articles whose headline carries the subject are kept, and each publisher is
      capped so an algorithmic content farm cannot fill a sector on its own.</li>
      <li><strong>August 22, 2026</strong> Two sectors could never receive any news at all. GDELT
      rejects a search phrase shorter than five characters, answering with &ldquo;The specified
      phrase is too short&rdquo; and no results, and one such term fails the entire query. The
      keyword &ldquo;SaaS&rdquo; cost Software &amp; Cloud every article it ever had, and
      &ldquo;REIT&rdquo; did the same to Real Estate. Both keywords remain in the registry, where
      the NYT matcher still uses them; they are now left out of the GDELT query.</li>
      <li><strong>August 22, 2026</strong> Every fund and every company now has its own page. The
      site held daily prices for the fifty funds and nothing at all for the roughly eight hundred
      companies inside them, so a company had no chart and no return history. Weekly closes are now
      collected for all of them, together with valuation multiples and analyst targets. Weekly
      rather than daily is a storage decision: daily bars for that many companies would be about
      330 MB against a 512 MB ceiling, and every question these pages ask is measured in years.</li>
      <li><strong>August 22, 2026</strong> Sector pages now carry curated company groups: the
      Magnificent 7 under Technology, and semiconductors, chip equipment, data centre and power,
      and cloud platforms under AI &amp; Robotics. These could not be derived, because the issuer
      holdings files carry a sub-sector column whose every value is literally a dash. Membership is
      therefore a judgement rather than a fact from a filing, and the panel says so.</li>
      <li><strong>August 22, 2026</strong> Added bond and municipal bond sectors. Neither carries a
      SIC prefix, because a bond fund owns debt rather than issuers and any prefix would have pulled
      unrelated Form D filings and company fundamentals into its totals. The registry previously
      required every sector to declare one.</li>
      <li><strong>August 22, 2026</strong> The private fundraising panel described its contents as
      the selected date range while holding only the current quarter. Form D had been collected from
      the current quarter&rsquo;s EDGAR index alone, so a five-year window was drawn from about three
      weeks of filings and read as a five-year picture. Every quarter from 2019 is now loaded from the
      SEC&rsquo;s quarterly data sets, and the panel states the range actually held separately from
      the range selected.</li>
      <li><strong>August 22, 2026</strong> The filing count and the offering count on the panel could
      not both be true, because nothing tied them together. All four counts are now derived from one
      grouping and reconcile exactly, with the arithmetic printed so a reader can check it. The
      offerings whose original predates the data are subtracted as offerings rather than as filings:
      subtracting the filings understated the total by around one and a half thousand on the banks
      page alone.</li>
      <li><strong>August 22, 2026</strong> Offerings were grouped by matching an issuer against an
      offering size, which merged offerings that were merely the same size and split ones whose
      reported size had changed. Grouping now uses the file number EDGAR assigns and keeps constant
      across amendments. The old guess erred in both directions: it overstated the banks total by
      about $80B and, in energy, merged twenty-two offerings that were genuinely separate.</li>
      <li><strong>August 22, 2026</strong> An offering was dated by its most recent filing, so
      amending moved money into the quarter of the amendment rather than the quarter it was raised in.
      Offerings are now placed in the quarter of their original filing. Where the original predates
      the data the offering has no known quarter and is kept out of the chart, and the panel says how
      much money that removes.</li>
      <li><strong>August 22, 2026</strong> Pooled vehicles were reaching sector totals two ways. A
      filer selecting Pooled Investment Fund had that answer discarded as unmapped and fell through to
      its EDGAR SIC code, so a fund carrying a bank&rsquo;s SIC was counted as a bank. Vehicles that
      instead selected an operating industry, such as insurance separate accounts filing under
      Insurance, were never tested at all. Selecting the pooled industry now ends attribution, and the
      securities-type box for a pooled fund interest excludes on its own. Name patterns were
      considered and deliberately not used to exclude: plenty of operating businesses are limited
      partnerships, so a name match is shown as a column instead. Some large trusts satisfy no
      source-based test and remain in the totals, visible in the table.</li>
      <li><strong>August 22, 2026</strong> Co-issuers named on one filing were silently discarded, so
      a filing naming seven companies showed one and the others appeared nowhere. They are now carried
      as a count against the filing, which still reports one amount once, and the table marks them.
      Dollar totals were checked against this: summing at the issuer level rather than the filing
      level would have overstated the reported total across all filings by about $4 trillion.</li>
      <li><strong>August 22, 2026</strong> The fundraising chart carried the sector ETF&rsquo;s price
      on a second axis, which invited a causal reading the data cannot support and labelled the
      current, incomplete quarter as a quarter-end price. The price series and the right axis are
      gone. Hovering a bar now gives the number of offerings behind it, and below four quarters the
      panel states its coverage rather than drawing a chart that invites a trend to be read from three
      bars.</li>
      <li><strong>August 22, 2026</strong> Form D filings under Tourism &amp; Travel Services were
      attributed to no sector at all. The lookup rewrites an ampersand to &ldquo;and&rdquo; before
      matching, but that one entry had kept its ampersand and could never be hit.</li>
      <li><strong>August 22, 2026</strong> The security-type checkboxes were stored two ways: the
      quarterly data sets leave an unticked box blank, while the EDGAR path wrote an explicit false.
      Filtering for false returned only the EDGAR rows. Both are stored as the source gives them and
      resolved in one place when the derived table is built.</li>
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
