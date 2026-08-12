"""Daily holdings parsers for iShares and State Street funds."""

from __future__ import annotations

from datetime import date
from io import BytesIO, StringIO
import re
from typing import Any

import pandas as pd
import requests

from ingest.registry import load_sectors
from ingest.sources.common import SourceUnavailable, logged_run, request, upsert_rows


ISHARES_PRODUCTS = {
    "SOXX": ("239705", "iShares-Semiconductor-ETF"),
    "IGV": ("239771", "iShares-Expanded-Tech-Software-Sector-ETF"),
    "ITA": ("239502", "iShares-US-Aerospace-Defense-ETF"),
    "ITB": ("239512", "iShares-US-Home-Construction-ETF"),
    "ICLN": ("239738", "iShares-Global-Clean-Energy-ETF"),
    "IYT": ("239501", "iShares-US-Transportation-ETF"),
}

STATE_STREET_FUNDS = {
    "XLE", "XLF", "XLV", "XHB", "XLI", "XLY", "XLP", "XLU", "XLRE",
    "XLB", "GLD", "XLC", "SPY", "XOP", "XSD", "KRE", "XAR",
}


def supported_funds() -> dict[str, str]:
    result = {ticker: "ishares" for ticker in ISHARES_PRODUCTS}
    result.update({ticker: "state_street" for ticker in STATE_STREET_FUNDS})
    return result


def all_configured_funds() -> tuple[str, ...]:
    tickers = {"SPY"}
    for sector in load_sectors():
        tickers.add(sector.primary_etf)
        tickers.update(sector.comparison_etfs)
    return tuple(sorted(tickers))


def parse_percent(value: Any) -> float | None:
    if value is None or pd.isna(value):
        return None
    text = str(value).strip().replace("%", "").replace(",", "")
    if not text or text in {"-", "—"}:
        return None
    number = float(text)
    return number / 100 if abs(number) > 1 else number


def _find_header_row(lines: list[str], required_tokens: tuple[str, ...]) -> int:
    for index, line in enumerate(lines):
        lowered = line.lower()
        if all(token in lowered for token in required_tokens):
            return index
    raise SourceUnavailable(f"holdings file has no header containing {required_tokens}")


def parse_ishares_csv(content: bytes, fund_ticker: str, as_of: date) -> list[tuple[Any, ...]]:
    text = content.decode("utf-8-sig", errors="replace")
    lines = text.splitlines()
    header = _find_header_row(lines, ("ticker", "name", "weight"))
    frame = pd.read_csv(StringIO("\n".join(lines[header:])))
    columns = {str(column).strip().lower(): column for column in frame.columns}
    ticker_col = next((value for key, value in columns.items() if key == "ticker"), None)
    name_col = next((value for key, value in columns.items() if key == "name"), None)
    weight_col = next((value for key, value in columns.items() if "weight" in key), None)
    sector_col = next((value for key, value in columns.items() if "sector" in key), None)
    if ticker_col is None or name_col is None or weight_col is None:
        raise SourceUnavailable("iShares holdings columns changed")
    return _normalize_holdings(frame, fund_ticker, as_of, ticker_col, name_col, weight_col, sector_col)


def parse_state_street(content: bytes, fund_ticker: str, as_of: date) -> list[tuple[Any, ...]]:
    if content[:2] == b"PK":
        frame = pd.read_excel(BytesIO(content), header=None)
        header_index = next(
            (
                index
                for index, row in frame.iterrows()
                if "ticker" in " ".join(str(value).lower() for value in row.values)
                and "weight" in " ".join(str(value).lower() for value in row.values)
            ),
            None,
        )
        if header_index is None:
            raise SourceUnavailable("State Street workbook header not found")
        frame.columns = frame.iloc[header_index]
        frame = frame.iloc[header_index + 1 :]
    else:
        text = content.decode("utf-8-sig", errors="replace")
        lines = text.splitlines()
        header_index = _find_header_row(lines, ("ticker", "weight"))
        frame = pd.read_csv(StringIO("\n".join(lines[header_index:])))
    columns = {str(column).strip().lower(): column for column in frame.columns}
    ticker_col = next((value for key, value in columns.items() if "ticker" in key), None)
    name_col = next((value for key, value in columns.items() if key in {"name", "security name"}), None)
    weight_col = next((value for key, value in columns.items() if "weight" in key), None)
    sector_col = next((value for key, value in columns.items() if "sector" in key), None)
    if ticker_col is None or name_col is None or weight_col is None:
        raise SourceUnavailable("State Street holdings columns changed")
    return _normalize_holdings(frame, fund_ticker, as_of, ticker_col, name_col, weight_col, sector_col)


