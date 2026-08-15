"""Create or update the single open ingest-failure issue using the GitHub API."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys

import requests


def main() -> int:
    report = Path("ingest/failures.json")
    if report.exists():
        failures = json.loads(report.read_text())
    else:
        # The file is written last, and is no longer committed to the repo, so a
        # missing one means the ingest died before it could report anything.
        # Saying so beats crashing here and beats reading a stale committed file
        # and reporting a failure that did not happen.
        failures = [{
            "source": "ingest",
            "reason": "Ingest did not finish; no failure report was written.",
        }]
    if not failures:
        print("No ingest failures")
        return 0
    repository = os.environ["GITHUB_REPOSITORY"]
    token = os.environ["GITHUB_TOKEN"]
    api = f"https://api.github.com/repos/{repository}"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    requests.post(f"{api}/labels", headers=headers, json={"name": "ingest-failure", "color": "D4A72C", "description": "Automated IndustryScope data-source failure"}, timeout=30)
    body = "## Latest ingest failures\n\n" + "\n".join(f"- **{item['source']}**: `{item['reason']}`" for item in failures)
    body += f"\n\nWorkflow: {os.environ.get('GITHUB_SERVER_URL')}/{repository}/actions/runs/{os.environ.get('GITHUB_RUN_ID')}"
    response = requests.get(f"{api}/issues", headers=headers, params={"state": "open", "labels": "ingest-failure", "per_page": 1}, timeout=30)
    response.raise_for_status()
    issues = response.json()
    if issues:
        update = requests.patch(f"{api}/issues/{issues[0]['number']}", headers=headers, json={"title": "IndustryScope ingest failures", "body": body}, timeout=30)
        update.raise_for_status()
        print(f"Updated issue #{issues[0]['number']}")
    else:
        create = requests.post(f"{api}/issues", headers=headers, json={"title": "IndustryScope ingest failures", "body": body, "labels": ["ingest-failure"]}, timeout=30)
        create.raise_for_status()
        print(f"Created issue #{create.json()['number']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

