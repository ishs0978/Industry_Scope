"""Current sector coverage from the GDELT DOC 2.0 article list.

The NYT Archive API publishes a month at a time and only once that month has
completed, so headlines were structurally a month behind and, mid-month, closer
to seven weeks. A reader looking at an energy page during a war saw nothing
about it.

GDELT indexes articles continuously and its article list returns them newest
first, so this fills the front of the timeline while NYT keeps supplying depth
and history behind it. Both write to the same table and are distinguished by
their source column.

What GDELT gives is a headline, a publisher and a link. There is no abstract and
no editorial section, and the index is broad rather than curated, so a keyword
query catches some unrelated coverage. That is the trade for currency, and the
page says which source a row came from.
"""

from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha1
import os
import time
from typing import Any

import requests

from ingest.registry import Sector, load_sectors
from ingest.sources.common import (
    RateLimiter, SourceUnavailable, logged_run, request_with_backoff, upsert_rows,
)
from ingest.sources.gdelt import (
    GDELT_MIN_INTERVAL_SECONDS, GdeltUnavailable, query_for_sector,
)


# Ask for a wide slice and keep the part that is actually about the sector.
ARTICLES_PER_SECTOR = int(os.environ.get("GDELT_NEWS_ARTICLES_PER_SECTOR", "100"))
KEEP_PER_SECTOR = int(os.environ.get("GDELT_NEWS_KEEP_PER_SECTOR", "30"))
# GDELT enforces a window quota, not a simple interval, and a burst earns a
# cooldown that outlives the run. Once this many sectors fail in a row it is the
# endpoint refusing work, and continuing only lengthens the cooldown.
CONSECUTIVE_FAILURE_LIMIT = int(os.environ.get("GDELT_NEWS_FAILURE_LIMIT", "4"))
# GDELT indexes algorithmic stock-content farms alongside newsrooms, and those
# sites publish the same story against dozens of tickers, so one of them can
# fill a sector's coverage on its own. Capping each publisher spreads the list
# across sources without anyone having to judge which publishers are good.
MAX_PER_DOMAIN = int(os.environ.get("GDELT_NEWS_MAX_PER_DOMAIN", "2"))
# One call per sector at the shared 12-second spacing is about four minutes for
# 21 sectors. The budget stops a slow run from crowding the sources after it.
MAX_SECONDS = float(os.environ.get("GDELT_NEWS_MAX_SECONDS", "900"))


def article_id(url: str) -> str:
    """A stable id for an article, so re-running does not duplicate it."""
    return f"gdelt:{sha1(url.encode('utf-8')).hexdigest()[:24]}"


