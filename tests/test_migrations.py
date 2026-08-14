from pathlib import Path
import re

from ingest.db import migration_files, sync_sector_registry


EXPECTED_TABLES = {
    "sectors",
    "prices",
    "etf_meta",
    "holdings",
    "macro_series",
    "macro_meta",
    "company_facts",
    "form_d",
    "headlines",
    "news_volume",
    "events",
    "ingest_runs",
}


def test_migrations_are_ordered_and_versioned():
    files = migration_files()
    assert [path.name for path in files] == [
        "0001_initial_schema.sql",
        "0002_query_indexes.sql",
        "0003_source_observability.sql",
        "0004_macro_release_metadata.sql",
        "0005_sec_news_support.sql",
        "0006_ingest_batch_lifecycle.sql",
        "0007_form_d_submission_type.sql",
    ]


def test_initial_migration_defines_every_required_table():
    initial = Path("ingest/migrations/0001_initial_schema.sql").read_text()
    actual = set(re.findall(r"CREATE TABLE ([a-z_]+)", initial))
    assert actual == EXPECTED_TABLES


def test_ingest_runs_tracks_every_attempt_state_and_error():
    initial = Path("ingest/migrations/0001_initial_schema.sql").read_text()
    ingest_runs = initial.split("CREATE TABLE ingest_runs", 1)[1]
    for column in (
        "source",
        "started_at",
        "finished_at",
        "status",
        "rows_written",
        "error_message",
    ):
        assert re.search(rf"\b{column}\b", ingest_runs)


class RecordingCursor:
    def __init__(self):
        self.query = ""
        self.rows = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def executemany(self, query, rows):
        self.query = query
        self.rows = rows


class RecordingConnection:
    def __init__(self):
        self.recording_cursor = RecordingCursor()
        self.commits = 0

    def cursor(self):
        return self.recording_cursor

    def commit(self):
        self.commits += 1


def test_sector_registry_sync_upserts_all_21_rows():
    connection = RecordingConnection()
    count = sync_sector_registry(connection)

    assert count == 21
    assert len(connection.recording_cursor.rows) == 21
    assert "ON CONFLICT (slug) DO UPDATE" in connection.recording_cursor.query
    assert connection.commits == 1
