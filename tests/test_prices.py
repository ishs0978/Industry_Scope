from datetime import date

import pandas as pd
import pytest

from ingest.sources.prices import configured_tickers, metadata_values, normalize_prices


def test_configured_tickers_include_every_fund_and_spy():
    tickers = configured_tickers()
    assert "SPY" in tickers
    assert {"XLE", "SMH", "BOTZ", "IYT"}.issubset(tickers)
    assert len(tickers) == len(set(tickers))


def test_normalize_prices_preserves_real_values_and_missing_volume():
    frame = pd.DataFrame(
        {
            "Date": [pd.Timestamp("2024-01-02"), pd.Timestamp("2024-01-03")],
            "Close": [100.0, 101.5],
            "Adj Close": [99.5, 101.0],
            "Volume": [1_000, None],
        }
    )
    assert normalize_prices(frame, "TEST") == [
        ("TEST", date(2024, 1, 2), 99.5, 100.0, 1000),
        ("TEST", date(2024, 1, 3), 101.0, 101.5, None),
    ]


def test_metadata_uses_available_expense_ratio_fallbacks():
    name, ratio, assets, issuer, rejected = metadata_values({
        "shortName": "Example ETF",
        "netExpenseRatio": 0.35,
        "netAssets": 68_100_000_000,
        "fundFamily": "Example",
    })
    assert (name, assets, issuer) == ("Example ETF", 68_100_000_000, "Example")
    assert ratio == pytest.approx(0.0035)
    assert rejected is None


def test_metadata_keeps_decimal_expense_ratio_without_dividing():
    _, ratio, _, _, rejected = metadata_values({"annualReportExpenseRatio": 0.0035})
    assert ratio == pytest.approx(0.0035)
    assert rejected is None


def test_metadata_rejects_expense_ratio_that_is_100x_too_small():
    # Yahoo already returned a decimal here, so the /100 fallback makes it 0.0035%.
    _, ratio, _, _, rejected = metadata_values({"netExpenseRatio": 0.0035})
    assert ratio is None
    assert rejected == 0.0035


def test_metadata_rejects_expense_ratio_that_is_100x_too_large():
    # A fund cannot charge 35% a year; the value was already a percentage.
    _, ratio, _, _, rejected = metadata_values({"annualReportExpenseRatio": 0.35})
    assert ratio is None
    assert rejected == 0.35


def test_metadata_reports_missing_expense_ratio_as_unavailable():
    _, ratio, _, _, rejected = metadata_values({"shortName": "No Fee Data"})
    assert ratio is None
    assert rejected is None
