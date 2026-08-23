"""Shared Form D staging load and derived-table rebuild.

Two collectors write here: the DERA quarterly data sets for published quarters
and the EDGAR full index for the quarter DERA has not published yet. Both land
in the same staging tables at the grain the SEC publishes, and one rebuild
derives `form_d` from them.

The grain matters. FORMDSUBMISSION and OFFERING carry one row per accession;
ISSUERS carries one row per accession plus issuer sequence key, so a filing with
co-issuers has several rows there. Every dollar figure lives in OFFERING and is
therefore already at accession grain. Joining issuers to offerings and summing
would multiply an offering by its issuer count, which is why the rebuild reaches
the issuer table only through LATERAL subqueries that return one row.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Iterable, Mapping, Sequence

from ingest.sources.common import SourceUnavailable


MONTHS = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}


def parse_flag(value: str | None) -> bool | None:
    """Read a Form D checkbox. Absent is unanswered, not false.

    The data sets write "true"/"false" for offering flags and "YES"/"NO" for the
    primary-issuer flag, and leave a box blank when the filer did not tick it.
    """
    text = (value or "").strip().upper()
    if text in {"TRUE", "YES", "Y", "1"}:
        return True
    if text in {"FALSE", "NO", "N", "0"}:
        return False
    return None


def parse_number(value: str | None) -> float | None:
    """Parse a reported dollar amount, treating "Indefinite" as not reported.

    A blank or "Indefinite" is not reported; a literal "0" is a reported zero.
    The two stay distinct because a null contributes to filing counts only while
    a zero is a real datapoint.
    """
    text = (value or "").strip().replace(",", "")
    if not text or text.lower() == "indefinite":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_int(value: str | None) -> int | None:
    text = (value or "").strip().replace(",", "")
    try:
        return int(float(text))
    except ValueError:
        return None


def parse_date(value: str | None) -> date | None:
    """Accept both shapes the sources use: 30-JUN-2026 and 2026-05-31."""
    text = (value or "").strip()
    if not text:
        return None
    parts = text.split("-")
    if len(parts) == 3 and parts[1].upper() in MONTHS:
        try:
            return date(int(parts[2]), MONTHS[parts[1].upper()], int(parts[0]))
        except ValueError:
            return None
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


# Only what the derived table and the published stats consume. The data sets
# carry far more; holding all of it for the whole history costs more storage
# than this database has, and anything dropped is one re-download away.
SUBMISSION_COLUMNS = (
    "accession_no", "file_num", "filing_date", "sic_code", "submission_type",
    "source", "dera_quarter",
)
ISSUER_COLUMNS = (
    "accession_no", "issuer_seq_key", "is_primary_issuer", "cik", "entity_name",
    "state_or_country",
)
OFFERING_COLUMNS = (
    "accession_no", "industry_group_type", "investment_fund_type", "is_amendment",
    "previous_accession_no", "sale_date", "is_equity_type", "is_debt_type",
    "is_option_to_acquire_type", "is_pooled_investment_fund_type",
    "total_offering_amount", "total_amount_sold",
)
UPSERT_KEYS = {
    "form_d_submission_raw": ("accession_no",),
    "form_d_issuer_raw": ("accession_no", "issuer_seq_key"),
    "form_d_offering_raw": ("accession_no",),
}


def copy_upsert(
    connection: Any,
    table: str,
    columns: tuple[str, ...],
    rows: Iterable[tuple[Any, ...]],
) -> int:
    """Load rows through COPY into a scratch table, then upsert into the target.

    One quarter is ~17,000 accessions and the history since 2019 is over a
    million rows across the three tables, which is far too many round trips for
    executemany. COPY keeps the load to a single statement, and the follow-up
    INSERT keeps a re-run idempotent: reloading a quarter overwrites its rows
    instead of duplicating or rejecting them.
    """
    keys = UPSERT_KEYS[table]
    column_list = ", ".join(columns)
    assignments = ", ".join(f"{name} = EXCLUDED.{name}" for name in columns if name not in keys)
    written = 0
    with connection.cursor() as cursor:
        cursor.execute(f"CREATE TEMP TABLE scratch_{table} (LIKE {table}) ON COMMIT DROP")
        with cursor.copy(f"COPY scratch_{table} ({column_list}) FROM STDIN") as copy:
            for row in rows:
                copy.write_row(row)
                written += 1
        cursor.execute(
            f"""INSERT INTO {table} ({column_list})
            SELECT {column_list} FROM scratch_{table}
            ON CONFLICT ({', '.join(keys)}) DO UPDATE SET {assignments}"""
        )
    connection.commit()
    return written


# The industry a filer picks when it is a fund rather than an operating
# business. It is the filer's own answer, so it overrides everything else: a
# vehicle that self-identifies as pooled is not an operating industry, whatever
# SIC code EDGAR happens to hold for it.
POOLED_INDUSTRY_GROUP = "pooled investment fund"

# Names that look like a pooled vehicle. This is deliberately not an exclusion.
# "Separate Account" and "Collective Trust" are strong, but "LP" is the legal
# suffix of plenty of operating businesses, and a name is not a filer's
# statement about itself the way the two flags above are. A match is recorded
# and shown so a reader can judge the row, which a silent drop cannot do.
# Ordered most specific first; the first match wins.
POOLED_NAME_PATTERNS: tuple[tuple[str, str], ...] = (
    ("Separate account", r"separate account"),
    ("Collective trust", r"collective (investment )?trust"),
    ("Income fund", r"income fund"),
    ("Limited partnership", r"\mL\.?P\.?\M"),
)


# Matches sector_for_industry_group: lowercased, "&" spelled "and", whitespace
# collapsed. EDGAR emits "Other Banking and Financial Services" while the
# printed form uses an ampersand, so both spellings have to resolve.
INDUSTRY_KEY_SQL = (
    r"btrim(regexp_replace(lower(replace(COALESCE(o.industry_group_type, ''), '&', 'and')),"
    r" '\s+', ' ', 'g'))"
)

# One derived row per accession. The dollars come from form_d_offering_raw,
# which is already at accession grain. The issuer table is reached only through
# LATERAL subqueries returning a single row each, so a filing with co-issuers
# yields one row carrying one amount plus a count, never one row per issuer.
REBUILD_SQL = f"""
INSERT INTO form_d (
    accession_no, filed_date, cik, issuer_name, sic_code, sector_slug,
    total_offering_amount, amount_sold, state, submission_type,
    previous_accession_no, industry_group, file_num, is_amendment,
    issuer_count, source, pooled_name_match,
    is_equity_type, is_debt_type, is_option_to_acquire_type, issuer_ticker
)
SELECT
    s.accession_no,
    s.filing_date,
    primary_issuer.cik,
    COALESCE(primary_issuer.entity_name, 'Issuer name not reported'),
    s.sic_code,
    COALESCE(industry.sector_slug, sic.sector_slug),
    o.total_offering_amount,
    o.total_amount_sold,
    primary_issuer.state_or_country,
    s.submission_type,
    o.previous_accession_no,
    o.industry_group_type,
    s.file_num,
    COALESCE(o.is_amendment, upper(COALESCE(s.submission_type, '')) LIKE 'D/A%%'),
    COALESCE(issuer_count.total, 0),
    s.source,
    pooled_name.label,
    -- A blank box is a "no", not an unanswered question, and the two sources
    -- spell blank differently. Normalizing here means `is_debt_type = false`
    -- gives the same answer whichever source the row came from.
    COALESCE(o.is_equity_type, false),
    COALESCE(o.is_debt_type, false),
    COALESCE(o.is_option_to_acquire_type, false),
    -- A listed company placing securities privately files this same form, so
    -- the panel named Roblox and Dillard's under a heading about private
    -- companies. The SEC's own ticker registry settles which is which.
    reporting.ticker
