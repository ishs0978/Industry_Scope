from datetime import datetime, timezone

from ingest.registry import load_sectors
from ingest.sources.gdelt_news import (
    KEEP_PER_SECTOR, MAX_PER_DOMAIN, article_id, article_rows, clean_title, headline_terms,
    is_boilerplate, normalized_title, parse_seen_date, relevance,
)


ENERGY = {sector.slug: sector for sector in load_sectors()}["energy"]


def article(url: str, title: str, seendate: str = "20260822T141500Z", domain: str = "example.com"):
    return {"url": url, "title": title, "seendate": seendate, "domain": domain}


def test_headline_terms_drop_the_words_that_select_nothing():
    terms = headline_terms(ENERGY)
    # "energy sector" is about energy; "sector" on its own matches anything.
    assert "sector" not in terms
    assert {"oil", "crude", "gas", "pipeline"} <= terms


def test_a_sector_query_returns_articles_that_are_not_about_the_sector():
    # Every one of these came back from GDELT for the energy sector query,
    # because it matches the whole article and a piece can mention a pipeline
    # once in passing. Requiring the subject to reach the headline is what
    # separates the coverage from the noise.
    terms = headline_terms(ENERGY)
    kept = "Saudis Shuttle Oil North On Tankers To Evade Houthis"
    dropped = [
        "NYC Carnegie Deli slated to open early September in restored restaurant",
        "A trade war between Canada and the US further ruptures a once-close bond",
        "Nifty Next 50 records highest monthly gain among indices",
    ]
    assert relevance(kept, terms) >= 1
    assert all(relevance(title, terms) == 0 for title in dropped)


def test_only_relevant_articles_become_rows():
    payload = {"articles": [
        article("https://a.example/1", "China Oil Imports Set to Rebound as Refiners Hunt"),
        article("https://a.example/2", "NYC Carnegie Deli slated to open in September"),
    ]}
    rows, considered = article_rows(payload, ENERGY)
    assert considered == 2
    assert [row[4] for row in rows] == ["China Oil Imports Set to Rebound as Refiners Hunt"]


def test_rows_are_ordered_newest_first_after_ranking():
    payload = {"articles": [
        article("https://a.example/old", "Oil pipeline crude gas output rises", "20260801T000000Z"),
        article("https://a.example/new", "Oil output falls", "20260822T000000Z"),
    ]}
    rows, _ = article_rows(payload, ENERGY)
    # The first headline scores higher, but the timeline reads by date.
    assert [row[4] for row in rows] == ["Oil output falls", "Oil pipeline crude gas output rises"]


def test_the_most_relevant_survive_the_cap():
    # One domain each, so this exercises the overall cap rather than the
    # per-publisher one.
    payload = {"articles": [
        article(
            f"https://a.example/{index}",
            f"Oil rises again in week {index}" if index else "Crude oil gas pipeline surge",
            domain=f"paper{index}.example",
        )
        for index in range(KEEP_PER_SECTOR + 5)
    ]}
    rows, _ = article_rows(payload, ENERGY)
    assert len(rows) == KEEP_PER_SECTOR
    assert any("Crude oil gas pipeline surge" == row[4] for row in rows)


def test_unusable_articles_and_duplicates_are_dropped():
    payload = {"articles": [
        article("", "Oil rises again today"),
        article("https://a.example/1", ""),
        article("https://a.example/2", "Oil rises again today", seendate="not-a-date"),
        article("https://a.example/3", "Oil rises again today"),
        article("https://a.example/3", "Oil rises again tomorrow"),
    ]}
    rows, considered = article_rows(payload, ENERGY)
    assert considered == 5
    assert [row[7] for row in rows] == ["https://a.example/3"]


def test_ids_are_stable_so_a_rerun_updates_rather_than_duplicates():
    assert article_id("https://a.example/1") == article_id("https://a.example/1")
    assert article_id("https://a.example/1") != article_id("https://a.example/2")
    assert article_id("https://a.example/1").startswith("gdelt:")


def test_gdelt_spacing_and_dates_are_normalized():
    assert clean_title("The 1970s Oil Crisis : Never Forget ? ") == "The 1970s Oil Crisis: Never Forget?"
    assert parse_seen_date("20260822T141500Z") == datetime(2026, 8, 22, 14, 15, tzinfo=timezone.utc)
    assert parse_seen_date("") is None


