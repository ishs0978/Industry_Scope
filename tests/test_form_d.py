from datetime import date

from ingest.sources.form_d import (
    INDUSTRY_GROUP_SECTORS,
    full_index_rows,
    header_values,
    parse_filing,
    sector_for_industry_group,
)
from ingest.sources.form_d_common import (
    POOLED_INDUSTRY_GROUP,
    POOLED_NAME_PATTERNS,
    ISSUER_COLUMNS,
    OFFERING_COLUMNS,
    REBUILD_SQL,
    SUBMISSION_COLUMNS,
    parse_date,
    parse_flag,
    parse_number,
)
from ingest.sources.form_d_dera import (
    dataset_links,
    issuer_row,
    offering_row,
    pending_quarters,
    quarter_bounds,
    quarter_of,
    submission_row,
)


def field(columns, row, name):
    """Read a staging row by column name, so tests do not encode positions."""
    return row[columns.index(name)]


DATASETS_PAGE = """
<a href="/files/structureddata/data/form-d-data-sets/2008q2_d_0.zip">2008 Q2</a>
<a href="/files/structureddata/data/form-d-data-sets/2019q1_d.zip">2019 Q1</a>
<a href="/files/structureddata/data/form-d-data-sets/2019q2_d_0.zip">2019 Q2</a>
<a href="/files/datastandardsinnovation/data/form-d-data-sets/2026q2_d.zip">2026 Q2</a>
<a href="/files/structureddata/data/financial-statement-data-sets/2026q1.zip">not Form D</a>
"""


def test_dataset_links_reads_both_directories_and_reupload_suffixes():
    links = dataset_links(DATASETS_PAGE)
    # The URLs cannot be constructed: the SEC moved recent quarters to a
    # different directory and left "_0" suffixes on re-uploaded files.
    assert links["2019Q1"].endswith("/structureddata/data/form-d-data-sets/2019q1_d.zip")
    assert links["2019Q2"].endswith("2019q2_d_0.zip")
    assert links["2026Q2"].endswith("/datastandardsinnovation/data/form-d-data-sets/2026q2_d.zip")
    assert all(link.startswith("https://www.sec.gov/") for link in links.values())
    # Form D became an electronic filing in September 2008, so 2008Q2 holds
    # nothing worth requesting, and other data sets must not be picked up.
    assert "2008Q2" not in links
    assert "2026Q1" not in links


def test_quarter_bounds_are_half_open_and_wrap_the_year():
    assert quarter_bounds("2026Q2") == (date(2026, 4, 1), date(2026, 7, 1))
    assert quarter_bounds("2026Q4") == (date(2026, 10, 1), date(2027, 1, 1))
    assert quarter_of(date(2026, 8, 22)) == "2026Q3"


def test_pending_skips_loaded_quarters_and_the_quarter_in_progress():
    links = {"2018Q4": "", "2019Q1": "", "2019Q2": "", "2026Q2": "", "2026Q3": ""}
    pending = pending_quarters(links, {"2019Q1"}, "2019Q1", date(2026, 8, 22))
    # 2018Q4 predates the configured start, 2019Q1 is already loaded, and
    # 2026Q3 is still in progress and belongs to the EDGAR crawl.
    assert pending == ["2019Q2", "2026Q2"]


def test_full_index_keeps_one_record_per_accession():
    # EDGAR indexes a co-issued filing once per filer CIK, all pointing at the
    # same document. Fetching it three times would put the same offering into
    # the staging tables under three different index rows.
    text = (
        "CIK|Company Name|Form Type|Date Filed|Filename\n"
        "1|Alpha One|D|2026-08-01|edgar/data/1/0000000001-26-000001.txt\n"
        "2|Alpha Two|D|2026-08-01|edgar/data/1/0000000001-26-000001.txt\n"
        "3|Alpha Three|D|2026-08-01|edgar/data/1/0000000001-26-000001.txt\n"
        "4|Beta Corp|D/A|2026-08-02|edgar/data/4/0000000004-26-000001.txt\n"
    )
    rows = full_index_rows(text)
    assert len(rows) == 2
    assert [row["name"] for row in rows] == ["Alpha One", "Beta Corp"]


def test_header_supplies_the_file_number_that_the_xml_never_carries():
    header = (
        "<SEC-HEADER>x\n"
        "ACCESSION NUMBER:\t\t0002144207-26-000001\n"
        "\t\tSTANDARD INDUSTRIAL CLASSIFICATION:\tSTATE COMMERCIAL BANKS [6022]\n"
        "\t\tSEC FILE NUMBER:\t021-594432\n"
        "\t\tFILM NUMBER:\t\t261286005\n"
        "</SEC-HEADER>\nSEC FILE NUMBER: 021-000000\n"
    )
    # The 021 file number is assigned by EDGAR and is the only key that ties an
    # original to its amendments; primary_doc.xml does not contain it. Only the
    # header is read, never the document body.
    assert header_values(header) == ("021-594432", "6022")
    assert header_values("<SEC-HEADER>\nnothing here\n</SEC-HEADER>") == (None, None)


