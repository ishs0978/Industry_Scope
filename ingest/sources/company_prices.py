"""Weekly closes and analyst opinion for the companies inside the sector funds.

The prices table covers the funds. This covers what they hold, which is what a
company page needs: a multi-year chart, a return for each calendar year, and the
valuation multiples a reader compares against the sector.

Weekly rather than daily is a storage decision, not a data one. Daily bars for
~800 companies would be roughly 330 MB against a 512 MB ceiling shared with
everything else on the site. Every question a company page asks is measured in
years, and a weekly close answers those identically at a sixth of the size. The
page says the series is weekly rather than implying it is daily.
"""

from __future__ import annotations

from datetime import date, timedelta
import math
import os
import time
from typing import Any, Iterable, Iterator

from ingest.sources.common import SourceUnavailable, logged_run, upsert_rows


# Yahoo throttles a caller that asks for hundreds of symbols at once, and one
# oversized request failing loses the whole batch, so the work is chunked.
BATCH_SIZE = int(os.environ.get("COMPANY_PRICES_BATCH_SIZE", "40"))
HISTORY_YEARS = int(os.environ.get("COMPANY_PRICES_HISTORY_YEARS", "5"))
MAX_SECONDS = float(os.environ.get("COMPANY_PRICES_MAX_SECONDS", "1500"))
# A ticker Yahoo does not know returns an empty frame every run. Tracking them
# is what keeps a delisted constituent from being retried forever.
MAX_META_PER_RUN = int(os.environ.get("COMPANY_META_PER_RUN", "120"))
# Yahoo reports dividendYield as a percentage, so 3.47 means 3.47%. Stored raw
# and rendered as a percentage it came out as 347%, which is the same unit error
# the ETF expense ratio already had. Store the fraction, and reject anything
# outside a band a real yield can occupy rather than showing a confident wrong
# number: above 25% is not a yield, it is a broken field or a company about to
# cut it.
MAX_DIVIDEND_YIELD = 0.25
META_FLUSH_EVERY = int(os.environ.get("COMPANY_META_FLUSH_EVERY", "50"))


def constituent_tickers(connection: Any) -> list[str]:
    """Every company held by a fund whose composition passed validation."""
    with connection.cursor() as cursor:
        cursor.execute(
            """SELECT DISTINCT constituent_ticker FROM holdings
               WHERE constituent_ticker IS NOT NULL AND constituent_ticker <> ''
               ORDER BY constituent_ticker"""
        )
        return [row[0] for row in cursor.fetchall()]


