from datetime import date

from ingest.sources.form_d import sector_for_sic
from ingest.sources.nyt import completed_archive_months, matching_headlines
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


def test_sec_clients_require_contact_user_agent(monkeypatch):
    monkeypatch.setenv("SEC_USER_AGENT", "IndustryScope qa@example.com")
    assert sec_session().headers["User-Agent"] == "IndustryScope qa@example.com"
