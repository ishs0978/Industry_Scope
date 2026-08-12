"""Fault-isolated source orchestration with per-source cadence."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
import json
import os
from pathlib import Path
import sys
from typing import Any, Callable

import psycopg

from ingest.db import apply_migrations, sync_sector_registry
from ingest.sources import bls, eia, events, form_d, fred, gdelt, holdings, nyt, prices, sec_xbrl


FAILURES_PATH = Path(__file__).parent / "failures.json"


@dataclass(frozen=True)
class ScheduledSource:
    name: str
    runner: Callable[[Any], None]
    cadence: str


SOURCES = (
    ScheduledSource("events", events.run, "daily"),
    ScheduledSource("prices", prices.run, "daily"),
    ScheduledSource("holdings", holdings.run, "daily"),
    ScheduledSource("fred", fred.run, "daily"),
    ScheduledSource("eia", eia.run, "daily"),
    ScheduledSource("form_d", form_d.run, "daily"),
    ScheduledSource("gdelt", gdelt.run, "daily"),
    ScheduledSource("nyt_archive", nyt.run, "daily"),
    ScheduledSource("bls", bls.run, "weekly"),
    ScheduledSource("sec_xbrl", sec_xbrl.run, "weekly"),
)


def due(source: ScheduledSource, today: date, force_all: bool = False) -> bool:
    if force_all or source.cadence == "daily":
        return True
    return source.cadence == "weekly" and today.weekday() == 0


def ensure_attempt_logged(connection: Any, source: str, started_at: datetime, error: Exception) -> None:
    """Cover failures occurring before a source enters its own logged_run block."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT 1 FROM ingest_runs WHERE source=%s AND started_at >= %s LIMIT 1",
            (source, started_at),
        )
        already_logged = cursor.fetchone() is not None
        if not already_logged:
            cursor.execute(
                """INSERT INTO ingest_runs
                (source,started_at,finished_at,status,rows_written,error_message,details)
                VALUES (%s,%s,now(),'failed',0,%s,'{}'::jsonb)""",
                (source, started_at, f"{type(error).__name__}: {error}"[:4000]),
            )
    connection.commit()


def run_all(connection: Any, *, today: date | None = None, force_all: bool = False) -> list[dict[str, str]]:
    run_date = today or date.today()
    failures: list[dict[str, str]] = []
    for source in SOURCES:
        if not due(source, run_date, force_all):
            continue
        started_at = datetime.now(timezone.utc)
        print(f"[{source.name}] starting ({source.cadence})", flush=True)
        try:
            source.runner(connection)
        except Exception as exc:
            ensure_attempt_logged(connection, source.name, started_at, exc)
            failures.append({"source": source.name, "reason": f"{type(exc).__name__}: {exc}"})
            print(f"[{source.name}] failed: {exc}", file=sys.stderr, flush=True)
        else:
            print(f"[{source.name}] complete", flush=True)
    return failures


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is required", file=sys.stderr)
        FAILURES_PATH.write_text(json.dumps([{"source": "database", "reason": "DATABASE_URL is required"}], indent=2))
        return 0

    failures: list[dict[str, str]] = []
    try:
        with psycopg.connect(database_url) as connection:
            apply_migrations(connection)
            sync_sector_registry(connection)
            failures = run_all(connection, force_all=os.environ.get("FORCE_ALL") == "1")
    except Exception as exc:
        failures.append({"source": "database", "reason": f"{type(exc).__name__}: {exc}"})
        print(f"[database] failed: {exc}", file=sys.stderr)
    FAILURES_PATH.write_text(json.dumps(failures, indent=2) + "\n", encoding="utf-8")
    print(f"Ingest finished with {len(failures)} source failure(s)")
    # Individual failures are reported through GitHub issues and ingest_runs.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

