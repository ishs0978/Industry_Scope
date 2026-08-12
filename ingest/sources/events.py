"""Load the human-reviewable curated event registry into PostgreSQL."""

from __future__ import annotations

from datetime import date
import json
from pathlib import Path
from typing import Any

from ingest.sources.common import logged_run, upsert_rows


EVENTS_PATH = Path(__file__).parents[1] / "config" / "events.json"


def load_events(path: Path = EVENTS_PATH) -> list[dict[str, Any]]:
    events = json.loads(path.read_text(encoding="utf-8"))
    if not 40 <= len(events) <= 50:
        raise ValueError(f"events registry must contain 40–50 entries; found {len(events)}")
    ids = [event["id"] for event in events]
    if len(ids) != len(set(ids)):
        raise ValueError("event ids must be unique")
    return events


def run(connection: Any) -> None:
    with logged_run(connection, "events") as result:
        rows = [
            (
                event["id"], date.fromisoformat(event["start"]), date.fromisoformat(event["end"]),
                event["sectors"], event["title"], event["blurb"], event["source_url"], event["impact"],
            )
            for event in load_events()
        ]
        result.rows_written = upsert_rows(
            connection,
            """INSERT INTO events (id,start_date,end_date,sectors,title,blurb,source_url,impact)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET
            start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,sectors=EXCLUDED.sectors,
            title=EXCLUDED.title,blurb=EXCLUDED.blurb,source_url=EXCLUDED.source_url,impact=EXCLUDED.impact""",
            rows,
        )

