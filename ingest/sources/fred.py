"""FRED observations and release metadata."""

from __future__ import annotations

from datetime import date, datetime
import os
from pathlib import Path
from typing import Any

import requests
import yaml

from ingest.sources.common import SourceUnavailable, logged_run, request, upsert_rows


FRED_API = "https://api.stlouisfed.org/fred"
MAP_PATH = Path(__file__).parents[1] / "config" / "fred_map.yaml"


def load_series_map(path: Path = MAP_PATH) -> dict[str, dict[str, str]]:
    with path.open(encoding="utf-8") as source:
        config = yaml.safe_load(source)
    unique: dict[str, dict[str, str]] = {}
    for entry in config.get("common", []) + config.get("risk_free", []):
        unique[entry["series_id"]] = entry
    for entries in config.get("sectors", {}).values():
        for entry in entries:
            unique[entry["series_id"]] = entry
    return unique


# How often each kind of series publishes. FRED spells the frequency with a
# qualifier attached, "Daily, 7-Day" and "Weekly, Ending Monday", so the leading
# word is what identifies it.
PUBLICATION_INTERVAL_DAYS = {
    "daily": 1, "weekly": 7, "biweekly": 14, "monthly": 31,
    "quarterly": 92, "semiannual": 183, "annual": 366, "annually": 366,
}
DEFAULT_INTERVAL_DAYS = 92
# A late publication is one missed release; two is a series that has stopped.
# The grace period is scaled so a daily series is not judged over a long
# weekend and an annual one is not given two years to prove it is dead.
MIN_GRACE_DAYS = 13


def publication_interval(frequency: str | None) -> int:
    """How many days apart this series' releases are meant to be."""
    leading = (frequency or "").strip().lower().split(",")[0].split()[0] if (frequency or "").strip() else ""
    return PUBLICATION_INTERVAL_DAYS.get(leading, DEFAULT_INTERVAL_DAYS)


def is_stale(
    newest: date | None,
    frequency: str | None,
    today: date,
    *,
    last_release: date | None = None,
) -> bool:
    """Whether a series has stopped being updated.

    Judged on when the publisher last touched it, not on how far behind its
    newest observation sits. Those are different questions and only the first
    one is about staleness: the industrial-production detail series runs three
    months behind by design and is published on time every month, and an
    observation-age test called five such series stale on a run where all five
    were current. Every live series here was released within 27 days; the
    discontinued one had not been touched for 597.

    Observation age is the fallback for a source that reports no release date.
    """
    if newest is None:
        return True
    interval = publication_interval(frequency)
    allowance = interval + max(MIN_GRACE_DAYS, interval // 4)
    if last_release is not None:
        return (today - last_release).days > allowance
    return (today - newest).days > interval + allowance


def validate_series(session: requests.Session, api_key: str, series_id: str) -> dict[str, Any] | None:
    response = session.get(
        f"{FRED_API}/series",
        params={"series_id": series_id, "api_key": api_key, "file_type": "json"},
        timeout=45,
    )
    if response.status_code in {400, 404}:
        return None
    response.raise_for_status()
    series = response.json().get("seriess", [])
    return series[0] if series else None


def fetch_observations(session: requests.Session, api_key: str, series_id: str) -> list[dict[str, Any]]:
    response = request(
        session,
        "GET",
        f"{FRED_API}/series/observations",
        params={
            "series_id": series_id,
            "api_key": api_key,
            "file_type": "json",
            "observation_start": "1900-01-01",
        },
    )
    return response.json().get("observations", [])


def run(connection: Any) -> None:
    with logged_run(connection, "fred") as result:
        api_key = os.environ.get("FRED_API_KEY")
        if not api_key:
            raise SourceUnavailable("FRED_API_KEY is not set")
        session = requests.Session()
        invalid: list[str] = []
        stale: dict[str, str] = {}
        configured_ids = set(load_series_map())
        for series_id, configured in load_series_map().items():
            metadata = validate_series(session, api_key, series_id)
            if metadata is None:
                invalid.append(series_id)
                continue
            observations = fetch_observations(session, api_key, series_id)
            rows = [
                (series_id, date.fromisoformat(item["date"]), float(item["value"]))
                for item in observations
                if item.get("value") not in {None, "."}
            ]
            result.rows_written += upsert_rows(
                connection,
                """
                INSERT INTO macro_series (series_id, date, value) VALUES (%s, %s, %s)
                ON CONFLICT (series_id, date) DO UPDATE SET value = EXCLUDED.value
                """,
                rows,
            )
            realtime_start = max(
                (date.fromisoformat(item["realtime_start"]) for item in observations if item.get("realtime_start")),
                default=None,
            )
            last_updated = metadata.get("last_updated")
            last_release = datetime.fromisoformat(last_updated.replace("Z", "+00:00")).date() if last_updated else None
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO macro_meta (
                        series_id, label, units, frequency, source,
                        last_release_date, realtime_start, as_of
                    ) VALUES (%s, %s, %s, %s, 'FRED', %s, %s, now())
                    ON CONFLICT (series_id) DO UPDATE SET
                        label = EXCLUDED.label, units = EXCLUDED.units,
                        frequency = EXCLUDED.frequency, source = EXCLUDED.source,
                        last_release_date = EXCLUDED.last_release_date,
                        realtime_start = EXCLUDED.realtime_start, as_of = EXCLUDED.as_of
                    """,
                    (
                        series_id,
                        metadata.get("title") or configured["label"],
                        metadata.get("units") or configured.get("units"),
                        metadata.get("frequency") or configured.get("frequency"),
                        last_release,
                        realtime_start,
                    ),
                )
            connection.commit()
            newest = max((date.fromisoformat(item["date"]) for item in observations
                          if item.get("date")), default=None)
            frequency = metadata.get("frequency") or configured.get("frequency")
            if is_stale(newest, frequency, date.today(), last_release=last_release):
                stale[series_id] = newest.isoformat() if newest else "no observations"

        # A series swapped out of the config keeps its rows and its panel unless
        # something removes them, so the page went on showing the series the
        # config no longer names.
        removed: list[str] = []
        with connection.cursor() as cursor:
            cursor.execute("SELECT series_id FROM macro_meta WHERE source = 'FRED'")
            removed = [row[0] for row in cursor.fetchall() if row[0] not in configured_ids]
            if removed:
                cursor.execute("DELETE FROM macro_series WHERE series_id = ANY(%s)", (removed,))
                cursor.execute("DELETE FROM macro_meta WHERE series_id = ANY(%s)", (removed,))
        connection.commit()

        result.details = {
            "invalid_series_dropped": invalid,
            "unconfigured_series_removed": removed,
            "stale_series": stale,
        }
