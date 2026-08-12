from datetime import date

from ingest.run import ScheduledSource, due


def test_daily_sources_are_always_due():
    source = ScheduledSource("daily", lambda connection: None, "daily")
    assert due(source, date(2026, 8, 12))


def test_weekly_sources_run_on_monday_or_force():
    source = ScheduledSource("weekly", lambda connection: None, "weekly")
    assert due(source, date(2026, 8, 10))
    assert not due(source, date(2026, 8, 12))
    assert due(source, date(2026, 8, 12), force_all=True)

