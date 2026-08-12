import type { Metadata } from "next";

export const metadata: Metadata = { title: "Methodology" };

export default function MethodologyPage() {
  return <main className="methodology">
    <div className="eyebrow">Methods and limitations</div>
    <h1>How IndustryScope works.</h1>
    <p>IndustryScope separates collection from presentation. A scheduled Python job calls external sources, records every attempt in PostgreSQL, and preserves raw time series. The web application reads only PostgreSQL and never calls a market, government, or news API during a request.</p>

    <h2>Prices and funds</h2>
    <p>Yahoo Finance supplies daily price history, adjusted close, volume, ETF assets, and expense ratios. Stooq is used only when Yahoo fails or returns no rows, and the selected provider is recorded per ticker. Daily holdings come from issuer files published by iShares and State Street. Unsupported issuers are marked unavailable. A failed download leaves the prior snapshot intact and visible with its original date.</p>

    <h2>Performance metrics</h2>
    <ul>
      <li>Cumulative return is ending adjusted close divided by beginning adjusted close, less one.</li>
      <li>CAGR annualizes total return using elapsed calendar days and 365.25 days per year.</li>
      <li>Volatility is the sample standard deviation of daily returns multiplied by √252.</li>
      <li>Sharpe subtracts the prevailing FRED DGS3MO yield, converted to a daily rate, and annualizes the result.</li>
      <li>Beta is sample covariance with SPY daily returns divided by SPY variance. Correlation uses paired dates only.</li>
      <li>Maximum drawdown reports the peak, trough, first recovery date, and peak-to-recovery duration.</li>
      <li>Holdings overlap is the sum of the smaller weight for every ticker shared by two funds. HHI is the sum of squared weights.</li>
    </ul>

    <h2>Macroeconomic and operating data</h2>
    <p>FRED series are validated before collection. Invalid series are logged and omitted. FRED metadata includes its latest update/release date and realtime-start vintage field. EIA indicators cover petroleum inventories, production, and refinery utilization. BLS CES data provides industry payroll employment and average hourly earnings where a published industry mapping exists. Every chart shows its own source release or as-of date.</p>

    <h2>SEC fundamentals and private capital</h2>
    <p>Company facts come from SEC XBRL Company Facts and Frames endpoints with the SEC-required descriptive User-Agent and a rate below ten requests per second. Missing XBRL tags stay blank. They are never converted to zero. Form D filings come from EDGAR full indexes and primary XML submissions; offering amounts are shown only when reported.</p>

    <h2>News and events</h2>
    <p>The NYT Archive API contributes headline, abstract, publication date, section, and outbound URL only. Full article text is neither requested nor stored. GDELT DOC 2.0 contributes quantitative volume and tone time series. Event annotations are read verbatim from a human-reviewable JSON registry. IndustryScope does not generate market-event commentary.</p>

    <h2>Known limitations</h2>
    <p>ETF holdings do not perfectly define an industry, issuer taxonomies differ, XBRL tags vary across companies, Form D sector assignment depends on available SEC SIC metadata, and news-keyword matching can produce false positives or miss relevant coverage. Data-source failures are intentionally visible instead of being filled with estimates.</p>
  </main>;
}

