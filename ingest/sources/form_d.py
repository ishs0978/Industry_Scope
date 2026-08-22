"""Current-quarter Form D from the EDGAR full index and primary_doc.xml.

Published quarters come from the DERA data sets (see form_d_dera). This
module covers only the quarter those data sets have not published yet, and
writes into the same staging tables with source 'edgar' so both paths feed
one derivation. When the data set for the quarter publishes it replaces
these rows rather than merging with them.
"""

from __future__ import annotations

from datetime import date
import os
import re
import time
from typing import Any
from xml.etree import ElementTree

from ingest.registry import load_sectors
from ingest.sources import form_d_common
from ingest.sources.common import SourceUnavailable, logged_run, request
from ingest.sources.form_d_common import parse_date, parse_flag, parse_number
from ingest.sources.sec_xbrl import SecRateLimiter, sec_session


# Form D asks the issuer to pick its own industry from a fixed list, and EDGAR
# leaves `sic` blank for most private issuers and pooled funds. The filer's own
# answer is therefore both better populated and closer to the truth than the SIC
# metadata, so it is tried first.
#
# "Pooled Investment Fund", "Business Services" and "Other" are deliberately
# unmapped: a feeder fund raising capital is not an operating industry, and
# attributing it to one would overstate that sector.
INDUSTRY_GROUP_SECTORS = {
    "coal mining": "materials-mining",
    "electric utilities": "utilities",
    "energy conservation": "clean-energy",
    "environmental services": "clean-energy",
    "oil and gas": "energy",
    "other energy": "energy",
    "commercial banking": "banks",
    "insurance": "banks",
    "investing": "banks",
    "investment banking": "banks",
    "other banking and financial services": "banks",
    "biotechnology": "healthcare-pharma",
    "health insurance": "healthcare-pharma",
    "hospitals and physicians": "healthcare-pharma",
    "pharmaceuticals": "healthcare-pharma",
    "other health care": "healthcare-pharma",
    "computers": "technology",
    "other technology": "technology",
    "telecommunications": "communication-services",
    "commercial": "real-estate",
    "reits and finance": "real-estate",
    "other real estate": "real-estate",
    "construction": "homebuilders",
    "residential": "homebuilders",
    "manufacturing": "industrials",
    "retailing": "consumer-discretionary",
    "restaurants": "consumer-discretionary",
    "lodging and conventions": "consumer-discretionary",
    "tourism and travel services": "consumer-discretionary",
    "other travel": "consumer-discretionary",
    "airlines and airports": "transport-shipping",
    "agriculture": "consumer-staples",
}


def sector_for_industry_group(industry_group: str | None) -> str | None:
    """Look up a Form D industry group, tolerating "&" versus "and".

    EDGAR emits "Other Banking and Financial Services" and "REITS and Finance"
    while the printed form uses ampersands, so both spellings must resolve.
    """
    if not industry_group:
        return None
    key = " ".join(industry_group.strip().lower().replace("&", "and").split())
    return INDUSTRY_GROUP_SECTORS.get(key)


def sector_for_filing(industry_group: str | None, sic_code: str | None) -> str | None:
    """Resolve a filing to a sector, preferring the issuer's own classification."""
    return sector_for_industry_group(industry_group) or sector_for_sic(sic_code)


def sector_for_sic(sic_code: str | None) -> str | None:
    """Resolve a SIC code to one sector by longest matching prefix.

    The registry rejects two sectors claiming an identical prefix, so the
    longest match is always unambiguous. Nested prefixes are intentional and
    resolve to the more specific sector: 7373 is cybersecurity while the rest of
    737, including 7372, is software-cloud; 3674 is semiconductors while the
    rest of 367 is technology; 4931 is clean-energy while the rest of 49,
    including 4911, is utilities.
    """
    if not sic_code:
        return None
    matches = [
        (len(prefix), sector.slug)
        for sector in load_sectors()
        for prefix in sector.sic_prefixes
        if sic_code.startswith(prefix)
    ]
    return max(matches)[1] if matches else None


FORM_D_TYPES = {"D", "D/A"}
# How many filings to hold before writing them to staging.
FLUSH_EVERY = 250


def sic_prefix_pairs() -> list[tuple[str, str]]:
    """The registry's SIC prefixes flattened for the rebuild's lookup table."""
    return [
        (prefix, sector.slug)
        for sector in load_sectors()
        for prefix in sector.sic_prefixes
    ]


def rebuild_derived(connection: Any, *, since: date | None = None) -> dict[str, int]:
    """Rebuild form_d from staging using this module's sector attribution."""
    return form_d_common.rebuild_derived(
        connection, INDUSTRY_GROUP_SECTORS, sic_prefix_pairs(), since=since,
    )


