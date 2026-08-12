"""Validated daily holdings snapshots from explicitly configured issuer feeds."""

from __future__ import annotations

from datetime import date, datetime
from dataclasses import dataclass
from io import BytesIO, StringIO
import logging
from pathlib import Path
import re
from typing import Any

import pandas as pd
import requests
import yaml

from ingest.registry import REGISTRY_PATH, load_sectors
from ingest.sources.common import SourceUnavailable, logged_run, request, upsert_rows


LOGGER = logging.getLogger(__name__)
MIN_ROWS = 5
MIN_TOTAL_WEIGHT = 0.98
MAX_TOTAL_WEIGHT = 1.02
MAX_SINGLE_WEIGHT = 0.60


@dataclass(frozen=True)
class HoldingsFeed:
    provider: str
    url: str | None = None
    concentrated: bool = False
    reason: str | None = None


class SnapshotValidationError(SourceUnavailable):
    """Raised before a malformed provider snapshot can reach the holdings table."""


def load_holdings_feeds(path: Path = REGISTRY_PATH) -> dict[str, HoldingsFeed]:
    with path.open(encoding="utf-8") as registry_file:
        document = yaml.safe_load(registry_file)
    raw_feeds = document.get("holdings_feeds", {})
    if not isinstance(raw_feeds, dict):
        raise ValueError("holdings_feeds must be a mapping")
    return {
        str(ticker): HoldingsFeed(
            provider=str(config.get("provider", "unsupported")),
            url=str(config["url"]) if config.get("url") else None,
            concentrated=bool(config.get("concentrated", False)),
            reason=str(config["reason"]) if config.get("reason") else None,
        )
        for ticker, config in raw_feeds.items()
    }


def supported_funds() -> dict[str, str]:
    return {
        ticker: feed.provider
        for ticker, feed in load_holdings_feeds().items()
        if feed.provider != "unsupported" and feed.url
    }


def all_configured_funds() -> tuple[str, ...]:
    tickers = {"SPY"}
    for sector in load_sectors():
        tickers.add(sector.primary_etf)
        tickers.update(sector.comparison_etfs)
    return tuple(sorted(tickers))


def parse_percent(value: Any) -> float | None:
    """Convert a provider weight expressed in percentage points to a fraction."""
    if value is None or pd.isna(value):
        return None
    text = str(value).strip().replace("%", "").replace(",", "")
    if not text or text in {"-", "—"}:
        return None
    number = float(text)
    return number / 100


def _normalized_header(value: Any) -> str:
    return " ".join(str(value).strip().lower().replace("%", " percent ").split())


def _column_by_name(columns: dict[str, Any], *names: str) -> Any | None:
    for name in names:
        match = columns.get(_normalized_header(name))
        if match is not None:
            return match
    return None


def _find_header_row(lines: list[str], required_tokens: tuple[str, ...]) -> int:
    for index, line in enumerate(lines):
        lowered = line.lower()
        if all(token in lowered for token in required_tokens):
            return index
    raise SourceUnavailable(f"holdings file has no header containing {required_tokens}")


def parse_ishares_csv(content: bytes, fund_ticker: str, as_of: date) -> list[tuple[Any, ...]]:
    text = content.decode("utf-8-sig", errors="replace")
    if text.lstrip().lower().startswith(("<!doctype html", "<html")):
        raise SourceUnavailable(f"iShares returned HTML instead of holdings CSV for {fund_ticker}")
    lines = text.splitlines()
    LOGGER.debug("%s raw holdings rows: %s", fund_ticker, lines[:15])
    header = _find_header_row(lines, ("ticker", "name", "weight"))
    frame = pd.read_csv(StringIO("\n".join(lines[header:])))
    columns = {_normalized_header(column): column for column in frame.columns}
    ticker_col = _column_by_name(columns, "ticker")
    name_col = _column_by_name(columns, "name", "security name")
    weight_col = _column_by_name(columns, "weight", "weight percent", "weight (%)")
    sector_col = _column_by_name(columns, "sector", "asset class")
    if ticker_col is None or name_col is None or weight_col is None:
        raise SourceUnavailable("iShares holdings columns changed")
    return _normalize_holdings(frame, fund_ticker, as_of, ticker_col, name_col, weight_col, sector_col)


def parse_state_street(content: bytes, fund_ticker: str, as_of: date) -> list[tuple[Any, ...]]:
    if content[:2] == b"PK":
        frame = pd.read_excel(BytesIO(content), header=None)
        LOGGER.debug(
            "%s raw holdings rows: %s",
            fund_ticker,
            frame.head(15).where(frame.notna(), None).values.tolist(),
        )
        header_index = next(
            (
                index
                for index, row in frame.iterrows()
                if "ticker" in {_normalized_header(value) for value in row.values}
                and "weight" in {_normalized_header(value) for value in row.values}
            ),
            None,
        )
        if header_index is None:
            raise SourceUnavailable("State Street workbook header not found")
        frame.columns = frame.iloc[header_index]
        frame = frame.iloc[header_index + 1 :]
    else:
        text = content.decode("utf-8-sig", errors="replace")
        if text.lstrip().lower().startswith(("<!doctype html", "<html")):
            raise SourceUnavailable(f"State Street returned HTML instead of holdings data for {fund_ticker}")
        lines = text.splitlines()
        LOGGER.debug("%s raw holdings rows: %s", fund_ticker, lines[:15])
        header_index = _find_header_row(lines, ("ticker", "weight"))
        frame = pd.read_csv(StringIO("\n".join(lines[header_index:])))
    columns = {_normalized_header(column): column for column in frame.columns}
    ticker_col = _column_by_name(columns, "ticker")
    name_col = _column_by_name(columns, "name", "security name")
    weight_col = _column_by_name(columns, "weight", "weight percent", "weight (%)")
    sector_col = _column_by_name(columns, "sector", "asset class")
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


