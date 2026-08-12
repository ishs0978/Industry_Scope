from datetime import date

import pandas as pd

from ingest.sources.prices import configured_tickers, normalize_prices


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

