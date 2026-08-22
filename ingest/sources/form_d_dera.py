"""SEC DERA Form D quarterly data sets.

The SEC publishes every Form D filing as flattened quarterly TSVs going back to
2008Q3, so the full history is ~30 ZIP downloads rather than one primary_doc.xml
per filing. These files are the only practical way to hold more than the current
quarter, and they are the authority for every quarter they cover.

Data sets publish shortly after a quarter closes. The quarter in progress is
covered by the EDGAR crawl in `form_d`; when its data set publishes, the rows it
contributed are replaced rather than merged.
"""

from __future__ import annotations

from contextlib import closing
import csv
from datetime import date
import io
import os
from pathlib import Path
import re
import tempfile
import time
from typing import Any, Iterator
import zipfile

import requests

from ingest.sources.common import SourceUnavailable, logged_run, request
from ingest.sources.form_d import rebuild_derived
from ingest.sources.form_d_common import (
    ISSUER_COLUMNS,
    OFFERING_COLUMNS,
    SUBMISSION_COLUMNS,
    copy_upsert,
    parse_date,
    parse_flag,
    parse_int,
    parse_number,
)
from ingest.sources.sec_xbrl import SecRateLimiter, sec_session


DATASETS_PAGE = "https://www.sec.gov/data-research/sec-markets-data/form-d-data-sets"
# Form D became an electronic filing on 2008-09-15. Nothing before 2008Q3 exists
# as a filed submission, so earlier data sets are never requested.
EARLIEST_QUARTER = "2008Q3"
DEFAULT_START_QUARTER = "2019Q1"
ZIP_NAME = re.compile(r"/(\d{4})q([1-4])_d(?:_\d+)?\.zip$", re.IGNORECASE)


def quarter_of(value: date) -> str:
    return f"{value.year}Q{(value.month - 1) // 3 + 1}"


def quarter_bounds(quarter: str) -> tuple[date, date]:
    """Half-open [start, end) bounds for a quarter label such as "2026Q2"."""
    year, index = int(quarter[:4]), int(quarter[-1])
    start_month = (index - 1) * 3 + 1
    end = date(year + 1, 1, 1) if index == 4 else date(year, start_month + 3, 1)
    return date(year, start_month, 1), end


def dataset_links(html: str) -> dict[str, str]:
    """Map "2019Q1" to the absolute ZIP URL advertised on the data sets page.

    These URLs cannot be constructed. The SEC serves some quarters from
    /files/structureddata/ and others from /files/datastandardsinnovation/, and
    some filenames carry a "_0" suffix left by a re-upload. The page is the only
    authority on which file exists where.
    """
    links: dict[str, str] = {}
    for href in re.findall(r'href="([^"]+)"', html):
        match = ZIP_NAME.search(href)
        if not match:
            continue
        quarter = f"{match.group(1)}Q{match.group(2)}"
        if quarter < EARLIEST_QUARTER:
            continue
        links[quarter] = href if href.startswith("http") else f"https://www.sec.gov{href}"
    return links


def download(session: requests.Session, url: str, destination: Path, *, timeout: float) -> int:
    """Stream a data set to disk in chunks rather than holding it in memory."""
    written = 0
    with session.get(url, stream=True, timeout=timeout) as response:
        response.raise_for_status()
        with destination.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1 << 16):
                handle.write(chunk)
                written += len(chunk)
    if written == 0:
        raise SourceUnavailable(f"{url} returned an empty file")
    return written


def iter_tsv(archive: zipfile.ZipFile, table: str) -> Iterator[dict[str, str]]:
    """Yield rows of one member as a stream, so peak memory is one row.

    Members sit under a quarter-named directory inside the archive, so the
    member is matched on its filename rather than a full path.
    """
    names = [name for name in archive.namelist() if name.upper().endswith(f"{table}.TSV")]
    if not names:
        raise SourceUnavailable(f"{table}.tsv missing from the data set")
    with archive.open(names[0]) as raw:
        # A few issuer names carry bytes that are not valid UTF-8. Replacing
        # keeps one bad character from failing an entire quarter.
        yield from csv.DictReader(
            io.TextIOWrapper(raw, encoding="utf-8", errors="replace", newline=""),
            delimiter="\t",
        )


