"""SEC XBRL company facts for primary-ETF constituents."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import os
import time
from typing import Any

import requests

from ingest.registry import load_sectors
from ingest.sources.common import (
    RateLimiter, SourceUnavailable, logged_run, request, upsert_rows,
)


SEC_DATA = "https://data.sec.gov"
US_GAAP_TAGS = (
    "Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
    "GrossProfit", "OperatingIncomeLoss", "NetIncomeLoss", "Assets",
    "StockholdersEquity", "LongTermDebt", "LongTermDebtCurrent",
    "LongTermDebtNoncurrent", "ShortTermBorrowings",
)


# The SEC limiter is the shared one; GDELT uses the same class at a far slower
# rate. Keeping one implementation means one place to fix pacing bugs.
SecRateLimiter = RateLimiter


def sec_session() -> requests.Session:
    user_agent = os.environ.get("SEC_USER_AGENT", "").strip()
    if not user_agent or "@" not in user_agent:
        raise SourceUnavailable("SEC_USER_AGENT must contain an application name and contact email")
    session = requests.Session()
    session.headers.update({"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"})
    return session


def fetch_json(
    session: requests.Session,
    limiter: SecRateLimiter,
    url: str,
    *,
    timeout: float = 45,
) -> dict[str, Any]:
    limiter.wait()
    return request(session, "GET", url, timeout=timeout).json()


def ticker_cik_map(session: requests.Session, limiter: SecRateLimiter) -> dict[str, str]:
    payload = fetch_json(session, limiter, "https://www.sec.gov/files/company_tickers.json")
    return {
        str(item["ticker"]).upper(): str(item["cik_str"]).zfill(10)
        for item in payload.values()
    }


def primary_constituents(connection: Any, limit: int | None = None) -> tuple[str, ...]:
    primary = [sector.primary_etf for sector in load_sectors()]
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH constituents AS (
                SELECT DISTINCT h.constituent_ticker
                FROM holdings h
                JOIN (
                SELECT fund_ticker, max(as_of) AS as_of
                FROM holdings WHERE fund_ticker = ANY(%s) GROUP BY fund_ticker
                ) latest USING (fund_ticker, as_of)
                WHERE h.constituent_ticker ~ '^[A-Z][A-Z0-9.-]*$'
            )
            SELECT constituents.constituent_ticker
            FROM constituents
            LEFT JOIN company_facts ON company_facts.ticker=constituents.constituent_ticker
            GROUP BY constituents.constituent_ticker
            ORDER BY max(company_facts.filed_date) ASC NULLS FIRST, constituents.constituent_ticker
            LIMIT %s
            """,
            (primary, limit),
        )
        return tuple(row[0] for row in cursor.fetchall())


def normalize_company_facts(payload: dict[str, Any], ticker: str) -> list[tuple[Any, ...]]:
    cik = str(payload.get("cik", "")).zfill(10)
    rows_by_key: dict[tuple[str, str, str], tuple[Any, ...]] = {}
    facts = payload.get("facts", {}).get("us-gaap", {})
    for tag in US_GAAP_TAGS:
        fact = facts.get(tag)
        if not fact:
            continue
        units = fact.get("units", {})
        observations = units.get("USD", [])
        for item in observations:
            fiscal_period = item.get("frame") or (
                f"FY{item.get('fy')}{item.get('fp')}" if item.get("fy") and item.get("fp") else None
            )
            filed = item.get("filed")
            if not fiscal_period or not filed or item.get("val") is None:
                continue
            key = (cik, fiscal_period, tag)
            row = (cik, ticker, fiscal_period, tag, item["val"], filed)
            previous = rows_by_key.get(key)
            if previous is None or filed > previous[-1]:
                rows_by_key[key] = row
    return list(rows_by_key.values())


def fetch_frame(
    session: requests.Session,
    limiter: SecRateLimiter,
    tag: str,
    frame: str,
) -> dict[str, Any]:
    """Expose SEC Frames for bulk cross-company validation and gap analysis."""
    return fetch_json(session, limiter, f"{SEC_DATA}/api/xbrl/frames/us-gaap/{tag}/USD/{frame}.json")


def ingest_market_cap(connection: Any, ticker: str) -> int:
    import yfinance as yf

    info = yf.Ticker(ticker).fast_info
    market_cap = info.get("marketCap") if info else None
    if market_cap is None:
        return 0
    with connection.cursor() as cursor:
        cursor.execute(
            """INSERT INTO company_meta (ticker, market_cap, as_of) VALUES (%s, %s, now())
            ON CONFLICT (ticker) DO UPDATE SET market_cap=EXCLUDED.market_cap, as_of=EXCLUDED.as_of""",
            (ticker, market_cap),
        )
    connection.commit()
    return 1


def run(connection: Any) -> None:
    with logged_run(connection, "sec_xbrl") as result:
        session = sec_session()
        limiter = SecRateLimiter()
        max_companies = int(os.environ.get("SEC_XBRL_MAX_COMPANIES_PER_RUN", "100"))
        mapping = ticker_cik_map(session, limiter)
        missing_cik: list[str] = []
        failures: dict[str, str] = {}
        companies = primary_constituents(connection, max_companies)
        for ticker in companies:
            cik = mapping.get(ticker.replace(".", "-")) or mapping.get(ticker)
            if not cik:
                missing_cik.append(ticker)
                continue
            try:
                payload = fetch_json(session, limiter, f"{SEC_DATA}/api/xbrl/companyfacts/CIK{cik}.json")
                rows = normalize_company_facts(payload, ticker)
                result.rows_written += upsert_rows(
                    connection,
                    """INSERT INTO company_facts (cik,ticker,fiscal_period,metric,value,filed_date)
                    VALUES (%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (cik,fiscal_period,metric) DO UPDATE SET
                    ticker=EXCLUDED.ticker,value=EXCLUDED.value,filed_date=EXCLUDED.filed_date""",
                    rows,
                )
                result.rows_written += ingest_market_cap(connection, ticker)
            except Exception as exc:
                failures[ticker] = str(exc)
        result.details = {
            "missing_cik": missing_cik,
            "company_errors": failures,
            "companies_attempted": len(companies),
            "per_run_limit": max_companies,
        }
        if failures:
            raise SourceUnavailable(f"SEC XBRL failed for {len(failures)} companies")
