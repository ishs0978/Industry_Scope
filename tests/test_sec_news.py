from datetime import date

import ingest.sources.nyt as nyt_source
from ingest.sources.form_d import full_index_rows, parse_form_d_xml, sector_for_sic
from ingest.sources.nyt import DEFAULT_MAX_MONTHS_PER_RUN, completed_archive_months, matching_headlines
from ingest.sources.sec_xbrl import normalize_company_facts
from ingest.sources.sec_xbrl import sec_session


def test_sec_facts_keep_latest_filing_and_missing_tags_blank():
    payload = {
        "cik": 123,
        "facts": {"us-gaap": {"GrossProfit": {"units": {"USD": [
            {"frame": "CY2024Q1", "val": 10, "filed": "2024-04-01"},
            {"frame": "CY2024Q1", "val": 12, "filed": "2024-05-01"},
        ]}}}},
    }
    rows = normalize_company_facts(payload, "TEST")
    assert rows == [("0000000123", "TEST", "CY2024Q1", "GrossProfit", 12, "2024-05-01")]


def test_sic_mapping_uses_registry_prefixes_only():
    assert sector_for_sic("1311") == "energy"
    assert sector_for_sic("9999") is None


def test_full_index_collects_originals_and_amendments():
    text = (
        "CIK|Company Name|Form Type|Date Filed|Filename\n"
        "1|Alpha Corp|D|2026-08-01|edgar/data/1/0001.txt\n"
        "2|Beta Corp|D/A|2026-08-02|edgar/data/2/0002.txt\n"
        "3|Gamma Corp|8-K|2026-08-03|edgar/data/3/0003.txt\n"
    )
    rows = full_index_rows(text)
    # Amendments restate an offering's cumulative total, so they must be
    # collected; unrelated form types must not be.
    assert [row["form"] for row in rows] == ["D", "D/A"]


def test_form_d_xml_captures_submission_type_and_amendment_chain():
    xml = """<edgarSubmission>
      <submissionType>D/A</submissionType>
      <primaryIssuer><entityName>Beta Corp</entityName><stateOrCountry>DE</stateOrCountry></primaryIssuer>
      <offeringData>
        <previousAccessionNumber>0000000000-26-000001</previousAccessionNumber>
        <offeringSalesAmounts>
          <totalOfferingAmount>10000000</totalOfferingAmount>
          <totalAmountSold>9000000</totalAmountSold>
        </offeringSalesAmounts>
      </offeringData>
    </edgarSubmission>"""
    row = parse_form_d_xml(xml, "0000000000-26-000002", date(2026, 8, 2), "0000000002", "7372")
    assert row[0] == "0000000000-26-000002"
    assert row[6] == 10_000_000
    assert row[7] == 9_000_000
    assert row[9] == "D/A"
    assert row[10] == "0000000000-26-000001"


def test_form_d_xml_marks_an_original_filing_with_no_chain():
    xml = """<edgarSubmission>
      <submissionType>D</submissionType>
      <primaryIssuer><entityName>Alpha Corp</entityName></primaryIssuer>
      <offeringData><offeringSalesAmounts><totalAmountSold>4000000</totalAmountSold></offeringSalesAmounts></offeringData>
    </edgarSubmission>"""
    row = parse_form_d_xml(xml, "0000000000-26-000001", date(2026, 8, 1), "0000000001", "1311")
    assert row[9] == "D"
    assert row[10] is None


def test_nyt_matching_stores_only_allowed_metadata():
    documents = [{
        "_id": "nyt://article/1", "pub_date": "2024-01-01T00:00:00Z",
        "headline": {"main": "Semiconductor industry expands"},
        "abstract": "A semiconductor report.", "snippet": "", "section_name": "Business",
        "web_url": "https://www.nytimes.com/example", "lead_paragraph": "must not be stored",
    }]
    rows = matching_headlines(documents)
    assert rows
    assert all("must not be stored" not in str(row) for row in rows)


def test_nyt_archive_excludes_incomplete_current_month():
    months = completed_archive_months(date(2026, 8, 12), {(2026, 6)})
    assert months[:3] == [(2026, 7), (2026, 5), (2026, 4)]
    assert (2026, 8) not in months


def test_nyt_backfill_is_bounded_to_one_month_per_run():
    assert DEFAULT_MAX_MONTHS_PER_RUN == 1


def test_nyt_registry_is_loaded_once_per_archive(monkeypatch):
    original = nyt_source.load_sectors
    calls = 0

    def counted_load():
        nonlocal calls
        calls += 1
        return original()

    monkeypatch.setattr(nyt_source, "load_sectors", counted_load)
    documents = [{
        "_id": f"nyt://article/{index}",
        "pub_date": "2026-07-01T00:00:00Z",
        "headline": {"main": "Semiconductor industry expands"},
        "abstract": "", "snippet": "", "section_name": "Business",
        "web_url": f"https://www.nytimes.com/example-{index}",
    } for index in range(2)]

    assert nyt_source.matching_headlines(documents)
    assert calls == 1


def test_sec_clients_require_contact_user_agent(monkeypatch):
    monkeypatch.setenv("SEC_USER_AGENT", "IndustryScope qa@example.com")
    assert sec_session().headers["User-Agent"] == "IndustryScope qa@example.com"


def test_industry_group_beats_missing_sic():
    from ingest.sources.form_d import sector_for_filing, sector_for_industry_group
    # EDGAR leaves `sic` blank for most private issuers, which is why 98% of
    # stored filings had no sector at all. The filer's own answer fills it.
    assert sector_for_filing("Other Technology", None) == "technology"
    assert sector_for_filing("Oil & Gas", None) == "energy"
    assert sector_for_filing("Biotechnology", None) == "healthcare-pharma"
    assert sector_for_industry_group("ELECTRIC UTILITIES") == "utilities"
    assert sector_for_industry_group(None) is None


def test_pooled_investment_funds_are_not_an_industry():
    from ingest.sources.form_d import sector_for_filing
    # A feeder fund raising capital is not an operating industry; attributing it
    # to one would overstate that sector.
    assert sector_for_filing("Pooled Investment Fund", None) is None
    assert sector_for_filing("Business Services", None) is None
    assert sector_for_filing("Other", None) is None


def test_sic_still_used_when_industry_group_is_absent():
    from ingest.sources.form_d import sector_for_filing
    assert sector_for_filing(None, "1311") == "energy"
    assert sector_for_filing("Other", "1311") == "energy"


def test_industry_group_tolerates_ampersand_spelling():
    from ingest.sources.form_d import sector_for_industry_group
    # EDGAR emits "and" while the printed form shows "&". Real filings used both
    # and 25 of them went unattributed until this was handled.
    assert sector_for_industry_group("Other Banking and Financial Services") == "banks"
    assert sector_for_industry_group("Other Banking & Financial Services") == "banks"
    assert sector_for_industry_group("REITS and Finance") == "real-estate"
    assert sector_for_industry_group("REITS & Finance") == "real-estate"
    assert sector_for_industry_group("Oil & Gas") == "energy"
    assert sector_for_industry_group("Oil and Gas") == "energy"
