# Owner handoff checklist

Use this checklist when the GitHub repository belongs to someone else.

## GitHub owner

- [ ] Create an empty repository and provide its `owner/repository` name.
- [ ] Grant the person publishing this code write access, or push the local
      repository themselves.
- [ ] Enable GitHub Actions.
- [ ] Allow the workflow `GITHUB_TOKEN` to write Issues, or retain the workflow's
      explicit `issues: write` permission under the organization policy.
- [ ] Add Actions secrets: `DATABASE_URL`, `FRED_API_KEY`, `NYT_API_KEY`,
      `EIA_API_KEY`, `BLS_API_KEY`, and `SEC_USER_AGENT`.
- [ ] Run **Daily ingest** manually once with `force_all=true`.

## Neon owner

- [ ] Create the Neon project in the long-term owner's account/team.
- [ ] Copy a pooled PostgreSQL connection string with `sslmode=require`.
- [ ] Store it as the GitHub Actions `DATABASE_URL` secret.
- [ ] Store it as Vercel `DATABASE_URL` for Production and Preview.
- [ ] Do not commit it or expose it as a `NEXT_PUBLIC_` variable.

## Source credentials

- [ ] FRED API key.
- [ ] NYT application with Archive API access.
- [ ] EIA Open Data key.
- [ ] BLS public-data registration key.
- [ ] A monitored contact email for `SEC_USER_AGENT`.

## Vercel owner

- [ ] Import the owner's GitHub repository.
- [ ] Set Root Directory to `web`.
- [ ] Set `DATABASE_URL`.
- [ ] Set `NEXT_PUBLIC_SITE_URL` to the canonical production origin.
- [ ] Deploy and provide the canonical production origin.
- [ ] Optionally configure a custom domain.
- [ ] Confirm `/api/industry/energy` returns HTTP 200 and CORS headers.
- [ ] Confirm a cold page load after Neon has been idle/suspended.

## Excel owner

- [ ] Put the production origin in the `ApiBaseUrl` named cell.
- [ ] Import `excel/power-query/IndustryScope.pq`.
- [ ] Import `excel/vba/RefreshIndustryScope.bas`.
- [ ] Add the refresh button and save `IndustryScope_Model.xlsm`.
- [ ] Commit the assembled `.xlsm` if the repository policy accepts binary files.

## Final acceptance

- [ ] All Actions source attempts appear in `ingest_runs`.
- [ ] Any failed source is amber in the site freshness strip.
- [ ] All 20 sector routes load.
- [ ] Date presets and custom dates update every time-series panel without a
      network request.
- [ ] Workbook download opens, formulas recalculate, and Summary chart is native.
- [ ] Event blurbs have completed human editorial review before publication.
