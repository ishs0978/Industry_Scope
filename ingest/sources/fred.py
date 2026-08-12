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
        result.details = {"invalid_series_dropped": invalid}