def submission_row(record: dict[str, str], quarter: str) -> tuple[Any, ...]:
    return (
        record["ACCESSIONNUMBER"].strip(),
        record.get("FILE_NUM", "").strip() or None,
        parse_date(record.get("FILING_DATE")),
        record.get("SIC_CODE", "").strip() or None,
        record.get("SUBMISSIONTYPE", "").strip() or None,
        "dera",
        quarter,
    )


def issuer_row(record: dict[str, str]) -> tuple[Any, ...]:
    return (
        record["ACCESSIONNUMBER"].strip(),
        parse_int(record.get("ISSUER_SEQ_KEY")),
        parse_flag(record.get("IS_PRIMARYISSUER_FLAG")),
        record.get("CIK", "").strip() or None,
        record.get("ENTITYNAME", "").strip() or None,
        record.get("STATEORCOUNTRY", "").strip() or None,
    )


def offering_row(record: dict[str, str]) -> tuple[Any, ...]:
    return (
        record["ACCESSIONNUMBER"].strip(),
        record.get("INDUSTRYGROUPTYPE", "").strip() or None,
        record.get("INVESTMENTFUNDTYPE", "").strip() or None,
        parse_flag(record.get("ISAMENDMENT")),
        record.get("PREVIOUSACCESSIONNUMBER", "").strip() or None,
        parse_date(record.get("SALE_DATE")),
        parse_flag(record.get("ISEQUITYTYPE")),
        parse_flag(record.get("ISDEBTTYPE")),
        parse_flag(record.get("ISOPTIONTOACQUIRETYPE")),
        parse_flag(record.get("ISPOOLEDINVESTMENTFUNDTYPE")),
        parse_number(record.get("TOTALOFFERINGAMOUNT")),
        parse_number(record.get("TOTALAMOUNTSOLD")),
    )


def live_submissions(archive: zipfile.ZipFile, quarter: str) -> tuple[dict[str, tuple[Any, ...]], int]:
    """Submission rows for live filings, and how many rows were dropped.

    A test filing is a filer rehearsal, not a securities offering, so it must
    never reach a dollar total. Its issuer and offering rows are dropped with it
    because the loaders below only accept accessions present here.
    """
    rows: dict[str, tuple[Any, ...]] = {}
    dropped = 0
    for record in iter_tsv(archive, "FORMDSUBMISSION"):
        accession = record.get("ACCESSIONNUMBER", "").strip()
        live = (record.get("TESTORLIVE") or "").strip().upper() == "LIVE"
        if not accession or not live or parse_date(record.get("FILING_DATE")) is None:
            dropped += 1
            continue
        rows[accession] = submission_row(record, quarter)
    return rows, dropped


def supersede_edgar_rows(connection: Any, quarter: str) -> int:
    """Drop the interim EDGAR rows for a quarter now that its data set exists."""
    start, end = quarter_bounds(quarter)
    with connection.cursor() as cursor:
        cursor.execute(
            """DELETE FROM form_d_submission_raw
            WHERE source = 'edgar' AND filing_date >= %s AND filing_date < %s""",
            (start, end),
        )
        removed = cursor.rowcount
        # The issuer and offering tables have no index on source, so the orphan
        # sweep is a full scan. Backfilling a quarter the EDGAR crawl never
        # touched is the common case, and it must not pay for that scan.
        if removed:
            for table in ("form_d_issuer_raw", "form_d_offering_raw"):
                cursor.execute(
                    f"""DELETE FROM {table} t WHERE NOT EXISTS (
                        SELECT 1 FROM form_d_submission_raw s WHERE s.accession_no = t.accession_no
                    )"""
                )
    connection.commit()
    return removed


