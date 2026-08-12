from ingest.sources.events import load_events


def test_event_registry_is_review_sized_and_has_no_model_authored_blurbs():
    events = load_events()
    assert 40 <= len(events) <= 50
    assert all(event["blurb"] == "" for event in events)
    assert all(event["source_url"].startswith("https://") for event in events)


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