def full_index_rows(text: str) -> list[dict[str, str]]:
    marker = "CIK|Company Name|Form Type|Date Filed|Filename"
    if marker not in text:
        raise SourceUnavailable("SEC full index header not found")
    records = []
    for line in text.split(marker, 1)[1].splitlines():
        parts = line.strip().split("|")
        # Amendments file as "D/A" and restate the cumulative amount raised.
        # They are collected so dollar aggregates can read the latest figure for
        # an offering; excluding them leaves amended offerings understated.
        if len(parts) == 5 and parts[2] in FORM_D_TYPES:
            records.append(dict(zip(("cik", "name", "form", "filed", "filename"), parts)))
    # An accession naming co-issuers is indexed once per filer CIK, so the same
    # filename appears several times. Keeping one record per accession is what
    # stops a co-issued filing from being fetched and counted more than once.
    unique: dict[str, dict[str, str]] = {}
    for record in records:
        unique.setdefault(accession_of(record["filename"]), record)
    return list(unique.values())


def accession_of(filename: str) -> str:
    return filename.rsplit("/", 1)[-1].replace(".txt", "")


FILE_NUMBER = re.compile(r"^\s*SEC FILE NUMBER:\s*(\S+)\s*$", re.MULTILINE)
SIC_IN_HEADER = re.compile(r"STANDARD INDUSTRIAL CLASSIFICATION:.*?\[(\d{3,4})\]")


def header_values(text: str) -> tuple[str | None, str | None]:
    """Read the offering file number and filer SIC from the SEC-SGML header.

    The 021-XXXXXX file number is assigned by EDGAR and never appears in
    primary_doc.xml, but it is the key that ties an original to its amendments.
    The header is already being downloaded, so both come for free.
    """
    header = text.split("</SEC-HEADER>", 1)[0]
    file_number = FILE_NUMBER.search(header)
    sic = SIC_IN_HEADER.search(header)
    return (
        file_number.group(1) if file_number else None,
        sic.group(1) if sic else None,
    )


