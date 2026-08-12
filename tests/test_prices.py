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
    name, ratio, assets, issuer = metadata_values({
        "shortName": "Example ETF",
        "netExpenseRatio": 0.35,
        "netAssets": 68_100_000_000,
        "fundFamily": "Example",
    })
    assert (name, assets, issuer) == ("Example ETF", 68_100_000_000, "Example")
    assert ratio == pytest.approx(0.0035)