FROM form_d_submission_raw s
LEFT JOIN form_d_offering_raw o ON o.accession_no = s.accession_no
LEFT JOIN LATERAL (
    SELECT i.cik, i.entity_name, i.state_or_country
    FROM form_d_issuer_raw i
    WHERE i.accession_no = s.accession_no
    ORDER BY (i.is_primary_issuer IS NOT TRUE), i.issuer_seq_key
    LIMIT 1
) primary_issuer ON true
LEFT JOIN LATERAL (
    SELECT count(*)::int AS total
    FROM form_d_issuer_raw i
    WHERE i.accession_no = s.accession_no
) issuer_count ON true
LEFT JOIN form_d_industry_map industry ON industry.industry_key = {INDUSTRY_KEY_SQL}
LEFT JOIN LATERAL (
    SELECT m.sector_slug
    FROM form_d_sic_map m
    WHERE s.sic_code IS NOT NULL AND s.sic_code LIKE m.prefix || '%%'
    ORDER BY length(m.prefix) DESC
    LIMIT 1
) sic ON true
LEFT JOIN reporting_companies reporting
    ON reporting.cik = lpad(primary_issuer.cik, 10, '0')
LEFT JOIN LATERAL (
    SELECT p.label
    FROM form_d_pooled_name p
    WHERE primary_issuer.entity_name ~* p.regex
    ORDER BY p.rank
    LIMIT 1
) pooled_name ON true
-- form_d is the application's read model and every page queries it by sector.
-- Two thirds of Form D filings are pooled funds or industries the registry
-- deliberately does not map, and no page can ever read them; carrying them here
-- costs more storage than this database has spare. The staging tables keep every
-- filing, so nothing is lost and a re-derive is all it takes to widen this.
WHERE COALESCE(industry.sector_slug, sic.sector_slug) IS NOT NULL
-- Two source-based exclusions, both the filer's own answer about itself.
--
-- The first is the industry it selected. That answer used to be discarded
-- whenever it was one the registry does not map, because attribution then fell
-- through to EDGAR's SIC code, and a fund carrying a bank's SIC came back as a
-- bank. Selecting "Pooled Investment Fund" is a positive statement, not a
-- missing answer, so it now ends the question.
--
-- The second is the securities-type box: an interest in a pooled investment
-- fund is what is being sold. That catches vehicles which pick an operating
-- industry, such as insurance separate accounts filing under Insurance.
--
-- A name that merely looks like a vehicle is not grounds for exclusion and is
-- recorded in pooled_name_match instead.
  AND NOT (
    {INDUSTRY_KEY_SQL} = %(pooled_industry)s
    -- IS TRUE rather than a bare test: the flag is null on most filings, and a
    -- null here would make the whole condition null and silently drop the row.
    OR o.is_pooled_investment_fund_type IS TRUE
  )
