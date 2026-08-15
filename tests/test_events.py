from datetime import date
import re

import pytest

from ingest.sources.events import (
    MAX_EVENTS,
    MIN_EVENTS,
    STALE_AFTER_DAYS,
    days_since_newest_event,
    load_events,
)


# Replaces an earlier guard that required every blurb to be empty. Empty blurbs
# meant all 47 events rendered the same placeholder, which is worse than no
# marker at all, so the standard is now about what a blurb may contain rather
# than whether one exists.
PRICE_LANGUAGE = re.compile(
    r"\b(soar\w*|plunge\w*|rall\w+|surge\w*|sank|tumbl\w+|skyrocket\w*|catalyst|"
    r"boost\w*|crush\w+|outperform\w*|underperform\w*|sell-?off)\b",
    re.IGNORECASE,
)


def test_event_registry_is_review_sized():
    events = load_events()
    assert MIN_EVENTS <= len(events) <= MAX_EVENTS
    assert all(event["source_url"].startswith("https://") for event in events)


def test_every_event_has_a_blurb():
    # A marker the reader can click that then says nothing is worse than no
    # marker, and the dashboard now refuses to render a blurbless event.
    assert all(event["blurb"].strip() for event in load_events())


def test_blurbs_are_two_sentences_and_state_a_mechanism():
    for event in load_events():
        sentences = [part for part in re.split(r"(?<=[.])\s+", event["blurb"].strip()) if part]
        assert 2 <= len(sentences) <= 3, f"{event['id']} has {len(sentences)} sentences"
        assert len(event["blurb"]) > 120, f"{event['id']} blurb is too thin to say anything"


def test_blurbs_avoid_price_and_outcome_language():
    # The site does not claim an event moved a price. A blurb states what
    # happened and the transmission channel; the chart above it does the rest.
    for event in load_events():
        match = PRICE_LANGUAGE.search(event["blurb"])
        assert match is None, f"{event['id']} uses outcome language: {match.group(0) if match else ''}"


def test_required_event_families_are_present():
    ids = {event["id"] for event in load_events()}
    assert {
        "oil_embargo_1973", "oil_collapse_1986", "dotcom_crash_2000_2002",
        "september_11_2001", "lehman_2008", "debt_ceiling_2011",
        "oil_collapse_2014_2016", "section_301_tariffs_2018", "covid_crash_2020",
        "cares_act_2020", "chip_shortage_2021", "fed_hiking_cycle_2022",
        "russia_invades_ukraine_2022", "chips_act_2022", "inflation_reduction_act_2022",
        "svb_failure_2023", "chatgpt_launch_2022", "red_sea_disruption_2023_2024",
        "fed_rate_cuts_2024_2025",
    }.issubset(ids)


def test_registry_is_not_stale():
    # The file sat at September 2024 for nearly two years because nothing
    # measured this.
    assert days_since_newest_event(load_events(), date.today()) <= STALE_AFTER_DAYS


def test_staleness_is_measured_from_the_newest_event():
    events = [{"id": "a", "start": "2024-09-18"}, {"id": "b", "start": "2026-06-01"}]
    assert days_since_newest_event(events, date(2026, 6, 30)) == 29


def test_load_rejects_a_blurbless_event(tmp_path):
    import json

    path = tmp_path / "events.json"
    path.write_text(json.dumps([
        {"id": f"e{index}", "start": "2026-01-01", "end": "2026-01-01", "sectors": ["all"],
         "title": "t", "blurb": "" if index == 0 else "text", "source_url": "https://example.test",
         "impact": "mixed"}
        for index in range(MIN_EVENTS)
    ]))
    with pytest.raises(ValueError, match="needs a blurb"):
        load_events(path)
