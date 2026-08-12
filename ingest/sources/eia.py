"""Energy-sector operating indicators from EIA API v2."""

from __future__ import annotations

from datetime import date
import os
from typing import Any

import requests

from ingest.sources.common import SourceUnavailable, logged_run, request, upsert_rows


EIA_SERIES = (
    {"route": "petroleum/stoc/wstk", "series": "WCESTUS1", "label": "U.S. Crude Oil Inventories", "units": "Thousand Barrels"},
    {"route": "petroleum/crd/crpdn", "series": "WCRFPUS2", "label": "U.S. Field Production of Crude Oil", "units": "Thousand Barrels per Day"},
    {"route": "petroleum/pnp/wiup", "series": "WPULEUS3", "label": "U.S. Refinery Utilization", "units": "Percent"},
)


def fetch_series(session: requests.Session, api_key: str, config: dict[str, str]) -> list[dict[str, Any]]:
    response = request(
        session,
        "GET",
        f"https://api.eia.gov/v2/{config['route']}/data/",
        params=[
            ("api_key", api_key), ("frequency", "weekly"), ("data[0]", "value"),
            ("facets[series][]", config["series"]), ("sort[0][column]", "period"),
            ("sort[0][direction]", "asc"), ("length", "5000"),
        ],
    )
    payload = response.json()
    if payload.get("error"):
        raise SourceUnavailable(f"EIA {config['series']}: {payload['error']}")
    return payload.get("response", {}).get("data", [])


def run(connection: Any) -> None:
    api_key = os.environ.get("EIA_API_KEY")
    if not api_key:
        raise SourceUnavailable("EIA_API_KEY is not set")
    session = requests.Session()
    with logged_run(connection, "eia") as result:
        failures: dict[str, str] = {}
        for config in EIA_SERIES:
            series_id = f"EIA:{config['series']}"
            try:
                data = fetch_series(session, api_key, config)
                rows = [
                    (series_id, date.fromisoformat(item["period"]), float(item["value"]))
                    for item in data if item.get("value") not in {None, ""}
                ]
                result.rows_written += upsert_rows(
                    connection,
                    """INSERT INTO macro_series (series_id, date, value) VALUES (%s, %s, %s)
                    ON CONFLICT (series_id, date) DO UPDATE SET value = EXCLUDED.value""",
                    rows,
                )
                with connection.cursor() as cursor:
                    cursor.execute(
                        """INSERT INTO macro_meta (series_id, label, units, frequency, source, last_release_date, as_of)
                        VALUES (%s, %s, %s, 'Weekly', 'EIA', %s, now())
                        ON CONFLICT (series_id) DO UPDATE SET label=EXCLUDED.label, units=EXCLUDED.units,
                        frequency=EXCLUDED.frequency, source=EXCLUDED.source,
                        last_release_date=EXCLUDED.last_release_date, as_of=EXCLUDED.as_of""",
                        (series_id, config["label"], config["units"], rows[-1][1] if rows else None),
                    )
                connection.commit()
            except Exception as exc:
                failures[series_id] = str(exc)
        result.details = {"series_errors": failures, "rig_counts": "Unavailable from EIA v2; no value stored"}
        if failures:
            raise SourceUnavailable(f"EIA failed for {len(failures)} series")

