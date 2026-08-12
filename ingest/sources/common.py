"""Shared source-run logging, HTTP, and database helpers."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import re
from typing import Any, Iterator

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential


DEFAULT_TIMEOUT = 45
CURRENT_BATCH_ID: ContextVar[str | None] = ContextVar("ingest_batch_id", default=None)
# Stop at URL separators and at string delimiters. Error details are serialized
# to JSON before redaction, so consuming a closing quote would corrupt the JSON
# persisted to ingest_runs and mask the original source failure.
SECRET_QUERY = re.compile(r"([?&](?:api_key|api-key|registrationkey)=)[^&\s\"']+", re.IGNORECASE)


@dataclass
class SourceResult:
    source: str
    rows_written: int = 0
    details: dict[str, Any] = field(default_factory=dict)


class SourceUnavailable(RuntimeError):
    """Raised when a named upstream source cannot provide usable data."""


def set_batch_id(batch_id: str) -> Token[str | None]:
    return CURRENT_BATCH_ID.set(batch_id)


def reset_batch_id(token: Token[str | None]) -> None:
    CURRENT_BATCH_ID.reset(token)


def redact_secrets(value: str) -> str:
    return SECRET_QUERY.sub(r"\1[REDACTED]", value)


def safe_details(value: dict[str, Any]) -> str:
    return redact_secrets(json.dumps(value))


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
    kwargs.setdefault("timeout", DEFAULT_TIMEOUT)
    response = session.request(method, url, **kwargs)
    response.raise_for_status()
    return response


@contextmanager
def logged_run(connection: Any, source: str) -> Iterator[SourceResult]:
    """Record success or failure for every source attempt, then re-raise failures."""
    started_at = datetime.now(timezone.utc)
    result = SourceResult(source=source)
    batch_id = CURRENT_BATCH_ID.get()
    with connection.cursor() as cursor:
        run_id = None
        if batch_id:
            cursor.execute(
                """
                UPDATE ingest_runs
                SET started_at = %s, status = 'running'
                WHERE id = (
                    SELECT id FROM ingest_runs
                    WHERE source = %s AND batch_id = %s AND status = 'pending'
                    ORDER BY id DESC LIMIT 1
                )
                RETURNING id
                """,
                (started_at, source, batch_id),
            )
            row = cursor.fetchone()
            run_id = row[0] if row else None
        if run_id is None:
            cursor.execute(
                """
                INSERT INTO ingest_runs (source, started_at, status, batch_id)
                VALUES (%s, %s, 'running', %s)
                RETURNING id
                """,
                (source, started_at, batch_id),
            )
            run_id = cursor.fetchone()[0]
    connection.commit()

    try:
        yield result
    except Exception as exc:
        # Clear any aborted transaction before attempting to record the failure.
        if hasattr(connection, "rollback"):
            connection.rollback()
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
                    redact_secrets(f"{type(exc).__name__}: {exc}")[:4000],
                    safe_details(result.details),
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
                    safe_details(result.details),
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
