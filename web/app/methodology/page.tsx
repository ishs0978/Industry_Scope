import type { Metadata } from "next";

export const metadata: Metadata = { title: "Methodology" };

export default function MethodologyPage() {
  return <main className="methodology">
    <div className="eyebrow">Methods and limitations</div>
    <h1>How IndustryScope works.</h1>
    <p>IndustryScope separates collection from presentation. A scheduled Python job calls external sources, records every attempt in PostgreSQL, and preserves raw time series. The web application reads only PostgreSQL and never calls a market, government, or news API during a request.</p>

    <h2>Prices and funds</h2>
    <p>Yahoo Finance supplies daily price history, adjusted close, volume, ETF assets, and expense ratios. Stooq is used only when Yahoo fails or returns no rows, and the selected provider is recorded per ticker. A trailing price window is refreshed on every run so temporary missing rows can be repaired. Daily holdings use explicitly configured per-fund issuer feeds; funds without an implemented parser are marked unsupported. A failed download never overwrites the prior snapshot.</p>

    <h2>Performance metrics</h2>
    <ul>
      <li>Cumulative return is ending adjusted close divided by beginning adjusted close, less one.</li>
      <li>Calendar-period returns use the same adjusted-close observations and window boundaries as cumulative return. Daily return factors are assigned to the year in which they end, so compounding every displayed period reproduces the headline. Stub years are labeled with their partial dates.</li>
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
    <ul>
      <li>ETF holdings do not perfectly define an industry, issuer taxonomies differ, XBRL tags vary across companies, Form D sector assignment depends on available SEC SIC metadata, and news-keyword matching can produce false positives or miss relevant coverage.</li>
      <li>The August 12, 2026 verification pass found that the old calendar table omitted the prior year-end boundary. On the stored adjusted-close rows, corrected full-year results are SMH 39.10% and SOXX 12.92% for 2024, and GLD 63.68%, GDX 154.77%, and SIL 166.16% for 2025. The large miner-versus-bullion spread remains present after correction.</li>
      <li>XLY’s apparent 0.00% 2026 result was a boundary artifact: Jan 2 and Aug 12 happened to be nearly equal. Using Dec 31 as the boundary produces −0.88% through Aug 12. Isolated missing sessions were also observed, so the ingest now refreshes a trailing window; missing values are never interpolated.</li>
      <li>StockAnalysis was used as the independent spot check for fund identity, current quote, assets, expense ratio, and holdings. Assets and expense ratio are keyed to the selected composition tab. Yahoo does not return an expense ratio for every fund; those cases are labeled “Unavailable from Yahoo Finance” rather than shown as an unexplained blank.</li>
      <li>Data-source failures are intentionally visible instead of being filled with estimates. Older valid holdings may be shown only with a dated stale warning; validation failures suppress claims derived from that fund.</li>
    </ul>
  </main>;
}
