from datetime import date
from io import BytesIO

from openpyxl import Workbook
import pytest

from ingest.sources.holdings import (
    SnapshotValidationError,
    all_configured_funds,
    load_holdings_feeds,
    parse_ishares_csv,
    parse_percent,
    parse_state_street,
    store_snapshot,
    snapshot_date_from_content,
    validate_snapshot,
)


def ssga_workbook(ticker: str, rows: list[tuple[str, str, float]]) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(("Fund Name:", f"Test {ticker} ETF"))
    sheet.append(("Ticker Symbol:", ticker))
    sheet.append(("Holdings:", "As of 11-Aug-2026"))
    sheet.append(())
    sheet.append(("Name", "Ticker", "Identifier", "SEDOL", "Weight", "Sector", "Shares Held", "Local Currency"))
    for name, holding_ticker, weight in rows:
        sheet.append((name, holding_ticker, "id", "sedol", weight, "Test sector", 100, "USD"))
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


XLE_ROWS = [
    ("EXXONMOBIL", "XOM", 20.74),
    ("CHEVRON", "CVX", 14.94),
    ("CONOCOPHILLIPS", "COP", 14.32),
    ("MARATHON PETROLEUM", "MPC", 13.00),
    ("PHILLIPS 66", "PSX", 12.00),
    ("VALERO ENERGY", "VLO", 10.00),
    ("APA CORP", "APA", 0.87),
    ("OTHER ENERGY", "OTHER", 14.13),
]

XLY_ROWS = [
    ("AMAZON.COM INC", "AMZN", 24.98),
    ("TESLA INC", "TSLA", 15.29),
    ("HOME DEPOT INC", "HD", 14.73),
    ("MCDONALD S CORP", "MCD", 12.00),
    ("BOOKING HOLDINGS INC", "BKNG", 11.00),
    ("YUM BRANDS INC", "YUM", 0.98),
    ("OTHER DISCRETIONARY", "OTHER", 21.02),
]


def parsed_snapshot(ticker: str, rows: list[tuple[str, str, float]]) -> list[tuple[object, ...]]:
    return parse_state_street(ssga_workbook(ticker, rows), ticker, date(2026, 8, 11))


def test_parse_percent_handles_provider_formats():
    assert parse_percent("4.25%") == pytest.approx(0.0425)
    assert parse_percent(0.12) == pytest.approx(0.0012)
    assert parse_percent("-") is None


def test_ishares_parser_skips_metadata_and_normalizes_weights():
    fixture = b"Fund Holdings as of,2024-01-31\nTicker,Name,Sector,Weight (%)\nAAA,Alpha Inc,Technology,60\nBBB,Beta Inc,Industrials,40\n"
    rows = parse_ishares_csv(fixture, "TEST", date(2024, 1, 31))
    assert rows == [
        ("TEST", date(2024, 1, 31), "AAA", "Alpha Inc", 0.6, "Technology"),
        ("TEST", date(2024, 1, 31), "BBB", "Beta Inc", 0.4, "Industrials"),
    ]


def test_weights_sum_to_100():
    for ticker, raw_rows in (("XLE", XLE_ROWS), ("XLY", XLY_ROWS)):
        rows = parsed_snapshot(ticker, raw_rows)
        validate_snapshot(rows, ticker)
        assert sum(row[4] for row in rows) == pytest.approx(1.0, abs=0.02)


def test_xly_largest_is_amzn():
    rows = parsed_snapshot("XLY", XLY_ROWS)
    assert max(rows, key=lambda row: row[4])[2] == "AMZN"


def test_state_street_snapshot_date_comes_from_file():
    content = ssga_workbook("XLE", XLE_ROWS)
    assert snapshot_date_from_content(content, "state_street") == date(2026, 8, 11)


class RecordingCursor:
    def __init__(self, connection):
        self.connection = connection
        self.result = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def execute(self, query, params=None):
        normalized = " ".join(str(query).split())
        self.connection.statements.append((normalized, params))
        if "RETURNING id" in normalized:
            self.result = (1,)

    def executemany(self, query, rows):
        normalized = " ".join(str(query).split())
        self.connection.statements.append((normalized, list(rows)))

    def fetchone(self):
        return self.result


class RecordingConnection:
    def __init__(self):
        self.statements = []
        self.commits = 0

    def cursor(self):
        return RecordingCursor(self)

    def commit(self):
        self.commits += 1


def test_rejected_snapshot_not_written():
    connection = RecordingConnection()
    corrupt = parsed_snapshot("XLY", [
        ("YUM BRANDS", "YUM", 97.66),
        ("DR HORTON", "DHI", 97.36),
        ("EXPEDIA", "EXPE", 89.99),
        ("CARNIVAL", "CCL", 87.32),
        ("AMAZON", "AMZN", 24.98),
    ])

    with pytest.raises(SnapshotValidationError, match=r"weight_sum=397.3100%.*top_rows=\[YUM=97.6600%"):
        store_snapshot(connection, "XLY", date(2026, 8, 11), corrupt)

    queries = [query for query, _ in connection.statements]
    assert any("INSERT INTO ingest_runs" in query for query in queries)
    assert any("UPDATE ingest_runs SET" in query and "status = 'failed'" in query for query in queries)
    assert not any("INSERT INTO holdings" in query for query in queries)


def test_valid_snapshot_replaces_same_date_atomically():
    connection = RecordingConnection()
    store_snapshot(connection, "XLE", date(2026, 8, 11), parsed_snapshot("XLE", XLE_ROWS))
    queries = [query for query, _ in connection.statements]
    delete_index = next(index for index, query in enumerate(queries) if "DELETE FROM holdings" in query)
    insert_index = next(index for index, query in enumerate(queries) if "INSERT INTO holdings" in query)
    assert delete_index < insert_index


def test_every_configured_fund_has_explicit_feed_status():
    feeds = load_holdings_feeds()
    assert set(feeds) == set(all_configured_funds())
    for feed in feeds.values():
        assert feed.provider == "unsupported" or feed.url
