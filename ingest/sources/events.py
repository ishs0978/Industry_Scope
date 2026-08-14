"""Load the human-reviewable curated event registry into PostgreSQL."""

from __future__ import annotations

from datetime import date
import json
from pathlib import Path
from typing import Any

from ingest.sources.common import SourceUnavailable, logged_run, upsert_rows


EVENTS_PATH = Path(__file__).parents[1] / "config" / "events.json"
MIN_EVENTS = 40
MAX_EVENTS = 80
# A hand-curated file has no upstream to fail, so nothing announces that it has
# stopped being maintained. It simply rots, which is what happened between
# September 2024 and this pass.
STALE_AFTER_DAYS = 90


def load_events(path: Path = EVENTS_PATH) -> list[dict[str, Any]]:
    events = json.loads(path.read_text(encoding="utf-8"))
    if not MIN_EVENTS <= len(events) <= MAX_EVENTS:
        raise ValueError(
            f"events registry must contain {MIN_EVENTS}–{MAX_EVENTS} entries; found {len(events)}"
        )
    ids = [event["id"] for event in events]
    if len(ids) != len(set(ids)):
        raise ValueError("event ids must be unique")
    blank = [event["id"] for event in events if not str(event.get("blurb", "")).strip()]
    if blank:
        raise ValueError(f"every event needs a blurb; missing for {sorted(blank)}")
    return events


def days_since_newest_event(events: list[dict[str, Any]], today: date) -> int:
    return (today - max(date.fromisoformat(event["start"]) for event in events)).days


def run(connection: Any) -> None:
    with logged_run(connection, "events") as result:
        events = load_events()
        stale_days = days_since_newest_event(events, date.today())
        result.details = {
            "event_count": len(events),
            "days_since_newest_event": stale_days,
            "stale_after_days": STALE_AFTER_DAYS,
        }
        rows = [
            (
                event["id"], date.fromisoformat(event["start"]), date.fromisoformat(event["end"]),
                event["sectors"], event["title"], event["blurb"], event["source_url"], event["impact"],
            )
            for event in events
        ]
        result.rows_written = upsert_rows(
            connection,
            """INSERT INTO events (id,start_date,end_date,sectors,title,blurb,source_url,impact)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET
            start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,sectors=EXCLUDED.sectors,
            title=EXCLUDED.title,blurb=EXCLUDED.blurb,source_url=EXCLUDED.source_url,impact=EXCLUDED.impact""",
            rows,
        )
        # Raised after the rows are written, so the curated data still lands.
        # This exists only to open a failure issue: without an alarm a curated
        # file rots silently, which is exactly how this one reached two years
        # out of date.
        if stale_days > STALE_AFTER_DAYS:
            raise SourceUnavailable(
                f"newest curated event is {stale_days} days old "
                f"(threshold {STALE_AFTER_DAYS}); add recent entries to ingest/config/events.json"
            )

