from datetime import date

from datetime import datetime, timezone

import ingest.run as orchestrator
from ingest.run import EXPECTED_SOURCES, ScheduledSource, due, finish_pending, seed_expected_sources
from ingest.sources.common import redact_secrets


class ElapsedCursor:
    def __init__(self, elapsed_days):
        self.elapsed_days = elapsed_days
        self.queries = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def execute(self, query, params=None):
        self.queries.append(query)

    def fetchone(self):
        return (self.elapsed_days,)


class ElapsedConnection:
    """Stands in for a database that last succeeded `elapsed_days` ago."""

    def __init__(self, elapsed_days):
        self.cursors = []
        self.elapsed_days = elapsed_days

    def cursor(self):
        cursor = ElapsedCursor(self.elapsed_days)
        self.cursors.append(cursor)
        return cursor


def test_daily_sources_are_always_due():
    source = ScheduledSource("daily", lambda connection: None, "daily")
    assert due(source, ElapsedConnection(0))


def test_weekly_sources_are_due_a_week_after_their_last_success():
    source = ScheduledSource("weekly", lambda connection: None, "weekly")
    assert not due(source, ElapsedConnection(6.2))
    assert due(source, ElapsedConnection(7.0))
    assert due(source, ElapsedConnection(31.0))


def test_weekly_sources_catch_up_after_a_missed_slot():
    # The old weekday check meant a missed Monday waited a full week with no
    # retry. Elapsed time since the last success has to drive this instead.
    source = ScheduledSource("weekly", lambda connection: None, "weekly")
    assert due(source, ElapsedConnection(8.5))


def test_weekly_source_that_never_succeeded_is_due():
    source = ScheduledSource("weekly", lambda connection: None, "weekly")
    assert due(source, ElapsedConnection(None))


def test_force_all_overrides_cadence():
    source = ScheduledSource("weekly", lambda connection: None, "weekly")
    assert due(source, ElapsedConnection(0.0), force_all=True)


def test_due_ignores_runs_that_were_only_skipped():
    # A skipped source is recorded as a success with details.skipped, so the
    # lookup must exclude those or a weekly source never comes due again.
    source = ScheduledSource("weekly", lambda connection: None, "weekly")
    connection = ElapsedConnection(9.0)
    due(source, connection)
    assert "skipped" in connection.cursors[0].queries[0]


class LifecycleCursor:
    def __init__(self, rows):
        self.rows = rows

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def executemany(self, query, values):
        for source, started_at, batch_id in values:
            self.rows.append({
                "source": source, "started_at": started_at, "batch_id": batch_id,
                "status": "pending", "finished_at": None,
            })

    def execute(self, query, params):
        status, _error, _details, batch_id, sources = params
        for row in self.rows:
            if row["batch_id"] == batch_id and row["source"] in sources and row["status"] == "pending":
                row["status"] = status
                row["finished_at"] = datetime.now(timezone.utc)


class LifecycleConnection:
    def __init__(self):
        self.rows = []

    def cursor(self):
        return LifecycleCursor(self.rows)

    def commit(self):
        pass


def test_all_expected_sources_reported():
    connection = LifecycleConnection()
    batch_id = "qa-batch"
    seed_expected_sources(connection, batch_id, datetime(2026, 8, 12, tzinfo=timezone.utc))
    for source in EXPECTED_SOURCES:
        finish_pending(connection, batch_id, (source,), status="success", message="")

    latest = {row["source"]: row for row in connection.rows}
    assert set(latest) == set(EXPECTED_SOURCES)
    assert all(row["status"] not in {"running", "pending"} for row in latest.values())


def test_ingest_errors_redact_api_credentials():
    assert redact_secrets("https://example.test?api_key=secret&x=1") == "https://example.test?api_key=[REDACTED]&x=1"
    assert redact_secrets(
        '{"error": "https://example.test?api-key=secret", "months_attempted": []}'
    ) == '{"error": "https://example.test?api-key=[REDACTED]", "months_attempted": []}'


def test_source_failure_rolls_back_before_logging_and_continues(monkeypatch):
    calls = []

    class Connection:
        def rollback(self):
            calls.append("rollback")

    def broken(connection):
        calls.append("broken")
        raise RuntimeError("transaction aborted")

    def healthy(connection):
        calls.append("healthy")

    monkeypatch.setattr(
        orchestrator,
        "SOURCES",
        (ScheduledSource("broken", broken, "daily"), ScheduledSource("healthy", healthy, "daily")),
    )
    monkeypatch.setattr(orchestrator, "seed_expected_sources", lambda *args: None)
    monkeypatch.setattr(orchestrator, "finish_pending", lambda *args, **kwargs: None)

    def record_failure(connection, source, started_at, error, batch_id=None):
        assert calls[-1] == "rollback"
        calls.append(f"logged:{source}")

    monkeypatch.setattr(orchestrator, "ensure_attempt_logged", record_failure)

    failures = orchestrator.run_all(Connection(), today=date(2026, 8, 12), force_all=True)

    assert failures == [{"source": "broken", "reason": "RuntimeError: transaction aborted"}]
    assert calls[:4] == ["broken", "rollback", "logged:broken", "healthy"]
