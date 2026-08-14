# Operating the ingest

## What runs, and when

| Workflow | Schedule | Purpose |
|---|---|---|
| `ingest.yml` | 10:00 and 11:00 UTC daily | Collects every source. One of the two hours is 06:00 America/New_York across DST. |
| `watchdog.yml` | 14:00 UTC Mondays | Opens an issue if no ingest has run in 48 hours. |
| `keepalive.yml` | 05:17 UTC on the 1st | Pushes a dated marker so GitHub does not disable the schedules. |

## Why a delayed run is no longer a skipped run

Both cron entries fire, and `should_run_ingest.py` asks the database whether a
non-skipped source already succeeded today in New York time. The first run to
find nothing does the work; the second finds today's success and exits.

This replaced a wall-clock guard that compared the hour to `06`. Actions cron is
best effort and routinely starts late, so a run beginning at 07:02 ET read `07`,
exited, and nothing ran that day at all.

A retry cannot double-ingest, and a run delayed by hours still works.

## The 60-day inactivity rule

GitHub disables scheduled workflows after 60 days of repository inactivity. It
sends one easy-to-miss email and gives no other signal. The site keeps loading
and the numbers freeze.

`keepalive.yml` pushes a dated marker monthly to reset that clock.

**The better fix is to stop depending on GitHub's scheduler.** `workflow_dispatch`
is not subject to the inactivity rule, so an external scheduler calling the API
daily removes both this failure mode and any dependence on Actions cron timing:

```
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_PAT" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/<owner>/<repo>/actions/workflows/ingest.yml/dispatches \
  -d '{"ref":"main"}'
```

Point any free scheduler at that: cron-job.org, Val Town, or a Vercel cron. The
PAT needs `actions: write` on this repository only. Once that is running, the
keepalive workflow can be deleted.

## Checking health by hand

```sql
-- Did anything run recently?
SELECT source, status, started_at, finished_at, rows_written
FROM ingest_runs ORDER BY started_at DESC LIMIT 20;

-- Are prices actually advancing?
SELECT max(date) FROM prices;

-- Which sectors are starved of news?
SELECT sector_slug, max(date) FROM news_volume GROUP BY sector_slug ORDER BY 2;
```

`assert_price_freshness.py` runs this second check after every ingest and fails
the job if the newest price is more than four days old. Without it the job can
report success while writing zero rows, because `upsert_rows` returning 0 is not
an error anywhere.

## Running a full-history price refresh

Yahoo restates adjusted close across the whole history whenever a dividend is
paid, and the daily job only re-fetches a trailing window. Dispatch the ingest
with `force_all` enabled to rewrite every ticker's full series onto one
adjustment basis, and to run the weekly sources in the same pass.
