"""SEC EDGAR full-index and Form D XML ingestion."""

from __future__ import annotations

from datetime import date
import re
from typing import Any
from xml.etree import ElementTree

from ingest.registry import load_sectors
from ingest.sources.common import SourceUnavailable, logged_run, upsert_rows
from ingest.sources.sec_xbrl import SecRateLimiter, fetch_json, sec_session


def sector_for_sic(sic_code: str | None) -> str | None:
    if not sic_code:
        return None
    matches = [
        (len(prefix), sector.slug)
        for sector in load_sectors()
        for prefix in sector.sic_prefixes
        if sic_code.startswith(prefix)
    ]
    return max(matches)[1] if matches else None


def full_index_rows(text: str) -> list[dict[str, str]]:
    marker = "CIK|Company Name|Form Type|Date Filed|Filename"
    if marker not in text:
        raise SourceUnavailable("SEC full index header not found")
    records = []
    for line in text.split(marker, 1)[1].splitlines():
        parts = line.strip().split("|")
        if len(parts) == 5 and parts[2] == "D":
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

    return (
        accession_no, filed_date, cik, issuer_name, sic, sector_for_sic(sic),
        number("totalOfferingAmount"), number("totalAmountSold"), _text(root, "stateOrCountry"),
    )


def run(connection: Any) -> None:
    session = sec_session()
    limiter = SecRateLimiter()
    today = date.today()
    quarter = (today.month - 1) // 3 + 1
    with logged_run(connection, "form_d") as result:
        limiter.wait()
        index_url = f"https://www.sec.gov/Archives/edgar/full-index/{today.year}/QTR{quarter}/master.idx"
        response = session.get(index_url, timeout=45)
        response.raise_for_status()
        records = full_index_rows(response.text)
        with connection.cursor() as cursor:
            cursor.execute("SELECT accession_no FROM form_d")
            existing = {row[0] for row in cursor.fetchall()}
        failures: dict[str, str] = {}
        rows = []
        for record in records:
            accession = record["filename"].rsplit("/", 1)[-1].replace(".txt", "")
            if accession in existing:
                continue
            try:
                limiter.wait()
                filing = session.get(f"https://www.sec.gov/Archives/{record['filename']}", timeout=45)
                filing.raise_for_status()
                cik10 = record["cik"].zfill(10)
                submissions = fetch_json(session, limiter, f"https://data.sec.gov/submissions/CIK{cik10}.json")
                sic = str(submissions.get("sic")) if submissions.get("sic") else None
                rows.append(parse_form_d_xml(filing.text, accession, date.fromisoformat(record["filed"]), cik10, sic))
            except Exception as exc:
                failures[accession] = str(exc)
        result.rows_written = upsert_rows(
            connection,
            """INSERT INTO form_d (accession_no,filed_date,cik,issuer_name,sic_code,sector_slug,total_offering_amount,amount_sold,state)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (accession_no) DO NOTHING""",
            rows,
        )
        result.details = {"filing_errors": failures, "index": index_url}
        if failures:
            raise SourceUnavailable(f"Form D failed for {len(failures)} filings")

