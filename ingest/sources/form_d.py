"""SEC EDGAR full-index and Form D XML ingestion."""

from __future__ import annotations

from datetime import date
import os
import re
import time
from typing import Any
from xml.etree import ElementTree

from ingest.registry import load_sectors
from ingest.sources.common import SourceUnavailable, logged_run, request, upsert_rows
from ingest.sources.sec_xbrl import SecRateLimiter, fetch_json, sec_session


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
    "tourism & travel services": "consumer-discretionary",
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
    return records


def _text(root: ElementTree.Element, local_name: str) -> str | None:
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] == local_name and element.text:
            return element.text.strip()
    return None


def parse_form_d_xml(xml_text: str, accession_no: str, filed_date: date, cik: str, sic: str | None) -> tuple[Any, ...]:
    match = re.search(r"(<edgarSubmission[\s\S]*?</edgarSubmission>)", xml_text)
    if not match:
        raise SourceUnavailable(f"Form D XML missing in {accession_no}")
    root = ElementTree.fromstring(match.group(1))
    issuer_name = _text(root, "entityName") or _text(root, "issuerName")
    if not issuer_name:
        raise SourceUnavailable(f"Form D issuer name missing in {accession_no}")

    def number(tag: str) -> float | None:
        value = _text(root, tag)
        if value in {None, "", "Indefinite"}:
            return None
        try:
            return float(value.replace(",", ""))
        except ValueError:
            return None

    industry_group = _text(root, "industryGroupType")
    return (
        accession_no, filed_date, cik, issuer_name, sic,
        sector_for_filing(industry_group, sic),
        number("totalOfferingAmount"), number("totalAmountSold"), _text(root, "stateOrCountry"),
        # submissionType distinguishes an original filing from an amendment.
        # previousAccessionNumber, present on most amendments, chains a
        # restatement back to the offering it supersedes.
        _text(root, "submissionType"), _text(root, "previousAccessionNumber"),
        industry_group,
    )


def run(connection: Any) -> None:
    with logged_run(connection, "form_d") as result:
        session = sec_session()
        limiter = SecRateLimiter()
        today = date.today()
        quarter = (today.month - 1) // 3 + 1
        request_timeout = float(os.environ.get("SEC_REQUEST_TIMEOUT_SECONDS", "20"))
        max_seconds = float(os.environ.get("FORM_D_MAX_SECONDS", "180"))
        max_filings = int(os.environ.get("FORM_D_MAX_FILINGS", "250"))
        deadline = time.monotonic() + max_seconds
        limiter.wait()
        index_url = f"https://www.sec.gov/Archives/edgar/full-index/{today.year}/QTR{quarter}/master.idx"
        response = request(session, "GET", index_url, timeout=request_timeout)
        records = sorted(full_index_rows(response.text), key=lambda item: item["filed"], reverse=True)
        with connection.cursor() as cursor:
            cursor.execute("SELECT accession_no FROM form_d")
            existing = {row[0] for row in cursor.fetchall()}
        failures: dict[str, str] = {}
        timed_out = False
        submissions_by_cik: dict[str, dict[str, Any]] = {}
        candidates = [record for record in records if record["filename"].rsplit("/", 1)[-1].replace(".txt", "") not in existing]
        limited = candidates[:max_filings]
        for index, record in enumerate(limited):
            if time.monotonic() >= deadline:
                timed_out = True
                result.details = {
                    "filing_errors": failures,
                    "index": index_url,
                    "timed_out": True,
                    "remaining_filings": len(candidates) - index,
                }
                break
            accession = record["filename"].rsplit("/", 1)[-1].replace(".txt", "")
            try:
                limiter.wait()
                filing = request(
                    session, "GET", f"https://www.sec.gov/Archives/{record['filename']}",
                    timeout=request_timeout,
                )
                cik10 = record["cik"].zfill(10)
                submissions = submissions_by_cik.get(cik10)
                if submissions is None:
                    submissions = fetch_json(
                        session, limiter, f"https://data.sec.gov/submissions/CIK{cik10}.json",
                        timeout=request_timeout,
                    )
                    submissions_by_cik[cik10] = submissions
                sic = str(submissions.get("sic")) if submissions.get("sic") else None
                row = parse_form_d_xml(filing.text, accession, date.fromisoformat(record["filed"]), cik10, sic)
                result.rows_written += upsert_rows(
                    connection,
                    """INSERT INTO form_d (accession_no,filed_date,cik,issuer_name,sic_code,sector_slug,total_offering_amount,amount_sold,state,submission_type,previous_accession_no,industry_group)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (accession_no) DO NOTHING""",
                    [row],
                )
            except Exception as exc:
                failures[accession] = str(exc)
        result.details = {
            **result.details,
            "filing_errors": failures,
            "index": index_url,
            "candidate_filings": len(candidates),
            "processed_limit": max_filings,
            "more_available": len(candidates) > len(limited),
        }
        if failures:
            raise SourceUnavailable(f"Form D failed for {len(failures)} filings")
        if timed_out:
            raise SourceUnavailable(f"Form D exceeded its {max_seconds:.0f}-second run budget")
