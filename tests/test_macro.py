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



def test_a_discontinued_series_is_reported_as_stale():
    from datetime import date

    from ingest.sources.fred import is_stale

    today = date(2026, 8, 23)
    # Health expenditure per capita stopped in 2021 and kept its panel looking
    # current, because a dead series returns data rather than an error.
    assert is_stale(date(2021, 1, 1), "Annual", today)
    assert is_stale(None, "Monthly", today)
    # A monthly series reporting July in late August is on time, not stale, and
    # a daily one is allowed a long weekend.
    assert not is_stale(date(2026, 7, 1), "Monthly", today)
    assert not is_stale(date(2026, 8, 20), "Daily", today)
    assert not is_stale(date(2026, 4, 1), "Quarterly", today)
    # An unknown frequency must not be treated as broken on its first day.
    assert not is_stale(date(2026, 8, 1), None, today)
