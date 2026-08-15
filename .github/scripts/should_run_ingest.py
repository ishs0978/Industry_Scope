"""Decide whether today's ingest still needs to run.

The workflow schedules two UTC hours and previously guarded them with a wall
clock check for 06:00 America/New_York. GitHub Actions cron is best effort and
routinely starts late, so a run beginning at 07:02 ET read "07", exited, and
nothing ran that day at all. That design converts a common delay into a total
miss.

Ask the database whether today's ingest already succeeded instead. Both cron
entries then behave correctly, a delayed run still works, and a retry cannot
double-ingest.
"""

from __future__ import annotations

import os
from pathlib import Path
import sys

import psycopg


TODAY_SUCCEEDED = """
SELECT count(*) FROM ingest_runs
WHERE status = 'success'
  AND COALESCE((details->>'skipped')::boolean, false) = false
  AND started_at >= (
    date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'
  )
"""


def emit(should_run: bool, reason: str) -> int:
    print(f"run={should_run} ({reason})")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with Path(output).open("a", encoding="utf-8") as handle:
            handle.write(f"run={'true' if should_run else 'false'}\n")
    return 0


def main() -> int:
    if os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch":
        return emit(True, "manual dispatch")
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is required", file=sys.stderr)
        return 1
    try:
        with psycopg.connect(database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(TODAY_SUCCEEDED)
                already = cursor.fetchone()[0]
    except Exception as exc:
        # Never let a lookup failure silently skip a day. Run and let the
        # ingest itself report the database problem.
        return emit(True, f"state check failed ({type(exc).__name__}); running anyway")
    if already:
        return emit(False, f"{already} successful source run(s) already recorded today")
    return emit(True, "no successful run recorded today")


if __name__ == "__main__":
    raise SystemExit(main())
