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
# Revenue has no single tag across industries, and taking whichever one a filer
# happens to report produces nonsense rather than a blank. Camden Property Trust
# files no Revenues at all, so the contract-revenue tag was used instead: a $5M
# ancillary fee line against $119M of net income, printed as a 2,333% margin.
# A bank's equivalent is net interest income, a REIT's is rental income, and an
# insurer's is premiums. All of them are collected so the panel can resolve the
# right one per company rather than divide by the wrong line.
REVENUE_TAGS = (
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "RevenuesNetOfInterestExpense",
    "InterestAndDividendIncomeOperating",
    "InterestIncomeExpenseNet",
    "OperatingLeaseLeaseIncome",
    "RealEstateRevenueNet",
    "PremiumsEarnedNet",
    "SalesRevenueNet",
)

US_GAAP_TAGS = (
    *REVENUE_TAGS,
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
    """Constituents to fetch next: never-seen first, then heaviest first.

    One run cannot walk 800 companies inside the SEC's rate limit, so the order
    decides who is covered and who is missing until the next one. Ordering by
    ticker meant the answer was the alphabet: coverage stopped in the F's, and
    on nine of twelve funds the single largest holding was the one absent. A
    sector page then showed a median of whichever companies happened to sort
    early, with XOM missing from Energy at 20.6% of the fund.

    Weight is the honest tie-break. A fund's largest position is the one whose
    absence distorts the page most, so it is fetched first, and the tail fills
    in over subsequent runs.
    """
    primary = [sector.primary_etf for sector in load_sectors()]
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH constituents AS (
                SELECT h.constituent_ticker, max(h.weight) AS weight
                FROM holdings h
                JOIN (
                SELECT fund_ticker, max(as_of) AS as_of
                FROM holdings WHERE fund_ticker = ANY(%s) GROUP BY fund_ticker
                ) latest USING (fund_ticker, as_of)
                WHERE h.constituent_ticker ~ '^[A-Z][A-Z0-9.-]*$'
                  AND h.weight > 0
                GROUP BY h.constituent_ticker
            )
            SELECT c.constituent_ticker
            FROM constituents c
            LEFT JOIN company_facts ON company_facts.ticker = c.constituent_ticker
            GROUP BY c.constituent_ticker, c.weight
            ORDER BY max(company_facts.filed_date) ASC NULLS FIRST, c.weight DESC
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


# Market caps are written by company_prices, which fetches them alongside the
# multiples and analyst figures in one call per company. This module used to
# write them too, from a second call with its own timestamp, so the same ticker
# could carry two values in one build: NVDA read $5.27T on one page and $5.20T
# on another. One writer, one as-of date.


def store_reporting_companies(connection: Any, mapping: dict[str, str]) -> int:
    """Record which CIKs belong to companies with a listed security.

    Form D is a private placement exemption, not a private company register: a
    listed company placing securities privately files the same form. Without
    this, Roblox, HEICO, MasTec and Dillard's all appeared under a heading about
    private companies.
    """
    rows = [(cik, ticker, None) for ticker, cik in mapping.items()]
    return upsert_rows(
        connection,
        """INSERT INTO reporting_companies (cik, ticker, name) VALUES (%s,%s,%s)
        ON CONFLICT (cik) DO UPDATE SET ticker = EXCLUDED.ticker""",
        rows,
    )


def coverage_by_fund(connection: Any) -> dict[str, Any]:
    """How much of each fund the fundamentals actually cover.

    Reported so a partial walk is visible in the run record rather than only on
    the page, and so the guard below has something to assert against.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH latest AS (
                SELECT h.fund_ticker, h.constituent_ticker, h.weight
                FROM holdings h
                JOIN (SELECT fund_ticker, max(as_of) AS as_of FROM holdings GROUP BY fund_ticker)
                     m USING (fund_ticker, as_of)
                WHERE h.weight > 0
            )
            SELECT
                count(*) FILTER (WHERE f.ticker IS NULL) AS uncovered,
                count(*) AS total,
                round(100 * sum(l.weight) FILTER (WHERE f.ticker IS NOT NULL) / NULLIF(sum(l.weight),0)) AS weight_covered
            FROM latest l
            LEFT JOIN (SELECT DISTINCT ticker FROM company_facts) f ON f.ticker = l.constituent_ticker
            """
        )
        uncovered, total, weight = cursor.fetchone()
    return {
        "constituents_without_facts": int(uncovered or 0),
        "constituents_total": int(total or 0),
        "percent_of_fund_weight_covered": int(weight or 0),
    }


def run(connection: Any) -> None:
    with logged_run(connection, "sec_xbrl") as result:
        session = sec_session()
        limiter = SecRateLimiter()
        # 100 a week against ~800 constituents took two months to cycle, so most
        # of every fund was missing at any moment. The SEC's limit is ten
        # requests a second; the real bound is how long the job may run.
        max_companies = int(os.environ.get("SEC_XBRL_MAX_COMPANIES_PER_RUN", "400"))
        max_seconds = float(os.environ.get("SEC_XBRL_MAX_SECONDS", "1200"))
        deadline = time.monotonic() + max_seconds
        mapping = ticker_cik_map(session, limiter)
        reporting = store_reporting_companies(connection, mapping)
        missing_cik: list[str] = []
        failures: dict[str, str] = {}
        companies = primary_constituents(connection, max_companies)
        attempted = 0
        for ticker in companies:
            if time.monotonic() >= deadline:
                break
            attempted += 1
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
            except Exception as exc:
                failures[ticker] = str(exc)
        result.details = {
            "missing_cik": missing_cik[:20],
            "missing_cik_count": len(missing_cik),
            "company_errors": dict(list(failures.items())[:10]),
            "company_error_count": len(failures),
            "companies_attempted": attempted,
            "companies_selected": len(companies),
            "per_run_limit": max_companies,
            "reporting_companies_known": reporting,
            **coverage_by_fund(connection),
        }
        if failures:
            raise SourceUnavailable(f"SEC XBRL failed for {len(failures)} companies")