CO_ISSUED = """<edgarSubmission>
  <submissionType>D</submissionType>
  <testOrLive>LIVE</testOrLive>
  <primaryIssuer><cik>0000000001</cik><entityName>Alpha One</entityName>
    <issuerAddress><stateOrCountry>NY</stateOrCountry></issuerAddress></primaryIssuer>
  <issuerList>
    <issuer><cik>0000000002</cik><entityName>Alpha Two</entityName></issuer>
    <issuer><cik>0000000003</cik><entityName>Alpha Three</entityName></issuer>
  </issuerList>
  <offeringData>
    <industryGroup><industryGroupType>Oil and Gas</industryGroupType></industryGroup>
    <typesOfSecuritiesOffered><isEquityType>true</isEquityType></typesOfSecuritiesOffered>
    <offeringSalesAmounts><totalAmountSold>295000000</totalAmountSold></offeringSalesAmounts>
  </offeringData>
</edgarSubmission>"""


def test_co_issuers_produce_one_offering_and_several_issuer_rows():
    submission, issuers, offering = parse_filing(
        CO_ISSUED, "0000000001-26-000001", date(2026, 8, 17), "021-000001", None,
    )
    # This is the shape that makes over-counting possible: three issuer rows
    # against one offering row. The dollars live only on the offering row.
    assert len(issuers) == 3
    assert [field(ISSUER_COLUMNS, row, "issuer_seq_key") for row in issuers] == [101, 102, 103]
    assert [field(ISSUER_COLUMNS, row, "is_primary_issuer") for row in issuers] == [True, False, False]
    assert [field(ISSUER_COLUMNS, row, "entity_name") for row in issuers] == [
        "Alpha One", "Alpha Two", "Alpha Three"]
    assert field(OFFERING_COLUMNS, offering, "total_amount_sold") == 295_000_000
    assert field(SUBMISSION_COLUMNS, submission, "file_num") == "021-000001"
    assert isinstance(offering, tuple)


def test_test_filings_are_dropped_before_they_can_reach_a_total():
    xml = CO_ISSUED.replace("<testOrLive>LIVE</testOrLive>", "<testOrLive>TEST</testOrLive>")
    assert parse_filing(xml, "0000000001-26-000001", date(2026, 8, 17), None, None) is None


def test_staging_records_an_unticked_box_the_way_the_data_sets_do():
    _, _, offering = parse_filing(
        CO_ISSUED, "0000000001-26-000001", date(2026, 8, 17), None, None,
    )
    equity, debt, option = (
        field(OFFERING_COLUMNS, offering, "is_equity_type"),
        field(OFFERING_COLUMNS, offering, "is_debt_type"),
        field(OFFERING_COLUMNS, offering, "is_option_to_acquire_type"),
    )
    # The XML omits a box the filer did not tick and the data sets leave the
    # column blank. Staging keeps both as null so a row looks the same whichever
    # collector wrote it; writing false here made `is_debt_type = false` return
    # EDGAR rows only.
    assert (equity, debt, option) == (True, None, None)


def test_the_rebuild_reads_an_unticked_box_as_a_no():
    # A checkbox has no third state, so the read model resolves the blank.
    sql = executable_sql(REBUILD_SQL)
    for column in ("is_equity_type", "is_debt_type", "is_option_to_acquire_type"):
        assert f"COALESCE(o.{column}, false)" in sql


DERA_SUBMISSION = {
    "ACCESSIONNUMBER": "0000000001-26-000001", "FILE_NUM": "021-000001",
    "FILING_DATE": "30-JUN-2026", "SIC_CODE": "", "SCHEMAVERSION": "X0708",
    "SUBMISSIONTYPE": "D", "TESTORLIVE": "LIVE",
    "OVER100PERSONSFLAG": "", "OVER100ISSUERFLAG": "",
}
DERA_ISSUER = {
    "ACCESSIONNUMBER": "0000000001-26-000001", "ISSUER_SEQ_KEY": "101",
    "IS_PRIMARYISSUER_FLAG": "YES", "CIK": "0000000001", "ENTITYNAME": "Alpha One",
}
DERA_OFFERING = {
    "ACCESSIONNUMBER": "0000000001-26-000001", "INDUSTRYGROUPTYPE": "Oil and Gas",
    "ISAMENDMENT": "false", "TOTALOFFERINGAMOUNT": "Indefinite",
    "TOTALAMOUNTSOLD": "295000000", "ISEQUITYTYPE": "true", "SALE_DATE": "2026-05-31",
}