def _local(element: ElementTree.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _text(root: ElementTree.Element, local_name: str) -> str | None:
    for element in root.iter():
        if _local(element) == local_name and element.text:
            return element.text.strip()
    return None


def _child_text(element: ElementTree.Element | None, local_name: str) -> str | None:
    if element is None:
        return None
    for child in element.iter():
        if _local(child) == local_name and child.text:
            return child.text.strip()
    return None


def _find(root: ElementTree.Element, local_name: str) -> ElementTree.Element | None:
    for element in root.iter():
        if _local(element) == local_name:
            return element
    return None


def issuer_elements(root: ElementTree.Element) -> list[ElementTree.Element]:
    """Every issuer named on the filing, primary first.

    A Form D can name co-issuers, which the schema puts in `issuerList` beside
    the single `primaryIssuer`. The data sets give each one an ISSUER_SEQ_KEY
    starting at 101, so the same numbering is used here.
    """
    primary = _find(root, "primaryIssuer")
    issuers = [primary] if primary is not None else []
    listed = _find(root, "issuerList")
    if listed is not None:
        issuers.extend(child for child in listed if _local(child) == "issuer")
    return issuers


def parse_filing(
    xml_text: str, accession_no: str, filed_date: date, file_num: str | None, sic: str | None
) -> tuple[tuple[Any, ...], list[tuple[Any, ...]], tuple[Any, ...]] | None:
    """Split one primary_doc.xml into staging rows, or None for a test filing.

    Returns rows shaped exactly like the data set rows so both collectors write
    the same columns and the rebuild does not need to know where a row came from.
    """
    match = re.search(r"(<edgarSubmission[\s\S]*?</edgarSubmission>)", xml_text)
    if not match:
        raise SourceUnavailable(f"Form D XML missing in {accession_no}")
    root = ElementTree.fromstring(match.group(1))
    if (_text(root, "testOrLive") or "LIVE").strip().upper() != "LIVE":
        return None

    issuers = issuer_elements(root)
    if not issuers or not _child_text(issuers[0], "entityName"):
        raise SourceUnavailable(f"Form D issuer name missing in {accession_no}")
    submission_type = _text(root, "submissionType")

    submission = (
        accession_no, file_num, filed_date, sic, submission_type, "edgar", None,
    )
    # Sequence keys start at 101 so an EDGAR row and a data set row for the same
    # filing carry the same issuer numbering.
    issuer_rows = [
        (
            accession_no,
            101 + index,
            index == 0,
            _child_text(issuer, "cik"),
            _child_text(issuer, "entityName"),
            _child_text(issuer, "stateOrCountry"),
        )
        for index, issuer in enumerate(issuers)
    ]

    securities = _find(root, "typesOfSecuritiesOffered")

    def security(local_name: str) -> bool | None:
        # The schema omits a box the filer did not tick, exactly as the data
        # sets leave the column blank. Staging keeps that shape so both sources
        # look the same; the rebuild is the one place that reads absence as a
        # "no", because a checkbox has no third state.
        return parse_flag(_child_text(securities, local_name))

    offering = (
        accession_no,
        _text(root, "industryGroupType"),
        _text(root, "investmentFundType"),
        parse_flag(_text(root, "isAmendment")),
        _text(root, "previousAccessionNumber"),
        parse_date(_child_text(_find(root, "dateOfFirstSale"), "value")),
        security("isEquityType"),
        security("isDebtType"),
        security("isOptionToAcquireType"),
        security("isPooledInvestmentFundType"),
        parse_number(_text(root, "totalOfferingAmount")),
        parse_number(_text(root, "totalAmountSold")),
    )
    return submission, issuer_rows, offering


def loaded_quarters(connection: Any) -> set[str]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT quarter FROM form_d_dera_quarter")
        return {row[0] for row in cursor.fetchall()}


def run(connection: Any) -> None:
    with logged_run(connection, "form_d") as result:
        session = sec_session()
        limiter = SecRateLimiter()
        today = date.today()
        quarter = f"{today.year}Q{(today.month - 1) // 3 + 1}"
        quarter_start = date(today.year, ((today.month - 1) // 3) * 3 + 1, 1)
        request_timeout = float(os.environ.get("SEC_REQUEST_TIMEOUT_SECONDS", "20"))
        max_seconds = float(os.environ.get("FORM_D_MAX_SECONDS", "180"))
        # Each filing is now one request; the issuer SIC comes from the same
        # header rather than a second call to the submissions API, so the
        # unchanged time budget reaches roughly twice as many filings.
        max_filings = int(os.environ.get("FORM_D_MAX_FILINGS", "600"))
        deadline = time.monotonic() + max_seconds

        # Once the data set for this quarter publishes it is authoritative, and
        # re-crawling the same filings would only reintroduce interim rows.
        if quarter in loaded_quarters(connection):
            result.details = {"skipped": True, "quarter": quarter, "reason": "covered by the published data set"}
            return

        limiter.wait()
        index_url = f"https://www.sec.gov/Archives/edgar/full-index/{today.year}/QTR{quarter[-1]}/master.idx"
        response = request(session, "GET", index_url, timeout=request_timeout)
        records = sorted(full_index_rows(response.text), key=lambda item: item["filed"], reverse=True)
        with connection.cursor() as cursor:
            cursor.execute("SELECT accession_no FROM form_d_submission_raw WHERE source = 'edgar'")
            existing = {row[0] for row in cursor.fetchall()}

        failures: dict[str, str] = {}
        batch: list[tuple[tuple[Any, ...], list[tuple[Any, ...]], tuple[Any, ...]]] = []
        test_filings = 0
        staged = 0
        candidates = [record for record in records if accession_of(record["filename"]) not in existing]
        limited = candidates[:max_filings]
        processed = 0
        co_issued = 0

        def flush() -> int:
            """Persist what has been fetched so far.

            A catch-up run can spend a quarter of an hour on one quarter, and
            holding every row until the end means a timeout or a transport error
            throws all of it away. Flushing in batches makes the next run resume
            from where this one stopped instead of starting over.
            """
            if not batch:
                return 0
            written = (
                form_d_common.copy_upsert(
                    connection, "form_d_submission_raw", form_d_common.SUBMISSION_COLUMNS,
                    [item[0] for item in batch],
                )
                + form_d_common.copy_upsert(
                    connection, "form_d_issuer_raw", form_d_common.ISSUER_COLUMNS,
                    [row for item in batch for row in item[1]],
                )
                + form_d_common.copy_upsert(
                    connection, "form_d_offering_raw", form_d_common.OFFERING_COLUMNS,
                    [item[2] for item in batch],
                )
            )
            batch.clear()
            return written

        for record in limited:
            if time.monotonic() >= deadline:
                break
            processed += 1
            accession = accession_of(record["filename"])
            try:
                limiter.wait()
                filing = request(
                    session, "GET", f"https://www.sec.gov/Archives/{record['filename']}",
                    timeout=request_timeout,
                )
                file_num, sic = header_values(filing.text)
                parsed = parse_filing(
                    filing.text, accession, date.fromisoformat(record["filed"]), file_num, sic,
                )
                if parsed is None:
                    test_filings += 1
                    continue
                co_issued += len(parsed[1]) > 1
                batch.append(parsed)
                if len(batch) >= FLUSH_EVERY:
                    staged += flush()
            except Exception as exc:
                failures[accession] = str(exc)
        staged += flush()
        result.rows_written = staged
        result.details = {
            # A catch-up run can look at thousands of filings, so only a sample
            # of the errors is persisted; the count carries the rest.
            "filing_errors": dict(list(failures.items())[:20]),
            "filing_error_count": len(failures),
            "index": index_url,
            "quarter": quarter,
            "candidate_filings": len(candidates),
            "processed": processed,
            "processed_limit": max_filings,
            "test_filings_dropped": test_filings,
            "co_issued_filings": co_issued,
            "more_available": len(candidates) > processed,
            # This crawl only ever touches the quarter in progress, so the
            # rebuild is scoped to it rather than rewriting the whole table.
            **(rebuild_derived(connection, since=quarter_start) if staged else {}),
        }
        if failures:
            raise SourceUnavailable(f"Form D failed for {len(failures)} filings")
