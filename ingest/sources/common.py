"""Shared source-run logging, HTTP, and database helpers."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
from typing import Any, Iterator

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential


DEFAULT_TIMEOUT = 45


@dataclass
class SourceResult:
    source: str
    rows_written: int = 0
    details: dict[str, Any] = field(default_factory=dict)


class SourceUnavailable(RuntimeError):
    """Raised when a named upstream source cannot provide usable data."""


@retry(
    retry=retry_if_exception_type((requests.RequestException, SourceUnavailable)),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=16),
    reraise=True,
)
def request(
    session: requests.Session,
    method: str,
    url: str,
    **kwargs: Any,
) -> requests.Response:
    response = session.request(method, url, timeout=DEFAULT_TIMEOUT, **kwargs)
    response.raise_for_status()
    return response


@contextmanager
def logged_run(connection: Any, source: str) -> Iterator[SourceResult]:
    """Record success or failure for every source attempt, then re-raise failures."""
    started_at = datetime.now(timezone.utc)
    result = SourceResult(source=source)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ingest_runs (source, started_at, status)
            VALUES (%s, %s, 'running')
            RETURNING id
            """,
            (source, started_at),
        )
        run_id = cursor.fetchone()[0]
    connection.commit()

    try:
        yield result
    except Exception as exc:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE ingest_runs
                SET finished_at = %s,
                    status = 'failed',
                    rows_written = %s,
                    error_message = %s,
                    details = %s::jsonb
                WHERE id = %s
                """,
                (
                    datetime.now(timezone.utc),
                    result.rows_written,
                    f"{type(exc).__name__}: {exc}"[:4000],
                    json.dumps(result.details),
                    run_id,
                ),
            )
        connection.commit()
        raise
    else:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE ingest_runs
                SET finished_at = %s,
                    status = 'success',
                    rows_written = %s,
                    error_message = NULL,
                    details = %s::jsonb
                WHERE id = %s
                """,
                (
                    datetime.now(timezone.utc),
                    result.rows_written,
                    json.dumps(result.details),
                    run_id,
                ),
            )
        connection.commit()


def upsert_rows(
    connection: Any,
    query: str,
    rows: list[tuple[Any, ...]],
    *,
    page_size: int = 1000,
) -> int:
    if not rows:
        return 0
    with connection.cursor() as cursor:
        for start in range(0, len(rows), page_size):
            cursor.executemany(query, rows[start : start + page_size])
    connection.commit()
    return len(rows)