def load_quarter(
    connection: Any,
    quarter: str,
    url: str,
    *,
    session: requests.Session,
    limiter: SecRateLimiter,
    timeout: float,
) -> dict[str, int]:
    """Load one published quarter into staging and record that it is loaded."""
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / f"{quarter}.zip"
        limiter.wait()
        size = download(session, url, path, timeout=timeout)
        with closing(zipfile.ZipFile(path)) as archive:
            submissions, dropped = live_submissions(archive, quarter)
            if not submissions:
                raise SourceUnavailable(f"{quarter} data set contained no live submissions")
            superseded = supersede_edgar_rows(connection, quarter)
            written = {
                "submissions": copy_upsert(
                    connection, "form_d_submission_raw", SUBMISSION_COLUMNS, submissions.values()
                ),
                "issuers": copy_upsert(
                    connection, "form_d_issuer_raw", ISSUER_COLUMNS,
                    (
                        issuer_row(record)
                        for record in iter_tsv(archive, "ISSUERS")
                        if record.get("ACCESSIONNUMBER", "").strip() in submissions
                        and parse_int(record.get("ISSUER_SEQ_KEY")) is not None
                    ),
                ),
                "offerings": copy_upsert(
                    connection, "form_d_offering_raw", OFFERING_COLUMNS,
                    (
                        offering_row(record)
                        for record in iter_tsv(archive, "OFFERING")
                        if record.get("ACCESSIONNUMBER", "").strip() in submissions
                    ),
                ),
            }

    with connection.cursor() as cursor:
        cursor.execute(
            """INSERT INTO form_d_dera_quarter
            (quarter, source_url, submissions, issuers, offerings, test_filings_dropped, loaded_at)
            VALUES (%s,%s,%s,%s,%s,%s,now())
            ON CONFLICT (quarter) DO UPDATE SET
                source_url = EXCLUDED.source_url,
                submissions = EXCLUDED.submissions,
                issuers = EXCLUDED.issuers,
                offerings = EXCLUDED.offerings,
                test_filings_dropped = EXCLUDED.test_filings_dropped,
                loaded_at = now()""",
            (quarter, url, written["submissions"], written["issuers"], written["offerings"], dropped),
        )
    connection.commit()
    return {
        **written,
        "test_filings_dropped": dropped,
        "bytes": size,
        "edgar_rows_superseded": superseded,
    }


def pending_quarters(
    links: dict[str, str], loaded: set[str], start_quarter: str, today: date
) -> list[str]:
    """Published quarters still to load, oldest first.

    The quarter in progress is excluded: it belongs to the EDGAR crawl until its
    data set publishes.
    """
    current = quarter_of(today)
    return sorted(
        quarter for quarter in links
        if start_quarter <= quarter < current and quarter not in loaded
    )


def run(connection: Any) -> None:
    with logged_run(connection, "form_d_dera") as result:
        session = sec_session()
        limiter = SecRateLimiter()
        timeout = float(os.environ.get("SEC_REQUEST_TIMEOUT_SECONDS", "60"))
        start_quarter = os.environ.get("FORM_D_DERA_START_QUARTER", DEFAULT_START_QUARTER).upper()
        max_quarters = int(os.environ.get("FORM_D_DERA_MAX_QUARTERS", "4"))
        max_seconds = float(os.environ.get("FORM_D_DERA_MAX_SECONDS", "900"))
        deadline = time.monotonic() + max_seconds

        limiter.wait()
        page = request(session, "GET", DATASETS_PAGE, timeout=timeout)
        links = dataset_links(page.text)
        if not links:
            raise SourceUnavailable("no Form D data set links found on the SEC data sets page")

        with connection.cursor() as cursor:
            cursor.execute("SELECT quarter FROM form_d_dera_quarter")
            loaded = {row[0] for row in cursor.fetchall()}

        today = date.today()
        pending = pending_quarters(links, loaded, start_quarter, today)
        totals = {"submissions": 0, "issuers": 0, "offerings": 0, "test_filings_dropped": 0}
        loaded_now: list[str] = []
        for quarter in pending[:max_quarters]:
            if time.monotonic() >= deadline:
                break
            counts = load_quarter(
                connection, quarter, links[quarter],
                session=session, limiter=limiter, timeout=timeout,
            )
            for key in totals:
                totals[key] += counts[key]
            loaded_now.append(quarter)
            result.rows_written += counts["submissions"] + counts["issuers"] + counts["offerings"]

        remaining = len(pending) - len(loaded_now)
        result.details = {
            "advertised_quarters": len(links),
            "start_quarter": start_quarter,
            "already_loaded": len(loaded),
            "quarters_loaded": loaded_now,
            "quarters_remaining": remaining,
            "current_quarter_from_edgar": quarter_of(today),
            **totals,
            # Only the quarters loaded this run can have changed, and they are
            # contiguous from the earliest one forward.
            **(
                rebuild_derived(connection, since=quarter_bounds(min(loaded_now))[0])
                if loaded_now else {}
            ),
        }