def parse_seen_date(value: str | None) -> datetime | None:
    """GDELT stamps articles as 20260822T141500Z."""
    text = (value or "").strip()
    try:
        return datetime.strptime(text, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def clean_title(value: str | None) -> str:
    """GDELT pads punctuation out into its own token; put the spacing back."""
    text = " ".join((value or "").split())
    for spaced, tight in ((" ?", "?"), (" !", "!"), (" ,", ","), (" .", "."), (" :", ":"), (" ;", ";")):
        text = text.replace(spaced, tight)
    return text.strip()


# Words that describe how a keyword is phrased rather than what it is about.
# "energy sector" is about energy; "sector" on its own selects nothing.
STRUCTURAL_WORDS = frozenset({
    "sector", "company", "companies", "industry", "industries",
    "stock", "stocks", "market", "markets", "and", "the", "for",
})


def headline_terms(sector: Sector) -> frozenset[str]:
    """The words from a sector's keywords that can carry a headline.

    The keywords are phrases written for GDELT's full-text matching, so they
    rarely appear intact in a title. Their individual words do.
    """
    return frozenset(
        word
        for keyword in sector.news_keywords
        for word in "".join(c if c.isalnum() else " " for c in keyword.lower()).split()
        if len(word) >= 3 and word not in STRUCTURAL_WORDS
    )


def relevance(title: str, terms: frozenset[str]) -> int:
    """How many of the sector's terms the headline itself carries.

    GDELT matches the whole article, so a query for the energy sector returns
    pieces that mention a pipeline once in passing: a restaurant opening and an
    index round-up both came back for energy. Requiring the subject to reach the
    headline is what separates coverage of a sector from coverage that merely
    touches it, and the count orders what survives.
    """
    words = set("".join(c if c.isalnum() else " " for c in title.lower()).split())
    return len(words & terms)


def article_rows(
    payload: dict[str, Any], sector: Sector, *, keep: int = KEEP_PER_SECTOR,
) -> tuple[list[tuple[Any, ...]], int]:
    """Rows for one response, and how many articles were considered.

    Returns the most relevant articles rather than simply the newest, because
    the newest match is often the least about the sector.
    """
    terms = headline_terms(sector)
    scored: list[tuple[int, tuple[Any, ...]]] = []
    seen: set[str] = set()
    considered = 0
    for article in payload.get("articles") or []:
        considered += 1
        url = (article.get("url") or "").strip()
        title = clean_title(article.get("title"))
        published = parse_seen_date(article.get("seendate"))
        if not url or not title or published is None or url in seen:
            continue
        seen.add(url)
        score = relevance(title, terms)
        if not score:
            continue
        scored.append((score, (
            article_id(url), sector.slug, published,
            # The publisher is the useful attribution here; GDELT has no
            # editorial section to report, so that column stays empty rather
            # than being filled with something invented.
            (article.get("domain") or "GDELT").strip(),
            title, None, None, url, score,
        )))
    # Most relevant first, newest breaking the tie.
    scored.sort(key=lambda item: (item[0], item[1][2]), reverse=True)
    per_domain: dict[str, int] = {}
    rows: list[tuple[Any, ...]] = []
    for _, row in scored:
        domain = row[3]
        if per_domain.get(domain, 0) >= MAX_PER_DOMAIN:
            continue
        per_domain[domain] = per_domain.get(domain, 0) + 1
        rows.append(row)
        if len(rows) >= keep:
            break
    # Back to newest-first so the timeline reads in date order.
    rows.sort(key=lambda row: row[2], reverse=True)
    return rows, considered


def fetch_articles(
    session: requests.Session, sector: Sector, *, limiter: RateLimiter, limit: int,
) -> dict[str, Any]:
    response = request_with_backoff(
        session, "GET", "https://api.gdeltproject.org/api/v2/doc/doc",
        limiter=limiter, base_delay=GDELT_MIN_INTERVAL_SECONDS, attempts=3,
        params={
            "query": f"{query_for_sector(sector)} sourcelang:english",
            "mode": "artlist", "format": "json",
            "maxrecords": limit, "sort": "datedesc",
        },
    )
    try:
        return response.json()
    except ValueError as exc:
        # GDELT answers 200 with plain text when it is unhappy, and a rate
        # limit reads identically to a malformed query. Keep the body.
        snippet = " ".join(response.text[:200].split())
        raise GdeltUnavailable(
            f"GDELT returned non-JSON (HTTP {response.status_code}): {snippet}"
        ) from exc


UPSERT = """
INSERT INTO headlines (id,sector_slug,published_date,source,headline,abstract,section,url,relevance_score)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
ON CONFLICT (id) DO UPDATE SET
    published_date=EXCLUDED.published_date, source=EXCLUDED.source,
    headline=EXCLUDED.headline, url=EXCLUDED.url,
    relevance_score=EXCLUDED.relevance_score
"""


def starved_first(connection: Any, sectors: list[Sector]) -> list[Sector]:
    """Order sectors by how stale their coverage is, emptiest first.

    GDELT's quota stops a run well before it reaches 21 sectors, so the order
    decides who ever gets data. Rotating by date spread the starvation around
    but never converged, because a sector could be skipped on the day it came
    up and wait a full cycle. Asking the table who has the oldest article means
    each run picks up exactly where the last one gave out.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """SELECT sector_slug, max(published_date) FROM headlines
               WHERE starts_with(id, 'gdelt:') GROUP BY sector_slug"""
        )
        newest = dict(cursor.fetchall())
    # A sector with nothing sorts first; after that, the oldest coverage wins.
    return sorted(sectors, key=lambda sector: (newest.get(sector.slug) is not None, newest.get(sector.slug)))


def run(connection: Any) -> None:
    with logged_run(connection, "gdelt_news") as result:
        session = requests.Session()
        session.headers.update({"User-Agent": os.environ.get("SEC_USER_AGENT", "IndustryScope")})
        limiter = RateLimiter(1 / GDELT_MIN_INTERVAL_SECONDS)
        deadline = time.monotonic() + MAX_SECONDS
        # A 429 defers every sector after it, so a fixed order would always
        # starve the same tail. Serving the emptiest sectors first means
        # successive runs converge instead of circling.
        sectors = starved_first(connection, load_sectors())

        failures: dict[str, str] = {}
        covered: list[str] = []
        newest: datetime | None = None
        considered = 0
        attempted = 0
        consecutive_failures = 0
        stopped_early = None
        for sector in sectors:
            if time.monotonic() >= deadline:
                stopped_early = "time budget"
                break
            if consecutive_failures >= CONSECUTIVE_FAILURE_LIMIT:
                stopped_early = f"{consecutive_failures} sectors failed in a row"
                break
            attempted += 1
            try:
                payload = fetch_articles(
                    session, sector, limiter=limiter, limit=ARTICLES_PER_SECTOR,
                )
            except Exception as exc:
                failures[sector.slug] = f"{type(exc).__name__}: {exc}"[:200]
                consecutive_failures += 1
                continue
            consecutive_failures = 0
            rows, looked_at = article_rows(payload, sector)
            considered += looked_at
            if not rows:
                continue
            result.rows_written += upsert_rows(connection, UPSERT, rows)
            covered.append(sector.slug)
            latest = max(row[2] for row in rows)
            newest = latest if newest is None else max(newest, latest)

        result.details = {
            "sectors_covered": len(covered),
            "sectors_attempted": attempted,
            "sectors_total": len(sectors),
            "articles_considered": considered,
            "articles_kept": result.rows_written,
            "newest_article": newest.isoformat() if newest else None,
            "stopped_early": stopped_early,
            "sector_errors": dict(list(failures.items())[:6]),
            "sector_error_count": len(failures),
        }
        # Every attempted sector failing is the endpoint refusing work, which is
        # worth a failed run. A few failing is normal for a shared free service,
        # and the rotation means a different few get the chance tomorrow.
        if failures and not covered:
            raise SourceUnavailable(
                f"GDELT article list returned nothing for {len(failures)} sectors"
            )