def test_one_publisher_cannot_fill_a_sector():
    # Algorithmic stock-content farms publish the same story against dozens of
    # tickers, and GDELT indexes them next to newsrooms. Without a cap, one of
    # them takes the whole list.
    payload = {"articles": [
        # Distinct headlines: the farm publishes one story per ticker, so this
        # is the publisher cap under test rather than the wire-copy dedupe.
        article(f"https://farm.example/{index}", f"Oil stock moves today, story {index}", domain="tickerreport.com")
        for index in range(10)
    ] + [
        article("https://paper.example/1", "Oil output falls", domain="reuters.com"),
        article("https://wire.example/1", "Crude oil prices climb", domain="apnews.com"),
    ]}
    rows, _ = article_rows(payload, ENERGY)
    domains = [row[3] for row in rows]
    assert domains.count("tickerreport.com") == MAX_PER_DOMAIN
    assert {"reuters.com", "apnews.com"} <= set(domains)


def test_tokenized_punctuation_is_put_back_where_it_belongs():
    # GDELT hands back every punctuation mark as its own token, and each of these
    # reached the page verbatim before the normalizer covered its case.
    assert clean_title("Software - as - a - Service ( SaaS ) growth") == "Software-as-a-Service (SaaS) growth"
    assert clean_title("Revenue hit 2. 1 million") == "Revenue hit 2.1 million"
    assert clean_title("Weve Lost 75, 000 Manufacturing Job") == "Weve Lost 75,000 Manufacturing Job"
    assert clean_title("U. S. output up 4. 2 % [ chart ]") == "U.S. output up 4.2% [chart]"
    assert clean_title("Ph. D. student wins award") == "Ph.D. student wins award"


def test_the_same_wire_story_from_many_outlets_counts_once():
    # One agency story is republished verbatim, so thirteen copies of a single
    # piece filled a sector's timeline. Case and the publisher tag are all that
    # separated them.
    payload = {"articles": [
        article("https://a.com/1", "Oil prices surge as pipeline halts - Reuters", domain="a.com"),
        article("https://b.com/2", "OIL PRICES SURGE AS PIPELINE HALTS | AP News", domain="b.com"),
        article("https://c.com/3", "Oil Prices Surge as Pipeline Halts", domain="c.com"),
        article("https://d.com/4", "Refinery fire cuts Texas crude runs", domain="d.com"),
    ]}
    rows, considered = article_rows(payload, ENERGY)
    assert considered == 4
    titles = {row[4] for row in rows}
    assert len(rows) == 2, titles
    assert "Refinery fire cuts Texas crude runs" in titles


def test_generated_market_noise_never_reaches_the_page():
    # These mention the sector, carry a date and a publisher, and report nothing
    # that happened. They are written from a price feed.
    for headline in (
        "Exxon Mobil Corp shares cross above 200 day moving average",
        "Vanguard Group Inc. Sells 1,200 Shares of Chevron Corp",
        "Bank of America Boosts Stake in First Solar",
        "5 Best Energy Stocks To Buy Now",
        "Analysts Set Price Target for Devon Energy",
        "Oil prices",
    ):
        assert is_boilerplate(headline), headline


def test_the_noise_filter_does_not_eat_real_reporting():
    # A sale of a stake and a purchase of a company are the news, not filler,
    # and an earlier rule that keyed on "sells stake" dropped both.
    for headline in (
        "Exxon sells stake in Nigerian oil unit to Seplat",
        "Chevron buys Hess after two-year arbitration fight",
        "Ukraine strikes Russian refinery, pushing Brent above $80",
        "Fed holds rates steady as bank lending tightens",
    ):
        assert not is_boilerplate(headline), headline


def test_boilerplate_is_filtered_out_of_the_rows_themselves():
    payload = {"articles": [
        article("https://a.com/1", "Chevron Corp shares cross above 200 day moving average"),
        article("https://b.com/2", "Refinery fire cuts Texas crude runs", domain="b.com"),
    ]}
    rows, _ = article_rows(payload, ENERGY)
    assert [row[4] for row in rows] == ["Refinery fire cuts Texas crude runs"]


def test_a_publisher_tag_does_not_make_two_different_stories_one():
    assert normalized_title("Shell profits fall - Reuters") != normalized_title("BP profits fall - Reuters")