def batches(items: list[str], size: int) -> Iterator[list[str]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def number(value: Any) -> float | None:
    """A finite float, or nothing. Yahoo returns NaN for absent fields."""
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def weekly_rows(frame: Any, ticker: str) -> list[tuple[Any, ...]]:
    """Rows from one ticker's weekly frame, skipping weeks Yahoo left blank."""
    import pandas as pd

    if frame is None or frame.empty:
        return []
    rows: list[tuple[Any, ...]] = []
    for stamp, record in frame.iterrows():
        adjusted = number(record.get("Adj Close"))
        if adjusted is None:
            adjusted = number(record.get("Close"))
        if adjusted is None or adjusted <= 0:
            continue
        rows.append((ticker, pd.Timestamp(stamp).date(), adjusted, number(record.get("Close"))))
    return rows


def download_weekly(tickers: list[str], start: date) -> Any:
    import yfinance as yf

    return yf.download(
        tickers=" ".join(tickers), start=start.isoformat(), interval="1wk",
        auto_adjust=False, actions=False, progress=False, group_by="ticker",
        threads=True,
    )


def frame_for(downloaded: Any, ticker: str, single: bool) -> Any:
    """Pull one ticker out of a multi-symbol download."""
    if single:
        return downloaded
    try:
        return downloaded[ticker]
    except (KeyError, TypeError):
        return None


PRICE_UPSERT = """
INSERT INTO company_prices (ticker, week_ending, adj_close, close)
VALUES (%s,%s,%s,%s)
ON CONFLICT (ticker, week_ending) DO UPDATE SET
    adj_close = EXCLUDED.adj_close, close = EXCLUDED.close
"""

META_UPSERT = """
INSERT INTO company_meta (
    ticker, market_cap, as_of, name, trailing_pe, forward_pe, price_to_book,
    dividend_yield, target_mean_price, analyst_count, recommendation
)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
ON CONFLICT (ticker) DO UPDATE SET
    market_cap = COALESCE(EXCLUDED.market_cap, company_meta.market_cap),
    as_of = EXCLUDED.as_of, name = COALESCE(EXCLUDED.name, company_meta.name),
    trailing_pe = EXCLUDED.trailing_pe, forward_pe = EXCLUDED.forward_pe,
    price_to_book = EXCLUDED.price_to_book, dividend_yield = EXCLUDED.dividend_yield,
    target_mean_price = EXCLUDED.target_mean_price,
    analyst_count = EXCLUDED.analyst_count, recommendation = EXCLUDED.recommendation
"""


def meta_row(ticker: str, info: dict[str, Any], today: date) -> tuple[Any, ...] | None:
    """One company_meta row, or nothing when Yahoo knows the ticker but not the company."""
    if not info:
        return None
    count = info.get("numberOfAnalystOpinions")
    return (
        ticker, number(info.get("marketCap")), today,
        (info.get("shortName") or info.get("longName") or None),
        number(info.get("trailingPE")), number(info.get("forwardPE")),
        number(info.get("priceToBook")), dividend_yield(info.get("dividendYield")),
        number(info.get("targetMeanPrice")),
        int(count) if isinstance(count, (int, float)) and count else None,
        (info.get("recommendationKey") or None),
    )


def dividend_yield(value: Any) -> float | None:
    """Yahoo's percentage as a fraction, or nothing if it is not a plausible yield."""
    percent = number(value)
    if percent is None or percent < 0:
        return None
    fraction = percent / 100
    return fraction if fraction <= MAX_DIVIDEND_YIELD else None


def stale_meta_tickers(connection: Any, tickers: Iterable[str], limit: int) -> list[str]:
    """Companies whose opinion figures are missing or oldest, most stale first.

    Yahoo's per-company endpoint is one request each, so a run refreshes a slice
    rather than all eight hundred and the slice moves on each day.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """SELECT t.ticker FROM unnest(%s::text[]) AS t(ticker)
               LEFT JOIN company_meta m ON m.ticker = t.ticker
               ORDER BY (m.recommendation IS NOT NULL), m.as_of NULLS FIRST, t.ticker
               LIMIT %s""",
            (list(tickers), limit),
        )
        return [row[0] for row in cursor.fetchall()]


def run(connection: Any) -> None:
    with logged_run(connection, "company_prices") as result:
        tickers = constituent_tickers(connection)
        if not tickers:
            raise SourceUnavailable("no fund constituents are known yet")
        start = date.today() - timedelta(days=365 * HISTORY_YEARS + 7)
        deadline = time.monotonic() + MAX_SECONDS

        priced: set[str] = set()
        empty: list[str] = []
        failures: dict[str, str] = {}
        for batch in batches(tickers, BATCH_SIZE):
            if time.monotonic() >= deadline:
                break
            try:
                downloaded = download_weekly(batch, start)
            except Exception as exc:
                failures[batch[0]] = f"{type(exc).__name__}: {exc}"[:200]
                continue
            rows: list[tuple[Any, ...]] = []
            for ticker in batch:
                ticker_rows = weekly_rows(frame_for(downloaded, ticker, len(batch) == 1), ticker)
                if ticker_rows:
                    priced.add(ticker)
                    rows.extend(ticker_rows)
                else:
                    empty.append(ticker)
            if rows:
                result.rows_written += upsert_rows(connection, PRICE_UPSERT, rows)

        meta_written = 0
        if time.monotonic() < deadline:
            import yfinance as yf

            today = date.today()
            meta_rows: list[tuple[Any, ...]] = []
            for ticker in stale_meta_tickers(connection, tickers, MAX_META_PER_RUN):
                if time.monotonic() >= deadline:
                    break
                try:
                    row = meta_row(ticker, yf.Ticker(ticker).info or {}, today)
                except Exception as exc:
                    failures[ticker] = f"{type(exc).__name__}: {exc}"[:200]
                    continue
                if row:
                    meta_rows.append(row)
                # Yahoo's per-company endpoint is one slow request each, so
                # holding the rows to the end left the database connection idle
                # for long enough that it was closed underneath us and the whole
                # pass was lost. Writing as we go keeps it in use and means an
                # interruption costs one batch rather than all of them.
                if len(meta_rows) >= META_FLUSH_EVERY:
                    meta_written += upsert_rows(connection, META_UPSERT, meta_rows)
                    meta_rows = []
            if meta_rows:
                meta_written += upsert_rows(connection, META_UPSERT, meta_rows)
            result.rows_written += meta_written

        result.details = {
            "constituents": len(tickers),
            "tickers_priced": len(priced),
            "tickers_yahoo_returned_nothing": len(empty),
            "history_years": HISTORY_YEARS,
            "interval": "weekly",
            "analyst_rows_refreshed": meta_written,
            "errors": dict(list(failures.items())[:6]),
            "error_count": len(failures),
        }
        if not priced:
            raise SourceUnavailable(f"Yahoo returned no weekly prices for any of {len(tickers)} constituents")
