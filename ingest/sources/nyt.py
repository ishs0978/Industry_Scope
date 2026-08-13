"""NYT Archive API with permanent historical-month cache markers."""

from __future__ import annotations

from datetime import date
import hashlib
import os
import time
from typing import Any

import requests

from ingest.registry import Sector, load_sectors
from ingest.sources.common import SourceUnavailable, logged_run, request, upsert_rows


DEFAULT_MAX_MONTHS_PER_RUN = 1


class TokenBucket:
    def __init__(self, interval_seconds: float = 12.5):
        self.interval = interval_seconds
        self.last = 0.0

    def take(self) -> None:
        wait = self.interval - (time.monotonic() - self.last)
        if wait > 0:
            time.sleep(wait)
        self.last = time.monotonic()


def keyword_hits(document: dict[str, Any], sector: Sector) -> int:
    text = " ".join(
        str(document.get(field) or "") for field in ("headline", "abstract", "snippet")
    ).lower()
    return sum(1 for keyword in sector.news_keywords if keyword.lower() in text)


def matching_headlines(documents: list[dict[str, Any]]) -> list[tuple[Any, ...]]:
    rows = []
    sectors = load_sectors()
    for document in documents:
        headline_field = document.get("headline") or {}
        headline = headline_field.get("main") if isinstance(headline_field, dict) else str(headline_field)
        if not headline or not document.get("web_url") or not document.get("pub_date"):
            continue
        search_text = " ".join(
            str(value or "") for value in (headline, document.get("abstract"), document.get("snippet"))
        ).lower()
        matches = sorted(
            (
                (sum(1 for keyword in sector.news_keywords if keyword.lower() in search_text), sector)
                for sector in sectors
            ),
            key=lambda item: -item[0],
        )
        for hits, sector in matches:
            if hits <= 0:
                continue
            source_id = str(document.get("_id") or document["web_url"])
            row_id = hashlib.sha256(f"{source_id}:{sector.slug}".encode()).hexdigest()
            rows.append(
                (
                    row_id, sector.slug, document["pub_date"], "The New York Times", headline,
                    document.get("abstract"), document.get("section_name"), document["web_url"], hits,
                )
            )
    return rows


def completed_archive_months(today: date, cached: set[tuple[int, int]]) -> list[tuple[int, int]]:
    """Return completed NYT archive months, newest first."""
    return [
        (year, month)
        for year in range(today.year, 1972, -1)
        for month in range((today.month if year == today.year else 12), 0, -1)
        if (year, month) < (today.year, today.month) and (year, month) not in cached
    ]


def run(connection: Any) -> None:
    with logged_run(connection, "nyt") as result:
        api_key = os.environ.get("NYT_API_KEY")
        if not api_key:
            raise SourceUnavailable("NYT_API_KEY is not set")
        today = date.today()
        max_months = int(os.environ.get("NYT_MAX_MONTHS_PER_RUN", str(DEFAULT_MAX_MONTHS_PER_RUN)))
        with connection.cursor() as cursor:
            cursor.execute("SELECT year, month FROM nyt_archive_months WHERE historical_complete")
            cached = {(row[0], row[1]) for row in cursor.fetchall()}
        bucket = TokenBucket()
        failures: dict[str, str] = {}
        # The Archive API publishes completed monthly bundles. The current,
        # still-open month returns 403 and belongs to the Article Search API.
        available = completed_archive_months(today, cached)
        selected = available[:max_months]
        for year, month in selected:
            try:
                bucket.take()
                response = request(
                    requests.Session(), "GET",
                    f"https://api.nytimes.com/svc/archive/v1/{year}/{month}.json",
                    params={"api-key": api_key},
                )
                documents = response.json().get("response", {}).get("docs", [])
                rows = matching_headlines(documents)
                result.rows_written += upsert_rows(
                    connection,
                    """INSERT INTO headlines (id,sector_slug,published_date,source,headline,abstract,section,url,relevance_score)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (id) DO UPDATE SET headline=EXCLUDED.headline,abstract=EXCLUDED.abstract,
                    section=EXCLUDED.section,url=EXCLUDED.url,relevance_score=EXCLUDED.relevance_score""",
                    rows,
                )
                with connection.cursor() as cursor:
                    cursor.execute(
                        """INSERT INTO nyt_archive_months (year,month,fetched_at,historical_complete,document_count)
                        VALUES (%s,%s,now(),%s,%s) ON CONFLICT (year,month) DO UPDATE SET
                        fetched_at=EXCLUDED.fetched_at,historical_complete=EXCLUDED.historical_complete,
                        document_count=EXCLUDED.document_count""",
                        (year, month, True, len(documents)),
                    )
                connection.commit()
            except Exception as exc:
                failures[f"{year}-{month:02d}"] = str(exc)
                if getattr(exc, "response", None) is not None and exc.response.status_code in {403, 429}:
                    break
        result.details = {
            "month_errors": failures,
            "months_attempted": [f"{year}-{month:02d}" for year, month in selected],
            "historical_months_remaining": max(0, len(available) - len(selected)),
        }
        if failures:
            raise SourceUnavailable(f"NYT archive failed for {len(failures)} month(s)")