"""


def rebuild_derived(
    connection: Any,
    industry_sectors: Mapping[str, str],
    sic_prefixes: Sequence[tuple[str, str]],
    *,
    since: date | None = None,
) -> dict[str, int]:
    """Rebuild form_d from staging at exactly one row per accession.

    The sector maps are pushed into temp tables rather than restated in SQL, so
    the registry YAML and INDUSTRY_GROUP_SECTORS remain the only definition of
    how a filing is attributed. The SIC join takes the longest matching prefix,
    which is what sector_for_sic does in Python.

    `since` limits the rebuild to filings on or after a date. The daily EDGAR
    crawl can only change the quarter in progress, and rewriting every row of a
    400,000-row table to refresh one quarter is churn this database cannot
    afford. Passing None rebuilds everything, which is what a change to the
    sector maps requires.
    """
    scope = "" if since is None else " AND s.filing_date >= %(since)s"
    parameters = {"since": since, "pooled_industry": POOLED_INDUSTRY_GROUP}
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM form_d_submission_raw s WHERE true" + scope, parameters
        )
        staged = cursor.fetchone()[0]
    if not staged:
        # Rebuilding from empty staging would silently empty the derived table.
        raise SourceUnavailable("Form D staging is empty; refusing to rebuild the derived table")

    with connection.cursor() as cursor:
        cursor.execute(
            "CREATE TEMP TABLE form_d_industry_map"
            " (industry_key text PRIMARY KEY, sector_slug text) ON COMMIT DROP"
        )
        cursor.executemany(
            "INSERT INTO form_d_industry_map (industry_key, sector_slug) VALUES (%s,%s)",
            list(industry_sectors.items()),
        )
        cursor.execute(
            "CREATE TEMP TABLE form_d_sic_map (prefix text, sector_slug text) ON COMMIT DROP"
        )
        cursor.executemany(
            "INSERT INTO form_d_sic_map (prefix, sector_slug) VALUES (%s,%s)",
            list(sic_prefixes),
        )
        cursor.execute(
            "CREATE TEMP TABLE form_d_pooled_name"
            " (rank int, label text, regex text) ON COMMIT DROP"
        )
        cursor.executemany(
            "INSERT INTO form_d_pooled_name (rank, label, regex) VALUES (%s,%s,%s)",
            [(rank, label, regex) for rank, (label, regex) in enumerate(POOLED_NAME_PATTERNS)],
        )
        cursor.execute(
            "DELETE FROM form_d" + ("" if since is None else " WHERE filed_date >= %(since)s"),
            parameters,
        )
        cursor.execute(REBUILD_SQL + scope, parameters)
        written = cursor.rowcount
        cursor.execute(
            """SELECT count(*), count(*) FILTER (WHERE issuer_count > 1),
                      count(DISTINCT file_num), count(*) FILTER (WHERE source = 'edgar'),
                      count(*) FILTER (WHERE pooled_name_match IS NOT NULL),
                      count(*) FILTER (WHERE issuer_ticker IS NOT NULL)
               FROM form_d"""
        )
        rows, co_issued, file_numbers, from_edgar, name_flagged, listed = cursor.fetchone()
    connection.commit()
    return {
        "staged_submissions": staged,
        "derived_rows": written,
        "excluded_or_unattributed_kept_in_staging": staged - written,
        "flagged_by_name_not_excluded": name_flagged,
        "filed_by_listed_companies": listed,
        "accessions": rows,
        "co_issued_accessions": co_issued,
        "distinct_file_numbers": file_numbers,
        "current_quarter_rows_from_edgar": from_edgar,
    }
