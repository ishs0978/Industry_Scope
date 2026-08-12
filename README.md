# IndustryScope

IndustryScope is a public, source-transparent tool for analyzing industry
performance, ETF composition, SEC fundamentals, private capital, macro and
operating indicators, and sourced events over one user-controlled date range.

The repository contains no synthetic market data. When an upstream source is
missing or its last run failed, the API and UI identify the source and reason.

## Architecture

```text
GitHub Actions (daily at 06:00 America/New_York)
  -> Python 3.11 ingest modules
  -> Neon Postgres
  -> Next.js 15 App Router on Vercel (daily ISR)
  -> JSON API and Excel downloads
```

External APIs are called only by `ingest/sources`. The Next.js application
reads PostgreSQL; it does not call market, government, SEC, or news APIs during
a web request. Raw time series are sent to the browser, where TypeScript
recomputes date-window metrics without another request.

## Repository layout

```text
ingest/                       Python ingest and versioned SQL migrations
  config/                     Sector, FRED, and human-reviewed event registries
  sources/                    One adapter per upstream source
web/                          Next.js application and client workbook generator
excel/                        Power Query-ready model, M, and VBA source
.github/workflows/ingest.yml  Daily fault-isolated ingest
```

## Required accounts and credentials

| Setting | Used by | Obtain from |
| --- | --- | --- |
| `DATABASE_URL` | ingest and web | Neon project connection details; retain `sslmode=require` |
| `FRED_API_KEY` | FRED ingest | https://fred.stlouisfed.org/docs/api/api_key.html |
| `NYT_API_KEY` | NYT Archive ingest | https://developer.nytimes.com/get-started |
| `EIA_API_KEY` | EIA ingest | https://www.eia.gov/opendata/register.php |
| `BLS_API_KEY` | BLS v2 ingest | https://data.bls.gov/registrationEngine/ |
| `SEC_USER_AGENT` | SEC ingest | A descriptive app name and monitored contact email, e.g. `IndustryScope owner@example.com` |

Yahoo Finance, Stooq, issuer holdings files, GDELT, and SEC endpoints do not
use API keys. API credentials belong in GitHub Actions secrets only. The web
deployment receives `DATABASE_URL` only. Never expose ingest keys to the
browser or prefix them with `NEXT_PUBLIC_`.

Copy `.env.example` to `.env` for local values. The Python application does not
implicitly load `.env`; export it explicitly or use your preferred secret
manager.

## Local setup

Python targets exactly 3.11:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --requirement requirements.txt
pytest
python -m ingest.db
FORCE_ALL=1 python -m ingest.run
```

The web application targets Node 22.18.0:

```bash
cd web
npm ci
npm test
npm run dev
```

Open `http://localhost:3000`. Without `DATABASE_URL`, pages render an explicit
Neon error instead of placeholder charts or values.

## Database and first ingest

`python -m ingest.db` applies each SQL file in `ingest/migrations` once and
upserts the 20-sector YAML registry. `ingest/run.py` also applies pending
migrations, so a new environment can be initialized through the workflow.

Run the GitHub workflow manually once with `force_all=true`. That first run
backfills price history, snapshots supported issuer holdings, collects
government/SEC/news data, and seeds the curated events. Large backfills may
require multiple daily NYT runs because the adapter stops at the provider's
daily limit and permanently marks completed historical months.

Each source attempt writes `ingest_runs`, including failures. Source modules
are isolated: one failure never prevents later sources from running. The
workflow exits successfully and opens or updates one `ingest-failure` issue.

Cadence:

- daily: prices, ETF metadata, holdings, FRED, EIA, Form D, GDELT, events
- daily: current NYT month plus incomplete historical backfill
- weekly on Monday: SEC XBRL and BLS

## Web and API

The home page searches only the sector registry. An unmatched query receives
three fuzzy suggestions; IndustryScope does not infer arbitrary tickers.

`GET /api/industry/{slug}` returns the full raw sector payload with permissive
CORS and daily edge caching. A database failure returns HTTP 503 with a named
source error. Unknown registry slugs return HTTP 404.

All 20 industry pages are statically generated and use a one-day ISR interval.
For Vercel, configure:

