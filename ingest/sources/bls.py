"""BLS CES employment and earnings series for sector industry mappings."""

from __future__ import annotations

from datetime import date
import os
from typing import Any

import requests

from ingest.registry import load_sectors
from ingest.sources.common import SourceUnavailable, logged_run, request, upsert_rows


# CES eight-digit industry codes. Broad groups are used where BLS does not
# publish a reliable narrow industry series matching the registry NAICS prefix.
CES_INDUSTRY = {
    "energy": "10211000", "semiconductors": "31334400", "ai-robotics": "31333000",
    "software-cloud": "50513000", "cybersecurity": "60541500", "banks": "55522100",
    "healthcare-pharma": "65620000", "defense-aerospace": "31336400",
    "homebuilders": "20236100", "industrials": "30000000",
    "consumer-discretionary": "42000000", "consumer-staples": "41445000",
    "utilities": "44220000", "real-estate": "55530000", "materials-mining": "10000000",
    "gold-metals": "10212000", "clean-energy": "44221100", "uranium-nuclear": "44221100",
    "communication-services": "50517000", "transport-shipping": "43000000",
}


def configured_series() -> dict[str, dict[str, str]]:
    naics = {sector.slug: sector.naics_code for sector in load_sectors()}
    result: dict[str, dict[str, str]] = {}
    for slug, industry in CES_INDUSTRY.items():
        for measure, suffix, label, units in (
            ("employment", "01", "Employment", "Thousands of Persons"),
            ("earnings", "03", "Average Hourly Earnings", "Dollars per Hour"),
        ):
            series_id = f"CEU{industry}{suffix}"
            storage_id = f"BLS:{slug}:{series_id}"
            result[storage_id] = {
                "slug": slug, "naics": naics[slug], "measure": measure,
                "label": f"{slug.replace('-', ' ').title()} {label}", "units": units,
                "api_series_id": series_id,
            }
    return result


def _period_date(year: str, period: str) -> date | None:
    if not period.startswith("M") or period == "M13":
        return None
    return date(int(year), int(period[1:]), 1)


def run(connection: Any) -> None:
    api_key = os.environ.get("BLS_API_KEY")
    if not api_key:
        raise SourceUnavailable("BLS_API_KEY is not set")
    series = configured_series()
    current_year = date.today().year
    with logged_run(connection, "bls") as result:
        failures: dict[str, str] = {}
        api_to_configs: dict[str, list[tuple[str, dict[str, str]]]] = {}
        for storage_id, config in series.items():
            api_to_configs.setdefault(config["api_series_id"], []).append((storage_id, config))
        items = list(api_to_configs.items())
        for start in range(0, len(items), 25):
            batch = dict(items[start : start + 25])
            body: dict[str, Any] = {
                "seriesid": list(batch), "startyear": str(current_year - 20),
                "endyear": str(current_year), "calculations": False,
            }
            body["registrationkey"] = api_key
            response = request(
                requests.Session(), "POST", "https://api.bls.gov/publicAPI/v2/timeseries/data/", json=body,
            )
            payload = response.json()
            if payload.get("status") != "REQUEST_SUCCEEDED":
                raise SourceUnavailable(f"BLS API: {'; '.join(payload.get('message', []))}")
            for item in payload.get("Results", {}).get("series", []):
                series_id = item["seriesID"]
                rows = []
                for observation in item.get("data", []):
                    observation_date = _period_date(observation["year"], observation["period"])
                    if observation_date:
                        rows.append((series_id, observation_date, float(observation["value"])))
                if not rows:
                    failures[series_id] = "BLS returned no usable observations"
                    continue
                for storage_id, config in batch[series_id]:
                    storage_rows = [(storage_id, row[1], row[2]) for row in rows]
                    result.rows_written += upsert_rows(
                        connection,
                        """INSERT INTO macro_series (series_id, date, value) VALUES (%s, %s, %s)
                        ON CONFLICT (series_id, date) DO UPDATE SET value=EXCLUDED.value""",
                        storage_rows,
                    )
                    with connection.cursor() as cursor:
                        cursor.execute(
                            """INSERT INTO macro_meta (series_id,label,units,frequency,source,last_release_date,as_of)
                            VALUES (%s,%s,%s,'Monthly','BLS',%s,now())
                            ON CONFLICT (series_id) DO UPDATE SET label=EXCLUDED.label,units=EXCLUDED.units,
                            frequency=EXCLUDED.frequency,source=EXCLUDED.source,
                            last_release_date=EXCLUDED.last_release_date,as_of=EXCLUDED.as_of""",
                            (storage_id, config["label"], config["units"], max(row[1] for row in storage_rows)),
                        )
                    connection.commit()
        result.details = {"series_errors": failures, "api_key_used": bool(api_key)}
        if failures:
            raise SourceUnavailable(f"BLS returned no data for {len(failures)} series")
