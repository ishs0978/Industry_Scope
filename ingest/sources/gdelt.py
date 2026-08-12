"""GDELT DOC 2.0 volume and tone timelines."""

from __future__ import annotations

from datetime import date, datetime, timedelta
import os
from typing import Any

import requests

from ingest.registry import Sector, load_sectors
from ingest.sources.common import SourceUnavailable, logged_run, request, upsert_rows


def query_for_sector(sector: Sector) -> str:
    return " OR ".join(f'"{keyword}"' for keyword in sector.news_keywords)


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


def fetch_mode(session: requests.Session, sector: Sector, mode: str, start: date, end: date) -> dict[str, float]:
    response = request(
        session,
        "GET",
        "https://api.gdeltproject.org/api/v2/doc/doc",
        params={
            "query": query_for_sector(sector), "mode": mode, "format": "json",
            "startdatetime": start.strftime("%Y%m%d000000"),
            "enddatetime": end.strftime("%Y%m%d235959"), "timelinesmooth": 0,
        },
    )
    return _parse_timeline(response.json())


def run(connection: Any) -> None:
    session = requests.Session()
    today = date.today()
    with logged_run(connection, "gdelt") as result:
        failures: dict[str, str] = {}
        backlog: dict[str, str] = {}
        max_ranges = int(os.environ.get("GDELT_MAX_RANGES_PER_SECTOR", "1"))
        for sector in load_sectors():
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
                    volume = fetch_mode(session, sector, "timelinevolraw", start, end)
                    tone = fetch_mode(session, sector, "timelinetone", start, end)
                    for day in sorted(set(volume) | set(tone)):
                        rows.append((sector.slug, day, volume.get(day), tone.get(day)))
                except Exception as exc:
                    failures[f"{sector.slug}:{start}:{end}"] = str(exc)
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
        result.details = {"range_errors": failures, "backfill_resumes_at": backlog}
        if failures:
            raise SourceUnavailable(f"GDELT failed for {len(failures)} sector ranges")