- project root: `web`
- framework: Next.js
- install: `npm ci`
- build: `npm run build`
- Node: 22.18.0
- environment variables: `DATABASE_URL`, `NEXT_PUBLIC_SITE_URL`

## Excel

The in-app **Download Excel** button produces a formatted `.xlsx` with Summary,
Price History, Returns, Holdings, Overlap, Comps, Private Capital, Macro,
Events, Headlines, and Checks. Returns uses live Excel formulas, including
`STDEV(...)*SQRT(252)` and `CORREL(...)`, and Summary contains a native editable
Excel line chart driven by Price History.

`excel/IndustryScope_Model.xlsx` is the source-controlled Power Query-ready
model. It contains the named cells `IndustrySlug` and `ApiBaseUrl` and all load
destinations. To assemble the requested macro-enabled copy in desktop Excel:

1. Open the model and replace `ApiBaseUrl` with the production Vercel origin.
2. Data -> Get Data -> Blank Query -> Advanced Editor; paste
   `excel/power-query/IndustryScope.pq`.
3. Create reference queries for each field returned by the record and load them
   to their matching sheets.
4. Import `excel/vba/RefreshIndustryScope.bas` in the VBA editor.
5. Add a form button on Summary and assign `RefreshIndustryScope`.
6. Save as `excel/IndustryScope_Model.xlsm`.

The M query reads the named slug, calls `/api/industry/{slug}`, expands JSON
records into tables, and makes the workbook portable across industries. The VBA
macro calls `ThisWorkbook.RefreshAll`, waits for asynchronous queries, runs a
full calculation, and reapplies table formatting.

The `.xlsm` container is not checked in yet because this build machine has no
desktop Microsoft Excel installation or pre-existing signed VBA project binary.
The M and VBA source are complete and auditable; the six steps above are the
only owner-side artifact assembly required.

## Sources and limitations

- **Prices:** Yahoo Finance; Stooq fallback. The provider used is recorded per
  ticker. Adjusted-close definitions can differ across providers.
- **Holdings:** iShares and State Street issuer files. Unsupported issuers are
  marked unavailable. A failed refresh preserves the prior snapshot and date.
- **FRED:** mapped series validated before collection. Invalid identifiers are
  logged and omitted. FRED release/vintage metadata is stored separately.
- **EIA:** petroleum inventories, field production, and refinery utilization.
  The EIA v2 routes configured here do not expose a verified weekly rig-count
  series; the run metadata explicitly reports rig counts unavailable rather
  than substituting another series.
- **BLS:** published CES employment and average-hourly-earnings series. CES and
  NAICS are not always one-to-one, so some sectors use the nearest published
  broader industry group.
- **SEC XBRL:** Company Facts/Frames tags vary. Missing tags remain blank.
- **Form D:** sector assignment uses the most specific configured SIC prefix.
  Missing or indefinite offering amounts remain blank.
- **NYT:** headline, abstract, date, section, and URL only. Full text is never
  requested or stored.
- **GDELT:** article volume and tone are quantitative context, not a claim about
  market causality.
- **Events:** event titles, dates, sectors, source links, impact labels, and
  blurbs come only from `ingest/config/events.json`. No language model writes
  event commentary.

## Editorial review required

The 45 seeded event records intentionally have empty `blurb` fields. A human
editor must verify each source and write any desired factual description before
publication. The UI visibly says “Editorial description pending human review”
until that happens. This is deliberate and prevents model-generated market
narrative from entering the product.

## Findings

- The broadest practical industry definition is the primary ETF, but issuer
  construction rules and concentration make comparison funds materially useful.
- Public-equity performance and BLS operating indicators can diverge, so both
  belong on the same date axis without implying causality.
- SEC facts need tag-aware missingness and cross-company quartiles; zero-filling
  creates misleading margins.
- NYT metadata offers selected event context, while GDELT provides a continuous
  quantitative activity series that does not depend on a daily article cap.
- Source-level freshness is more honest than a single application timestamp.

## Security and data integrity

- secrets are environment variables only
- dependencies are exactly pinned
- SEC traffic uses a contact-bearing User-Agent and stays below 10 requests/sec
- no web request performs an external-source call
- no full article text is scraped or stored
- no synthetic values are used outside tests
- every table/panel exposes its own source date or explicit source error
