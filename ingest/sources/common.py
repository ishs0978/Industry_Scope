"""Shared source-run logging, HTTP, and database helpers."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import random
import re
import time
from typing import Any, Iterator

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential


DEFAULT_TIMEOUT = 45
# 429 plus the transient 5xx family. Everything else is a real answer.
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})
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


class RateLimiter:
    """Minimum spacing between requests to one upstream host."""

    def __init__(self, requests_per_second: float = 9.5):
        self.minimum_interval = 1 / requests_per_second
        self.last_request = 0.0

    def wait(self) -> None:
        elapsed = time.monotonic() - self.last_request
        if elapsed < self.minimum_interval:
            time.sleep(self.minimum_interval - elapsed)
        self.last_request = time.monotonic()


def _backoff_delay(attempt: int, base_delay: float, max_delay: float) -> float:
    # Exponential with full jitter, so retries do not resynchronize.
    ceiling = min(max_delay, base_delay * (2**attempt))
    return random.uniform(0, ceiling)


def _retry_delay(
    response: requests.Response, attempt: int, base_delay: float, max_delay: float
) -> float:
    header = response.headers.get("Retry-After")
    if header:
        try:
            return min(max_delay, float(header))
        except ValueError:
            pass
    return _backoff_delay(attempt, base_delay, max_delay)


def request_with_backoff(
    session: requests.Session,
    method: str,
    url: str,
    *,
    limiter: RateLimiter | None = None,
    attempts: int = 4,
    base_delay: float = 2.0,
    max_delay: float = 30.0,
    sleep: Any = time.sleep,
    **kwargs: Any,
) -> requests.Response:
    """Throttled request that retries 429 and 5xx before giving up.

    `request` has no throttle and raises on the first non-2xx, which is why a
    rate-limited endpoint fails immediately rather than slowing down. Pass a
    limiter to space calls out; a 429 from an aggressive API is expected
    behaviour, not bad luck.
    """
    kwargs.setdefault("timeout", DEFAULT_TIMEOUT)
    last_error: Exception | None = None
    last_response: requests.Response | None = None
    for attempt in range(attempts):
        if limiter is not None:
            limiter.wait()
        try:
            response = session.request(method, url, **kwargs)
        except requests.RequestException as exc:
            last_error, last_response = exc, None
            delay = _backoff_delay(attempt, base_delay, max_delay)
        else:
            if response.status_code not in RETRYABLE_STATUS:
                response.raise_for_status()
                return response
            last_response = response
            last_error = None
            delay = _retry_delay(response, attempt, base_delay, max_delay)
        if attempt + 1 < attempts:
            sleep(delay)
    # Raising through raise_for_status keeps the response on the exception, so
    # callers can still distinguish a 429 from a transport error.
    if last_response is not None:
        last_response.raise_for_status()
    raise last_error if last_error else SourceUnavailable(f"{url} could not be reached")


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