def _normalize_holdings(
    frame: pd.DataFrame,
    fund_ticker: str,
    as_of: date,
    ticker_col: Any,
    name_col: Any,
    weight_col: Any,
    sector_col: Any | None,
) -> list[tuple[Any, ...]]:
    rows: list[tuple[Any, ...]] = []
    seen: set[str] = set()
    for record in frame.to_dict("records"):
        ticker = str(record.get(ticker_col, "")).strip().upper()
        weight = parse_percent(record.get(weight_col))
        if not ticker or ticker in {"NAN", "-", "—"} or weight is None or ticker in seen:
            continue
        seen.add(ticker)
        name = str(record.get(name_col, "")).strip()
        sub_sector = str(record.get(sector_col, "")).strip() if sector_col else None
        rows.append((fund_ticker, as_of, ticker, name, weight, sub_sector or None))
    if not rows:
        raise SourceUnavailable(f"no usable holdings parsed for {fund_ticker}")
    return rows


def download_holdings(ticker: str, issuer: str) -> tuple[bytes, date]:
    session = requests.Session()
    today = date.today()
    if issuer == "ishares":
        product_id, slug = ISHARES_PRODUCTS[ticker]
        url = (
            f"https://www.ishares.com/us/products/{product_id}/{slug}/"
            f"1467271812596.ajax?fileType=csv&fileName={ticker}_holdings&dataType=fund"
        )
    elif issuer == "state_street":
        url = (
            "https://www.ssga.com/us/en/intermediary/library-content/products/"
            f"fund-data/etfs/us/holdings-daily-us-en-{ticker.lower()}.xlsx"
        )
    else:
        raise SourceUnavailable(f"holdings issuer unsupported for {ticker}")
    response = request(session, "GET", url)
    disposition = response.headers.get("content-disposition", "")
    match = re.search(r"(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)", disposition)
    as_of = date(*map(int, match.groups())) if match else today
    return response.content, as_of


def mark_holdings_status(connection: Any, ticker: str, status: str, error: str | None = None) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO etf_meta (ticker, as_of, holdings_status, holdings_error)
            VALUES (%s, now(), %s, %s)
            ON CONFLICT (ticker) DO UPDATE SET
                holdings_status = EXCLUDED.holdings_status,
                holdings_error = EXCLUDED.holdings_error
            """,
            (ticker, status, error),
        )
    connection.commit()


def run(connection: Any) -> None:
    supported = supported_funds()
    with logged_run(connection, "holdings") as result:
        snapshots: dict[str, str] = {}
        failures: dict[str, str] = {}
        for ticker in all_configured_funds():
            issuer = supported.get(ticker)
            if issuer is None:
                mark_holdings_status(connection, ticker, "unsupported", "Issuer feed is not supported")
                continue
            try:
                content, as_of = download_holdings(ticker, issuer)
                rows = (
                    parse_ishares_csv(content, ticker, as_of)
                    if issuer == "ishares"
                    else parse_state_street(content, ticker, as_of)
                )
                result.rows_written += upsert_rows(
                    connection,
                    """
                    INSERT INTO holdings (
                        fund_ticker, as_of, constituent_ticker,
                        constituent_name, weight, sub_sector
                    ) VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (fund_ticker, as_of, constituent_ticker) DO UPDATE SET
                        constituent_name = EXCLUDED.constituent_name,
                        weight = EXCLUDED.weight,
                        sub_sector = EXCLUDED.sub_sector
                    """,
                    rows,
                )
                mark_holdings_status(connection, ticker, "available")
                snapshots[ticker] = as_of.isoformat()
            except Exception as exc:
                # Existing snapshots remain untouched on failure.
                failures[ticker] = str(exc)
                mark_holdings_status(connection, ticker, "stale", str(exc)[:1000])
        result.details = {"snapshots": snapshots, "fund_errors": failures}
        if failures:
            raise SourceUnavailable(f"holdings failed for {len(failures)} supported fund(s)")

