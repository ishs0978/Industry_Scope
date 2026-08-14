"""GDELT DOC 2.0 volume and tone timelines."""

from __future__ import annotations

from datetime import date, datetime, timedelta
import os
from typing import Any

import requests

from ingest.registry import Sector, load_sectors
from ingest.sources.common import (
    RateLimiter, SourceUnavailable, logged_run, request_with_backoff, upsert_rows,
)


# GDELT publishes no formal limit; five seconds between calls is the widely used
# convention. Two calls per sector across 20 sectors is roughly 200 seconds,
# well inside the workflow timeout.
GDELT_MIN_INTERVAL_SECONDS = float(os.environ.get("GDELT_MIN_INTERVAL_SECONDS", "5"))


class GdeltUnavailable(SourceUnavailable):
    """The shared endpoint is refusing work, rather than one sector failing."""


def query_for_sector(sector: Sector) -> str:
    return " OR ".join(f'"{keyword}"' for keyword in sector.news_keywords)


def rotated_sectors(sectors: list[Sector], day_of_year: int) -> list[Sector]:
    """Rotate the iteration order so the same sectors are not always starved.

    One 429 sets upstream_blocked and defers every sector after it. The order was
    fixed, so the sectors near the front always got data and the ones at the back
    never did. Rotating by day of year moves the starvation around until every
    sector eventually fills.
    """
    if not sectors:
        return []
    offset = day_of_year % len(sectors)
    return sectors[offset:] + sectors[:offset]


def _parse_timeline(payload: dict[str, Any]) -> dict[str, float]:
    output: dict[str, float] = {}
    for timeline in payload.get("timeline", []):
        for item in timeline.get("data", []):
            timestamp = item.get("date")
            value = item.get("value")
            if timestamp and value is not None:
                parsed = datetime.strptime(timestamp[:8], "%Y%m%d").date().isoformat()
                output[parsed] = float(value)
    return output


def fetch_mode(
    session: requests.Session,
    sector: Sector,
    mode: str,
    start: date,
    end: date,
    limiter: RateLimiter | None = None,
) -> dict[str, float]:
    response = request_with_backoff(
        session,
        "GET",
        "https://api.gdeltproject.org/api/v2/doc/doc",
        limiter=limiter,
        params={
            "query": query_for_sector(sector), "mode": mode, "format": "json",
            "startdatetime": start.strftime("%Y%m%d000000"),
            "enddatetime": end.strftime("%Y%m%d235959"), "timelinesmooth": 0,
        },
    )
    try:
        payload = response.json()
    except ValueError as exc:
        # GDELT answers with HTML when it is unhappy. Capture the body: a rate
        # limit and a malformed or over-long OR query fail identically here and
        # need different fixes.
        snippet = " ".join(response.text[:200].split())
        raise GdeltUnavailable(
            f"GDELT returned non-JSON (HTTP {response.status_code}): {snippet}"
        ) from exc
    return _parse_timeline(payload)


def run(connection: Any) -> None:
    session = requests.Session()
    today = date.today()
    with logged_run(connection, "gdelt") as result:
        failures: dict[str, str] = {}
        backlog: dict[str, str] = {}
        upstream_blocked = False
        max_ranges = int(os.environ.get("GDELT_MAX_RANGES_PER_SECTOR", "1"))
        limiter = RateLimiter(requests_per_second=1 / GDELT_MIN_INTERVAL_SECONDS)
        sectors = load_sectors()
        start_offset = today.timetuple().tm_yday % len(sectors) if sectors else 0
        for sector in rotated_sectors(sectors, today.timetuple().tm_yday):
            if upstream_blocked:
                backlog[sector.slug] = "upstream unavailable; deferred"
                continue
            with connection.cursor() as cursor:
                cursor.execute("SELECT max(date) FROM news_volume WHERE sector_slug=%s", (sector.slug,))
                latest = cursor.fetchone()[0]
            start = latest + timedelta(days=1) if latest else today - timedelta(days=89)
            rows = []
            ranges = 0
            while start <= today:
                if ranges >= max_ranges:
                    backlog[sector.slug] = start.isoformat()
                    break
                end = min(start + timedelta(days=89), today)
                try:
                    volume = fetch_mode(session, sector, "timelinevolraw", start, end, limiter)
                    tone = fetch_mode(session, sector, "timelinetone", start, end, limiter)
                    for day in sorted(set(volume) | set(tone)):
                        rows.append((sector.slug, day, volume.get(day), tone.get(day)))
                except Exception as exc:
                    failures[f"{sector.slug}:{start}:{end}"] = str(exc)
                    response = getattr(exc, "response", None)
                    # A 429 that survived four backed-off attempts, or a body
                    # that will not decode as JSON, applies to the shared GDELT
                    # endpoint rather than one sector. Stop hammering it and let
                    # the next run retry from a rotated starting point.
                    if getattr(response, "status_code", None) == 429 or isinstance(
                        exc, (GdeltUnavailable, ValueError, requests.exceptions.JSONDecodeError)
                    ):
                        upstream_blocked = True
                    break
                start = end + timedelta(days=1)
                ranges += 1
            result.rows_written += upsert_rows(
                connection,
                """INSERT INTO news_volume (sector_slug,date,article_volume,avg_tone)
                VALUES (%s,%s,%s,%s) ON CONFLICT (sector_slug,date) DO UPDATE SET
                article_volume=EXCLUDED.article_volume,avg_tone=EXCLUDED.avg_tone""",
                rows,
            )
        result.details = {
            "range_errors": failures,
            "backfill_resumes_at": backlog,
            "start_offset": start_offset,
            "sector_count": len(sectors),
            "min_interval_seconds": GDELT_MIN_INTERVAL_SECONDS,
        }
        if failures:
            raise SourceUnavailable(f"GDELT failed for {len(failures)} sector ranges")
