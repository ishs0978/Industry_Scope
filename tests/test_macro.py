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
    # current, because a dead series returns data rather than an error. FRED
    # had not touched it in 597 days while every live series was inside 27.
    assert is_stale(date(2021, 1, 1), "Annual", today, last_release=date(2024, 1, 5))
    assert is_stale(None, "Monthly", today)
    # A monthly series reporting July in late August is on time, not stale, and
    # a daily one is allowed a long weekend.
    assert not is_stale(date(2026, 7, 1), "Monthly", today, last_release=date(2026, 8, 12))
    assert not is_stale(date(2026, 8, 20), "Daily", today, last_release=date(2026, 8, 21))
    assert not is_stale(date(2026, 4, 1), "Quarterly", today, last_release=date(2026, 7, 30))
    # An unknown frequency must not be treated as broken on its first day.
    assert not is_stale(date(2026, 8, 1), None, today, last_release=date(2026, 8, 1))


def test_a_series_that_runs_months_behind_on_purpose_is_not_stale():
    """Publication lag and staleness are different questions.

    Judged on how old its newest observation was, this check called five current
    series stale in one run. The industrial-production detail series publishes
    three months in arrears and Case-Shiller two, every month, on time.
    """
    from datetime import date

    from ingest.sources.fred import is_stale

    today = date(2026, 8, 24)
    # Real rows from the run that produced the false alarms.
    for newest, released in (
        (date(2026, 5, 1), date(2026, 8, 18)),   # IPN221114T8S, 109 days behind
        (date(2026, 5, 1), date(2026, 7, 28)),   # CSUSHPINSA, published monthly
        (date(2026, 6, 1), date(2026, 7, 31)),   # UMCSENT
        (date(2026, 5, 1), date(2026, 8, 3)),    # TSIFRGHT
    ):
        assert not is_stale(newest, "Monthly", today, last_release=released)
    # A quarterly series 120 days behind its own newest quarter is normal too.
    assert not is_stale(date(2026, 4, 1), "Quarterly", today, last_release=date(2026, 7, 30))


def test_frequency_is_read_from_the_qualifier_fred_actually_sends():
    """FRED writes "Daily, 7-Day", not "Daily".

    An exact-match lookup missed every qualified frequency and handed those
    series the fallback allowance, so a daily series frozen for a year passed.
    """
    from datetime import date

    from ingest.sources.fred import is_stale, publication_interval

    assert publication_interval("Daily, 7-Day") == 1
    assert publication_interval("Weekly, Ending Monday") == 7
    assert publication_interval("Daily, Close") == 1
    assert publication_interval("Monthly") == 31
    # Unknown or absent frequency falls back rather than raising.
    assert publication_interval(None) == publication_interval("")

    today = date(2026, 8, 24)
    assert is_stale(date(2025, 8, 20), "Daily, Close", today, last_release=date(2025, 8, 21))
    assert not is_stale(date(2026, 8, 20), "Daily, Close", today, last_release=date(2026, 8, 21))


def test_observation_age_is_the_fallback_when_no_release_date_exists():
    """A source that publishes no release date still has to be checked."""
    from datetime import date

    from ingest.sources.fred import is_stale

    today = date(2026, 8, 24)
    assert not is_stale(date(2026, 7, 1), "Monthly", today)
    assert is_stale(date(2021, 1, 1), "Annual", today)
