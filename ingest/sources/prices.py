"""Daily ETF prices from Yahoo Finance with Stooq fallback."""

from __future__ import annotations

from datetime import date, timedelta
from io import StringIO
from typing import Any, Callable

import pandas as pd
import requests
import yfinance as yf

from ingest.registry import load_sectors
from ingest.sources.common import SourceUnavailable, logged_run, request, upsert_rows


PriceLoader = Callable[[str, date | None], pd.DataFrame]


def configured_tickers() -> tuple[str, ...]:
    tickers = {"SPY"}
    for sector in load_sectors():
        tickers.add(sector.primary_etf)
        tickers.update(sector.comparison_etfs)
    return tuple(sorted(tickers))


def yahoo_prices(ticker: str, start: date | None) -> pd.DataFrame:
    kwargs: dict[str, Any] = {
        "tickers": ticker,
        "progress": False,
        "auto_adjust": False,
        "actions": False,
    }
    if start:
        kwargs["start"] = start.isoformat()
    else:
        kwargs["period"] = "max"
    frame = yf.download(**kwargs)
    if frame.empty:
        raise SourceUnavailable(f"Yahoo Finance returned no rows for {ticker}")
    if isinstance(frame.columns, pd.MultiIndex):
        frame.columns = frame.columns.get_level_values(0)
    return frame.reset_index()


def stooq_prices(ticker: str, start: date | None) -> pd.DataFrame:
    symbol = f"{ticker.lower()}.us"
    url = f"https://stooq.com/q/d/l/?s={symbol}&i=d"
    response = request(requests.Session(), "GET", url)
    frame = pd.read_csv(StringIO(response.text))
    if frame.empty or "Date" not in frame:
        raise SourceUnavailable(f"Stooq returned no rows for {ticker}")
    frame["Date"] = pd.to_datetime(frame["Date"])
    if start:
        frame = frame[frame["Date"].dt.date >= start]
    # Stooq exposes one adjusted historical close series. Preserve that value
    # in both close fields rather than inventing a second price.
    frame["Adj Close"] = frame["Close"]
    return frame


def normalize_prices(frame: pd.DataFrame, ticker: str) -> list[tuple[Any, ...]]:
    required = {"Date", "Close", "Adj Close"}
    missing = required - set(frame.columns)
    if missing:
        raise SourceUnavailable(f"price response for {ticker} lacks {sorted(missing)}")
    rows: list[tuple[Any, ...]] = []
    for record in frame.to_dict("records"):
        if pd.isna(record["Close"]) or pd.isna(record["Adj Close"]):
            continue
        timestamp = pd.Timestamp(record["Date"])
        volume = record.get("Volume")
        rows.append(
            (
                ticker,
                timestamp.date(),
                float(record["Adj Close"]),
                float(record["Close"]),
                None if volume is None or pd.isna(volume) else int(volume),
            )
        )
    return rows


def latest_price_date(connection: Any, ticker: str) -> date | None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT max(date) FROM prices WHERE ticker = %s", (ticker,))
        return cursor.fetchone()[0]


def ingest_ticker(
    connection: Any,
    ticker: str,
    *,
    yahoo_loader: PriceLoader = yahoo_prices,
    stooq_loader: PriceLoader = stooq_prices,
) -> tuple[int, str]:
    latest = latest_price_date(connection, ticker)
    start = latest + timedelta(days=1) if latest else None
    try:
        frame = yahoo_loader(ticker, start)
        provider = "yahoo"
    except Exception as yahoo_error:
        try:
            frame = stooq_loader(ticker, start)
            provider = "stooq"
        except Exception as stooq_error:
            raise SourceUnavailable(
                f"{ticker}: Yahoo failed ({yahoo_error}); Stooq failed ({stooq_error})"
            ) from stooq_error

    rows = normalize_prices(frame, ticker)
    written = upsert_rows(
        connection,
        """
        INSERT INTO prices (ticker, date, adj_close, close, volume)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (ticker, date) DO UPDATE SET
            adj_close = EXCLUDED.adj_close,
            close = EXCLUDED.close,
            volume = EXCLUDED.volume
        """,
        rows,
    )
    return written, provider


def ingest_etf_meta(connection: Any, ticker: str) -> int:
    info = yf.Ticker(ticker).info
    if not info:
        raise SourceUnavailable(f"Yahoo Finance returned no metadata for {ticker}")
    name = info.get("longName") or info.get("shortName")
    expense_ratio = info.get("annualReportExpenseRatio")
    aum = info.get("totalAssets")
    issuer = info.get("fundFamily")
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO etf_meta (ticker, name, expense_ratio, aum, issuer, as_of)
            VALUES (%s, %s, %s, %s, %s, now())
            ON CONFLICT (ticker) DO UPDATE SET
                name = EXCLUDED.name,
                expense_ratio = EXCLUDED.expense_ratio,
                aum = EXCLUDED.aum,
                issuer = EXCLUDED.issuer,
                as_of = EXCLUDED.as_of
            """,
            (ticker, name, expense_ratio, aum, issuer),
        )
    connection.commit()
    return 1


def run(connection: Any) -> None:
    with logged_run(connection, "prices") as result:
        providers: dict[str, str] = {}
        errors: dict[str, str] = {}
        for ticker in configured_tickers():
            try:
                written, provider = ingest_ticker(connection, ticker)
                result.rows_written += written
                providers[ticker] = provider
            except Exception as exc:
                errors[ticker] = str(exc)
        result.details = {"providers": providers, "ticker_errors": errors}
        if errors:
            raise SourceUnavailable(f"price ingest failed for {len(errors)} ticker(s)")

    with logged_run(connection, "etf_meta") as result:
        errors: dict[str, str] = {}
        for ticker in configured_tickers():
            try:
                result.rows_written += ingest_etf_meta(connection, ticker)
            except Exception as exc:
                errors[ticker] = str(exc)
        result.details = {"ticker_errors": errors}
        if errors:
            raise SourceUnavailable(f"ETF metadata failed for {len(errors)} ticker(s)")

