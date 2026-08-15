"""Daily ETF prices from Yahoo Finance with Stooq fallback."""

from __future__ import annotations

from datetime import date, timedelta
from io import StringIO
import os
from typing import Any, Callable

import pandas as pd
import requests
import yfinance as yf

from ingest.registry import load_sectors
from ingest.sources.common import SourceUnavailable, logged_run, request, upsert_rows


PriceLoader = Callable[[str, date | None], pd.DataFrame]
REFRESH_LOOKBACK_DAYS = 400
# 0.01% to 2.00%. A US-listed ETF fee outside this band is not a fee, it is a
# unit error. The floor has to stay above 0.01% to catch an already-decimal
# value that the /100 fallback shrank by 100x, which would render as 0.00%.
EXPENSE_RATIO_MIN = 0.0001
EXPENSE_RATIO_MAX = 0.02


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
    full_refresh: bool = False,
) -> tuple[int, str]:
    latest = latest_price_date(connection, ticker)
    # Re-fetch a trailing window so transient upstream omissions and adjusted-
    # close revisions are repaired instead of becoming permanent database gaps.
    #
    # Yahoo recomputes adjusted close across the entire history every time a
    # dividend is paid, so rows older than the window keep whatever adjustment
    # factor they were first written with. Any span crossing that boundary then
    # compares two different bases. A full refresh rewrites the whole series onto
    # one basis; it is gated behind FORCE_ALL because it is expensive.
    if full_refresh:
        start = None
    else:
        start = latest - timedelta(days=REFRESH_LOOKBACK_DAYS) if latest else None
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


def metadata_values(info: dict[str, Any]) -> tuple[Any, Any, Any, Any, Any]:
    name = info.get("longName") or info.get("shortName")
    raw_expense_ratio = info.get("annualReportExpenseRatio")
    expense_ratio = raw_expense_ratio
    if expense_ratio is None:
        provider_percent = info.get("netExpenseRatio")
        if provider_percent is None:
            provider_percent = info.get("expenseRatio")
        raw_expense_ratio = provider_percent
        expense_ratio = float(provider_percent) / 100 if provider_percent is not None else None
    # Yahoo is inconsistent about whether netExpenseRatio and expenseRatio are
    # percentages or already decimals, so the /100 above can be 100x wrong. An
    # implausible result means the convention was guessed wrong; surface it as
    # unavailable rather than rendering a confident 0.00%.
    rejected_expense_ratio = None
    if expense_ratio is not None and not (EXPENSE_RATIO_MIN <= float(expense_ratio) <= EXPENSE_RATIO_MAX):
        rejected_expense_ratio = raw_expense_ratio
        expense_ratio = None
    aum = info.get("totalAssets") or info.get("netAssets")
    issuer = info.get("fundFamily")
    return name, expense_ratio, aum, issuer, rejected_expense_ratio


def ingest_etf_meta(connection: Any, ticker: str) -> tuple[int, Any]:
    info = yf.Ticker(ticker).info
    if not info:
        raise SourceUnavailable(f"Yahoo Finance returned no metadata for {ticker}")
    name, expense_ratio, aum, issuer, rejected_expense_ratio = metadata_values(info)
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
    return 1, rejected_expense_ratio


def run(connection: Any) -> None:
    with logged_run(connection, "prices") as result:
        providers: dict[str, str] = {}
        errors: dict[str, str] = {}
        full_refresh = os.environ.get("FORCE_ALL") == "1"
        for ticker in configured_tickers():
            try:
                written, provider = ingest_ticker(connection, ticker, full_refresh=full_refresh)
                result.rows_written += written
                providers[ticker] = provider
            except Exception as exc:
                errors[ticker] = str(exc)
        result.details = {
            "providers": providers,
            "ticker_errors": errors,
            "full_history_refresh": full_refresh,
            "refresh_lookback_days": None if full_refresh else REFRESH_LOOKBACK_DAYS,
        }
        if errors:
            raise SourceUnavailable(f"price ingest failed for {len(errors)} ticker(s)")

    with logged_run(connection, "etf_meta") as result:
        errors: dict[str, str] = {}
        unavailable_expense_ratios: list[str] = []
        rejected_expense_ratios: dict[str, Any] = {}
        for ticker in configured_tickers():
            try:
                written, rejected_expense_ratio = ingest_etf_meta(connection, ticker)
                result.rows_written += written
                if rejected_expense_ratio is not None:
                    rejected_expense_ratios[ticker] = rejected_expense_ratio
                with connection.cursor() as cursor:
                    cursor.execute("SELECT expense_ratio FROM etf_meta WHERE ticker=%s", (ticker,))
                    if cursor.fetchone()[0] is None:
                        unavailable_expense_ratios.append(ticker)
            except Exception as exc:
                errors[ticker] = str(exc)
        result.details = {
            "ticker_errors": errors,
            "expense_ratio_unavailable_from_yahoo": unavailable_expense_ratios,
            "expense_ratio_rejected_as_implausible": rejected_expense_ratios,
        }
        if errors:
            raise SourceUnavailable(f"ETF metadata failed for {len(errors)} ticker(s)")
