from ingest.sources.bls import configured_series
from ingest.sources.fred import load_series_map


def test_fred_map_always_includes_common_and_risk_free_series():
    series = load_series_map()
    assert {"VIXCLS", "DTWEXBGS", "DGS3MO"}.issubset(series)
    assert {"DCOILWTICO", "HOUST", "DGS10", "INDPRO"}.issubset(series)


def test_bls_has_employment_and_earnings_for_all_sectors():
    series = configured_series()
    assert len(series) == 40
    assert {item["slug"] for item in series.values()} == {
        "energy", "semiconductors", "ai-robotics", "software-cloud", "cybersecurity",
        "banks", "healthcare-pharma", "defense-aerospace", "homebuilders", "industrials",
        "consumer-discretionary", "consumer-staples", "utilities", "real-estate",
        "materials-mining", "gold-metals", "clean-energy", "uranium-nuclear",
        "communication-services", "transport-shipping",
    }

