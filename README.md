# IndustryScope

**[Open the live explorer](https://industryscope.vercel.app/)** - search an
industry, inspect its performance, holdings, companies, capital, macro signals,
and source health, then change the date window without waiting for another API
request.

IndustryScope is a public, source-transparent tool for analyzing industry
performance, ETF composition, SEC fundamentals, private capital, macro and
operating indicators, and sourced events over one user-controlled date range.

The repository contains no synthetic market data. When an upstream source is
missing or its last run failed, the API and UI identify the source and reason.

## See it in 30 seconds

- [Open the semiconductors dashboard](https://industryscope.vercel.app/industry/semiconductors)
  to inspect performance, ETF holdings, public-company fundamentals, private
  capital, macro indicators, events, headlines, and source health in one view.
- [Read the same sector as JSON](https://industryscope.vercel.app/api/industry/semiconductors)
  to inspect the public API contract and source metadata directly.
- [Review the methodology](https://industryscope.vercel.app/methodology) for
  metric definitions, data provenance, freshness rules, and known limitations.

The live explorer and these direct links require no account.

## Architecture

```text
GitHub Actions (daily at 06:00 America/New_York)
  -> Python 3.11 ingest modules
  -> Neon Postgres
  -> export step writes web/data/*.json, then triggers a deploy
  -> Next.js 15 App Router on Vercel, built from those files
  -> JSON API and Excel downloads
```

The Vercel build does not open a database connection. It used to: each of
the 84 pages ran its own queries while rendering, so one build pulled the same
rows dozens of times over, and a month of rebuilds exhausted the database's
data transfer allowance. Every page then rendered empty, and the empty version
was cached over the real one. The deploy workflow now exports each page's
payload once, in the job that already holds the credentials, and Vercel builds
from those files. Fresh rows reach readers because the ingest job triggers a
deploy when it finishes.

External APIs are called only by `ingest/sources`. The Next.js application
reads PostgreSQL; it does not call market, government, SEC, or news APIs during
a web request. Raw time series are sent to the browser, where TypeScript
recomputes date-window metrics without another request.

## Repository layout

```text
ingest/                       Python ingest and versioned SQL migrations
  config/                     Sector, FRED, company-group, and event registries
  sources/                    One adapter per upstream source
web/                          Next.js application and client workbook generator
  app/industry/[slug]         One sector: performance, groups, companies, capital
  app/etf/[ticker]            One fund: risk, fees, composition
  app/company/[ticker]        One company: valuation, analyst view, returns
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

### Rebuilding the database from scratch

Nothing in the database is original: every row is derived from SEC, Yahoo, FRED,
EIA, BLS, GDELT or NYT. Moving to another Postgres provider, or recovering from
losing the database entirely, is therefore a re-ingest rather than a restore:

```bash
DATABASE_URL=postgres://... scripts/bootstrap_database.sh
```

It takes roughly two hours, most of it the SEC quarterly Form D files. Stages run
in dependency order and each is idempotent, so a failure part way through is
resumed by running it again.

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

### Filling it without an account or a key

That explicit error is honest, but it is also an empty application, and the
credentials table above is a long way to walk before finding out whether any of
this is worth running. Three of the sources were never behind a key at all:
Yahoo and Stooq for prices, the iShares and State Street holdings files, and the
curated event registry that ships in the repository. Those three fill enough of
the database to make every price, risk and composition panel real, against a
Postgres you start yourself:

```bash
docker run -d --name industryscope-db -p 5432:5432 \
  -e POSTGRES_USER=industryscope -e POSTGRES_PASSWORD=industryscope \
  -e POSTGRES_DB=industryscope postgres:16
export DATABASE_URL='postgresql://industryscope:industryscope@localhost:5432/industryscope?sslmode=disable'

source .venv/bin/activate
python -m ingest.db
python -c "
import os, psycopg
from ingest.sources import events, prices, holdings
connection = psycopg.connect(os.environ['DATABASE_URL'])
for module in (events, prices, holdings):
    module.run(connection)
connection.close()"

cd web && npm ci && npm run dev
```

`sslmode=disable` is load-bearing and is the only thing in this file that turns
TLS off. Neon speaks TLS only, so the web layer requires it unless the
connection string says otherwise; a Postgres you started yourself has no
certificate to present, and without the opt-out the failure arrives as "socket
disconnected before secure TLS connection was established", which reads like a
network fault rather than a setting.

The ingest takes a couple of minutes and is all network wait. It leaves FRED,
EIA, BLS, SEC XBRL, Form D and the news sources empty, and the pages name each
missing source rather than closing the gap with anything invented, which is the
same behaviour the deployment has on a day a source fails.

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
- daily until the history is loaded: Form D quarterly data sets, four quarters
  per run, then nothing until the SEC publishes a new quarter
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
- **Form D:** published quarters come from the SEC's quarterly data sets, which
  cover every filing since 2008Q3; the quarter in progress is assembled from the
  EDGAR full index and is replaced when its data set publishes. Both write to the
  same staging tables, and `form_d` is derived from them at one row per
  accession. A filing naming co-issuers reports one amount once, so issuers are
  carried as an attribute and a count, never as extra rows. Sector assignment
  prefers the industry the issuer selected on the form and falls back to the most
  specific configured SIC prefix, which the data sets leave blank for most
  private issuers. Missing or indefinite offering amounts remain blank, which is
  not the same as a reported zero.

  Filings are grouped into offerings on the 021-XXXXXX file number EDGAR keeps
  constant across an original and its amendments, falling back to the
  previousAccessionNumber chain where a filing carries no file number. An
  offering's dollars are the cumulative figure from its latest filing, never a
  sum across the group, and its date is the original's filing date, so amending
  does not move money into a later quarter. An offering whose original predates
  the loaded history has no known start date: it stays in the table and is left
  out of the quarterly chart, and the panel says how much money that removes.
  Four counts are reported together and reconcile exactly as
  `filings = offerings + amendments - orphan offerings`. The subtraction is over
  orphan offerings rather than orphan filings, because an offering with three
  amendments and no original is one unit of over-count, not three.

  Pooled vehicles are excluded on two of the filer's own answers: selecting
  Pooled Investment Fund as the industry, and reporting that the security sold
  is an interest in a pooled investment fund. The second catches vehicles that
  pick an operating industry, such as insurance separate accounts filing under
  Insurance. Selecting the pooled industry now ends attribution rather than
  falling through to EDGAR's SIC code, which is how funds carrying a bank's SIC
  used to come back as banks. A third signal, an issuer name matching patterns
  common among vehicles, excludes nothing: it is stored in `pooled_name_match`
  and shown as a column, because plenty of operating businesses are limited
  partnerships. Some vehicles satisfy none of the source tests and remain
  visible in the table rather than being removed on a guess.

  The security-type boxes travel through to the derived table, so the panel can
  report how much of a sector's private money involves debt. They are not
  exclusive: an offering selling equity and debt together counts in full as
  debt, because the form never asks how the money splits. Offerings ticking no
  box are excluded from that share rather than assumed to be equity; they are a
  large share of reported dollars in some sectors, and the panel states how much
  the figure is not measured over.

  The quarterly chart plots bars only. It carried an ETF price line on a second
  axis, which invited a causal reading the data cannot support and labelled an
  incomplete quarter as a quarter-end price. Hovering a bar gives the number of
  offerings behind it. Below four quarters the panel states its coverage instead
  of drawing a chart, because three bars invite one of them to be read as a
  trend. A coverage line above the panel states the Form D date range actually
  held, separately from the range the reader selected, and names each end that
  falls short.
- **News:** two feeds with different lags, and the page says which is which.
  GDELT indexes publishers continuously and supplies current coverage; the NYT
  Archive publishes a month at a time once that month has completed, so it is
  structurally weeks behind and supplies depth rather than currency. GDELT
  matches whole articles, so a sector query returns pieces that mention the
  subject once in passing; only articles whose headline carries the subject are
  kept, and each publisher is capped so an algorithmic content farm cannot fill
  a sector. GDELT enforces a window quota, so one run covers a handful of
  sectors and successive runs serve whichever are emptiest.
- **Curated events:** written by hand against a source. They record things with
  a lasting effect on a sector, not what happened today, so the list is only as
  current as its last review and the page says when that was.
- **Companies:** weekly closes, not daily. Daily bars for the ~800 companies
  inside the funds would be about 330 MB against a 512 MB ceiling, and every
  question a company page asks is measured in years. Valuation multiples and
  analyst targets come from Yahoo and are opinions with a date on them rather
  than anything the company reported; the page labels them so.
- **Company groups:** the Magnificent 7 and the AI sub-groups are curated, so
  their membership is a judgement rather than a fact from a filing. The issuer
  holdings files carry a sub-sector column whose every value is literally "-",
  which is why they cannot be derived. A ticker named in the group file appears
  only if prices are actually held for it.
- **Bond and municipal funds** carry no SIC prefix, because they own debt rather
  than issuers. Their Form D and fundamentals panels are empty by construction.
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
