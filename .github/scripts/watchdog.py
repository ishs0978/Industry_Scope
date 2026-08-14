"""Open an issue when the ingest has not run at all.

failure_issue.py only reports when the workflow runs and a source fails. If the
workflow never fires, no issue opens, no email arrives, and silence is
indistinguishable from success. Every way the schedule can die produces exactly
that silence.

This lives in its own workflow on purpose. A watchdog inside the thing it
watches is not a watchdog.
"""

from __future__ import annotations

import os
import sys

import psycopg
import requests


STALE_AFTER_HOURS = 48
TITLE = "IndustryScope ingest has stopped running"


def latest_ingest_age_hours(database_url: str) -> float | None:
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT EXTRACT(EPOCH FROM (now() - max(started_at))) / 3600 FROM ingest_runs"
            )
            value = cursor.fetchone()[0]
    return None if value is None else float(value)


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is required", file=sys.stderr)
        return 1
    age_hours = latest_ingest_age_hours(database_url)
    if age_hours is not None and age_hours <= STALE_AFTER_HOURS:
        print(f"Last ingest started {age_hours:.1f}h ago; healthy.")
        return 0

    observed = "never" if age_hours is None else f"{age_hours:.1f} hours ago"
    print(f"Last ingest started {observed}; opening an issue.", file=sys.stderr)

    repository = os.environ["GITHUB_REPOSITORY"]
    token = os.environ["GITHUB_TOKEN"]
    api = f"https://api.github.com/repos/{repository}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    requests.post(
        f"{api}/labels", headers=headers, timeout=30,
        json={"name": "ingest-stalled", "color": "B60205",
              "description": "The scheduled IndustryScope ingest has not run"},
    )
    body = (
        f"The most recent row in `ingest_runs` started **{observed}**, past the "
        f"{STALE_AFTER_HOURS}-hour threshold.\n\n"
        "The site is still serving whatever was last written, so the numbers are "
        "older than they look. Likely causes, most common first:\n\n"
        "1. GitHub disabled the schedule after 60 days of repository inactivity. "
        "Check the Actions tab for a banner and re-enable it.\n"
        "2. The `DATABASE_URL` or another secret expired.\n"
        "3. The ingest is failing before it can record a run.\n\n"
        f"Workflow: {os.environ.get('GITHUB_SERVER_URL')}/{repository}/actions/runs/"
        f"{os.environ.get('GITHUB_RUN_ID')}"
    )
    existing = requests.get(
        f"{api}/issues", headers=headers, timeout=30,
        params={"state": "open", "labels": "ingest-stalled", "per_page": 1},
    )
    existing.raise_for_status()
    issues = existing.json()
    if issues:
        update = requests.patch(
            f"{api}/issues/{issues[0]['number']}", headers=headers, timeout=30,
            json={"title": TITLE, "body": body},
        )
        update.raise_for_status()
        print(f"Updated issue #{issues[0]['number']}")
    else:
        create = requests.post(
            f"{api}/issues", headers=headers, timeout=30,
            json={"title": TITLE, "body": body, "labels": ["ingest-stalled"]},
        )
        create.raise_for_status()
        print(f"Created issue #{create.json()['number']}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