def test_both_collectors_write_the_same_columns():
    # The rebuild reads staging without knowing which collector wrote a row, so
    # a data set row and an EDGAR row have to be the same shape.
    edgar = parse_filing(CO_ISSUED, "0000000001-26-000001", date(2026, 8, 17), "021-000001", None)
    dera = (submission_row(DERA_SUBMISSION, "2026Q2"), [issuer_row(DERA_ISSUER)], offering_row(DERA_OFFERING))
    for columns, edgar_row, dera_row in (
        (SUBMISSION_COLUMNS, edgar[0], dera[0]),
        (ISSUER_COLUMNS, edgar[1][0], dera[1][0]),
        (OFFERING_COLUMNS, edgar[2], dera[2]),
    ):
        assert len(edgar_row) == len(columns)
        assert len(dera_row) == len(columns)
    assert field(SUBMISSION_COLUMNS, edgar[0], "source") == "edgar"
    assert field(SUBMISSION_COLUMNS, dera[0], "source") == "dera"
    assert field(SUBMISSION_COLUMNS, dera[0], "dera_quarter") == "2026Q2"


def test_data_set_dates_and_flags_parse_in_both_shapes():
    # FILING_DATE is DD-MON-YYYY while SALE_DATE is ISO, in the same file.
    assert parse_date("30-JUN-2026") == date(2026, 6, 30)
    assert parse_date("2026-05-31") == date(2026, 5, 31)
    assert parse_date("") is None
    assert (parse_flag("true"), parse_flag("YES"), parse_flag("")) == (True, True, None)
    # "Indefinite" and a blank mean not reported; a reported zero is a real
    # datapoint and the two must not collapse together.
    assert parse_number("Indefinite") is None
    assert parse_number("") is None
    assert parse_number("0") == 0.0


def test_industry_map_keys_are_all_reachable():
    # The lookup normalizes "&" to "and" before matching, so a key that keeps an
    # ampersand can never be hit. One did, and Tourism & Travel Services
    # filings went unattributed because of it.
    for key in INDUSTRY_GROUP_SECTORS:
        assert key == " ".join(key.strip().lower().replace("&", "and").split())
        assert sector_for_industry_group(key) == INDUSTRY_GROUP_SECTORS[key]


def test_rebuild_never_joins_issuers_as_a_multiplier():
    # The offering tables are already at accession grain. Any plain join to the
    # issuer table repeats an accession once per issuer, which multiplies its
    # dollar amount by the issuer count. The issuer table may only be reached
    # through LATERAL subqueries that return exactly one row.
    body = REBUILD_SQL.split("FROM form_d_submission_raw", 1)[1]
    for fragment in body.split("form_d_issuer_raw")[:-1]:
        assert fragment.rstrip().endswith("FROM"), fragment[-120:]
        assert "JOIN LATERAL (" in fragment
    assert body.count("LIMIT 1") >= 1
    assert "count(*)::int AS total" in body


def test_pooled_industry_key_is_in_the_normalized_form_the_sql_compares():
    # The rebuild lowercases and collapses the filer's answer before comparing,
    # so a constant that is not already in that form would never match.
    assert POOLED_INDUSTRY_GROUP == " ".join(
        POOLED_INDUSTRY_GROUP.strip().lower().replace("&", "and").split()
    )
    # It is deliberately absent from the sector map: the exclusion replaces the
    # attribution rather than competing with it.
    assert POOLED_INDUSTRY_GROUP not in INDUSTRY_GROUP_SECTORS


def test_pooled_vehicles_are_excluded_on_the_filer_s_own_two_answers():
    condition = REBUILD_SQL[REBUILD_SQL.index("AND NOT ("):]
    # The industry the filer selected, and the securities-type box.
    assert "%(pooled_industry)s" in condition
    assert "o.is_pooled_investment_fund_type IS TRUE" in condition
    # A bare boolean test would be null for the filings that leave the box
    # blank, and NOT null drops the row instead of keeping it.
    assert "OR o.is_pooled_investment_fund_type\n" not in condition


def executable_sql(query: str) -> str:
    """The query with comment lines removed, so guards read what actually runs."""
    return "\n".join(
        line for line in query.splitlines() if not line.lstrip().startswith("--")
    )


def test_a_name_can_never_exclude_a_filing():
    # Name matching is a hint, not evidence. "LP" is the legal suffix of plenty
    # of operating businesses, so a match has to stay visible in a column and
    # must never reach the WHERE clause.
    sql = executable_sql(REBUILD_SQL)
    where = sql[sql.index("WHERE COALESCE"):]
    assert "pooled_name" not in where
    # It is selected as a column instead.
    assert "pooled_name.label" in sql[: sql.index("FROM form_d_submission_raw")]
    assert "pooled_name_match" in sql[: sql.index("FROM form_d_submission_raw")]


def test_name_patterns_are_ordered_from_most_to_least_specific():
    labels = [label for label, _ in POOLED_NAME_PATTERNS]
    # The rebuild takes the first match, so the vague one has to come last or it
    # would mask "Separate account" on a name carrying both.
    assert labels[-1] == "Limited partnership"
    assert {"Separate account", "Collective trust", "Income fund"} <= set(labels)
    assert len(set(labels)) == len(labels)
