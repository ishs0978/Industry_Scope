"""Fault-isolated source orchestration with per-source cadence."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
import json
import os
from pathlib import Path
import sys
from typing import Any, Callable
from uuid import uuid4

import psycopg

from ingest.db import apply_migrations, sync_sector_registry
from ingest.sources import bls, eia, events, form_d, fred, gdelt, holdings, nyt, prices, sec_xbrl
from ingest.sources.common import redact_secrets, reset_batch_id, set_batch_id


FAILURES_PATH = Path(__file__).parent / "failures.json"


@dataclass(frozen=True)
class ScheduledSource:
    name: str
    runner: Callable[[Any], None]
    cadence: str
    reports: tuple[str, ...] = ()


SOURCES: tuple[ScheduledSource, ...] = (
    ScheduledSource("events", events.run, "daily"),
    ScheduledSource("prices", prices.run, "daily", ("prices", "etf_meta")),
    ScheduledSource("holdings", holdings.run, "daily"),
    ScheduledSource("fred", fred.run, "daily"),
    ScheduledSource("eia", eia.run, "daily"),
    ScheduledSource("gdelt", gdelt.run, "daily"),
    ScheduledSource("nyt", nyt.run, "daily"),
    ScheduledSource("bls", bls.run, "weekly"),
    ScheduledSource("sec_xbrl", sec_xbrl.run, "weekly"),
    # Keep the bounded per-filing SEC crawl last so it cannot starve other sources.
    ScheduledSource("form_d", form_d.run, "daily"),
)

# This schedule is the canonical expected-source list. A runner can report more
# than one source (the price adapter also refreshes ETF metadata).
EXPECTED_SOURCES = tuple(
    dict.fromkeys(report for source in SOURCES for report in (source.reports or (source.name,)))
)


def due(source: ScheduledSource, today: date, force_all: bool = False) -> bool:
    if force_all or source.cadence == "daily":
        return True
    return source.cadence == "weekly" and today.weekday() == 0


def seed_expected_sources(connection: Any, batch_id: str, started_at: datetime) -> None:
    with connection.cursor() as cursor:
        cursor.executemany(
            """INSERT INTO ingest_runs (source,started_at,status,batch_id)
            VALUES (%s,%s,'pending',%s)""",
            [(source, started_at, batch_id) for source in EXPECTED_SOURCES],
        )
    connection.commit()


def finish_pending(
    connection: Any,
    batch_id: str,
    sources: tuple[str, ...],
    *,
    status: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """UPDATE ingest_runs SET finished_at=now(),status=%s,error_message=%s,details=%s::jsonb
            WHERE batch_id=%s AND source=ANY(%s) AND status='pending'""",
            (status, message if status == "failed" else None, json.dumps(details or {}), batch_id, list(sources)),
        )
    connection.commit()


def ensure_attempt_logged(
    connection: Any,
    source: str,
    started_at: datetime,
    error: Exception,
    batch_id: str | None = None,
) -> None:
    """Cover failures occurring before a source enters its own logged_run block."""
    # A source may fail while PostgreSQL is in the aborted-transaction state
    # (for example, after a rejected bulk insert).  Failure reporting must use
    # a fresh transaction or it can mask the original error and stop every
    # source that follows.
    if hasattr(connection, "rollback"):
        connection.rollback()
    with connection.cursor() as cursor:
        if batch_id:
            cursor.execute(
                """UPDATE ingest_runs SET finished_at=now(),status='failed',error_message=%s
                WHERE id=(SELECT id FROM ingest_runs WHERE source=%s AND batch_id=%s
                AND status IN ('pending','running') ORDER BY id DESC LIMIT 1) RETURNING id""",
                (redact_secrets(f"{type(error).__name__}: {error}")[:4000], source, batch_id),
            )
            already_logged = cursor.fetchone() is not None
            if not already_logged:
                cursor.execute(
                    "SELECT 1 FROM ingest_runs WHERE source=%s AND batch_id=%s LIMIT 1",
                    (source, batch_id),
                )
                already_logged = cursor.fetchone() is not None
        else:
            cursor.execute(
                "SELECT 1 FROM ingest_runs WHERE source=%s AND started_at >= %s LIMIT 1",
                (source, started_at),
            )
            already_logged = cursor.fetchone() is not None
        if not already_logged:
            cursor.execute(
                """INSERT INTO ingest_runs
                (source,started_at,finished_at,status,rows_written,error_message,details,batch_id)
                VALUES (%s,%s,now(),'failed',0,%s,'{}'::jsonb,%s)""",
                (source, started_at, redact_secrets(f"{type(error).__name__}: {error}")[:4000], batch_id),
            )
    connection.commit()


def run_all(connection: Any, *, today: date | None = None, force_all: bool = False) -> list[dict[str, str]]:
    run_date = today or date.today()
    failures: list[dict[str, str]] = []
    batch_id = str(uuid4())
    batch_started_at = datetime.now(timezone.utc)
    seed_expected_sources(connection, batch_id, batch_started_at)
    token = set_batch_id(batch_id)
    try:
        for source in SOURCES:
            reported = source.reports or (source.name,)
            if not due(source, run_date, force_all):
                finish_pending(
                    connection, batch_id, reported, status="success", message="",
                    details={"skipped": True, "cadence": source.cadence, "run_date": run_date.isoformat()},
                )
                continue
            started_at = datetime.now(timezone.utc)
            print(f"[{source.name}] starting ({source.cadence})", flush=True)
            try:
                source.runner(connection)
            except Exception as exc:
                if hasattr(connection, "rollback"):
                    connection.rollback()
                ensure_attempt_logged(connection, source.name, started_at, exc, batch_id)
                failures.append({"source": source.name, "reason": f"{type(exc).__name__}: {exc}"})
                print(f"[{source.name}] failed: {exc}", file=sys.stderr, flush=True)
            else:
                print(f"[{source.name}] complete", flush=True)
    finally:
        try:
            if hasattr(connection, "rollback"):
                connection.rollback()
            finish_pending(
                connection, batch_id, EXPECTED_SOURCES, status="failed",
                message="Source did not reach a terminal status",
            )
        finally:
            reset_batch_id(token)
    return failures


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is required", file=sys.stderr)
        FAILURES_PATH.write_text(json.dumps([{"source": "database", "reason": "DATABASE_URL is required"}], indent=2))
        return 1

    failures: list[dict[str, str]] = []
    database_failed = False
    try:
        with psycopg.connect(database_url) as connection:
            apply_migrations(connection)
            sync_sector_registry(connection)
            failures = run_all(connection, force_all=os.environ.get("FORCE_ALL") == "1")
    except Exception as exc:
        database_failed = True
        failures.append({"source": "database", "reason": f"{type(exc).__name__}: {exc}"})
        print(f"[database] failed: {exc}", file=sys.stderr)
    FAILURES_PATH.write_text(json.dumps(failures, indent=2) + "\n", encoding="utf-8")
    print(f"Ingest finished with {len(failures)} source failure(s)")
    # Individual source failures are reported through GitHub issues and
    # ingest_runs. Database/lifecycle failures fail CI because reporting cannot
    # be trusted when the connection itself is unavailable.
    return 1 if database_failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
