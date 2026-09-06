"""Load the human-reviewable curated event registry into PostgreSQL."""

from __future__ import annotations

from dataclasses import dataclass
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
#
# What rots is the curation, not the events. An embargo in 1973 does not expire,
# and a quarter in which no new event qualifies is a normal quarter, not a
# lapsed one. The alarm therefore reads the date a curator last went through the
# file, which the file records itself, rather than the newest start date, which
# is a fact about the world. Reading the start date made the check unsatisfiable
# without padding the registry: on 2026-09-05 the newest entry was 96 days old
# and still in force, its end date running to 2027.
STALE_AFTER_DAYS = 90


@dataclass(frozen=True)
class Registry:
    """The curated file: when it was last gone through, and what it holds."""

    reviewed_through: date
    events: list[dict[str, Any]]


def load_registry(path: Path = EVENTS_PATH, today: date | None = None) -> Registry:
    document = json.loads(path.read_text(encoding="utf-8"))
    events = document["events"]
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
    reviewed_through = date.fromisoformat(document["reviewed_through"])
    # Both bounds exist because the watermark is hand-maintained and a hand-typed
    # date is the one thing here that no upstream contradicts. A future date is
    # the shape a bump made to quiet the alarm takes; a date behind the newest
    # entry means the reviewer added an event and forgot to move the watermark.
    if reviewed_through > (today or date.today()):
        raise ValueError(f"the registry cannot be reviewed through {reviewed_through}, which is in the future")
    newest = max(date.fromisoformat(event["start"]) for event in events)
    if reviewed_through < newest:
        raise ValueError(
            f"registry is reviewed through {reviewed_through} but lists {newest}; move the watermark"
        )
    return Registry(reviewed_through=reviewed_through, events=events)


def load_events(path: Path = EVENTS_PATH) -> list[dict[str, Any]]:
    return load_registry(path).events


def days_since_review(registry: Registry, today: date) -> int:
    return (today - registry.reviewed_through).days


def days_since_newest_event(events: list[dict[str, Any]], today: date) -> int:
    return (today - max(date.fromisoformat(event["start"]) for event in events)).days


def run(connection: Any) -> None:
    with logged_run(connection, "events") as result:
        today = date.today()
        registry = load_registry(today=today)
        events = registry.events
        stale_days = days_since_review(registry, today)
        result.details = {
            "event_count": len(events),
            "reviewed_through": registry.reviewed_through.isoformat(),
            "days_since_review": stale_days,
            "days_since_newest_event": days_since_newest_event(events, today),
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
                f"the curated registry was last reviewed {stale_days} days ago "
                f"(threshold {STALE_AFTER_DAYS}); re-read ingest/config/events.json, add anything "
                "that qualifies, and move reviewed_through - a review that adds nothing still counts"
            )