def validate_snapshot(
    rows: list[tuple[Any, ...]],
    fund_ticker: str,
    *,
    concentrated: bool = False,
) -> None:
    total = sum(float(row[4]) for row in rows)
    ranked = sorted(rows, key=lambda row: float(row[4]), reverse=True)
    top_rows = ", ".join(f"{row[2]}={float(row[4]):.4%}" for row in ranked[:3]) or "none"
    failures: list[str] = []
    if len(rows) < MIN_ROWS:
        failures.append(f"row_count={len(rows)} below {MIN_ROWS}")
    if not MIN_TOTAL_WEIGHT <= total <= MAX_TOTAL_WEIGHT:
        failures.append(f"weight_sum={total:.4%} outside 98.0%-102.0%")
    if ranked and float(ranked[0][4]) > MAX_SINGLE_WEIGHT and not concentrated:
        failures.append(f"max_weight={float(ranked[0][4]):.4%} exceeds 60.0%")
    if failures:
        raise SnapshotValidationError(
            f"{fund_ticker} snapshot rejected: {'; '.join(failures)}; top_rows=[{top_rows}]"
        )


def snapshot_date_from_content(content: bytes, provider: str) -> date | None:
    if provider != "state_street" or content[:2] != b"PK":
        return None
    header = pd.read_excel(BytesIO(content), header=None, nrows=5)
    for value in header.values.flat:
        match = re.search(r"\bAs of\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\b", str(value), re.IGNORECASE)
        if match:
            return datetime.strptime(match.group(1), "%d-%b-%Y").date()
    return None


def store_snapshot(
    connection: Any,
    fund_ticker: str,
    as_of: date,
    rows: list[tuple[Any, ...]],
    *,
    concentrated: bool = False,
) -> int:
    """Validate first, then atomically replace the provider snapshot."""
    with logged_run(connection, f"holdings:{fund_ticker}") as result:
        validate_snapshot(rows, fund_ticker, concentrated=concentrated)
        with connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM holdings WHERE fund_ticker=%s AND as_of=%s",
                (fund_ticker, as_of),
            )
            cursor.executemany(
                """
            INSERT INTO holdings (
                fund_ticker, as_of, constituent_ticker,
                constituent_name, weight, sub_sector
            ) VALUES (%s, %s, %s, %s, %s, %s)
                """,
                rows,
            )
        connection.commit()
        result.rows_written = len(rows)
        return result.rows_written


def download_holdings(ticker: str, feed: HoldingsFeed) -> tuple[bytes, date]:
    if feed.provider == "unsupported" or not feed.url:
        raise SourceUnavailable(feed.reason or f"No supported issuer feed is configured for {ticker}")
    session = requests.Session()
    today = date.today()
    response = request(session, "GET", feed.url)
    disposition = response.headers.get("content-disposition", "")
    match = re.search(r"(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)", disposition)
    as_of = (
        date(*map(int, match.groups()))
        if match
        else snapshot_date_from_content(response.content, feed.provider) or today
    )
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
    feeds = load_holdings_feeds()
    configured = all_configured_funds()
    missing = sorted(set(configured) - feeds.keys())
    if missing:
        raise SourceUnavailable(f"holdings feed status is not configured for: {', '.join(missing)}")
    with logged_run(connection, "holdings") as result:
        snapshots: dict[str, str] = {}
        failures: dict[str, str] = {}
        unsupported: dict[str, str] = {}
        for ticker in configured:
            feed = feeds[ticker]
            if feed.provider == "unsupported" or not feed.url:
                reason = feed.reason or "Issuer feed is not supported"
                unsupported[ticker] = reason
                mark_holdings_status(connection, ticker, "unsupported", reason)
                continue
            try:
                content, as_of = download_holdings(ticker, feed)
                rows = (
                    parse_ishares_csv(content, ticker, as_of)
                    if feed.provider == "ishares"
                    else parse_state_street(content, ticker, as_of)
                )
                result.rows_written += store_snapshot(
                    connection, ticker, as_of, rows, concentrated=feed.concentrated
                )
                mark_holdings_status(connection, ticker, "available")
                snapshots[ticker] = as_of.isoformat()
            except Exception as exc:
                # Existing snapshots remain untouched on failure.
                failures[ticker] = str(exc)
                mark_holdings_status(connection, ticker, "stale", str(exc)[:1000])
        result.details = {
            "snapshots": snapshots,
            "fund_errors": failures,
            "unsupported": unsupported,
        }
        if failures:
            reasons = "; ".join(f"{ticker}: {reason}" for ticker, reason in failures.items())
            raise SourceUnavailable(
                f"holdings failed for {len(failures)} supported fund(s): {reasons}"
            )
