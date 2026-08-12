from datetime import date

import pytest

from ingest.sources.holdings import parse_ishares_csv, parse_percent


def test_parse_percent_handles_provider_formats():
    assert parse_percent("4.25%") == pytest.approx(0.0425)
    assert parse_percent(0.12) == pytest.approx(0.12)
    assert parse_percent("-") is None


def test_ishares_parser_skips_metadata_and_normalizes_weights():
    fixture = b"Fund Holdings as of,2024-01-31\nTicker,Name,Sector,Weight (%)\nAAA,Alpha Inc,Technology,60\nBBB,Beta Inc,Industrials,40\n"
    rows = parse_ishares_csv(fixture, "TEST", date(2024, 1, 31))
    assert rows == [
        ("TEST", date(2024, 1, 31), "AAA", "Alpha Inc", 0.6, "Technology"),
        ("TEST", date(2024, 1, 31), "BBB", "Beta Inc", 0.4, "Industrials"),
    ]

