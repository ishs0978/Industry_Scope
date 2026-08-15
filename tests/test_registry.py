from ingest.registry import load_sectors, search_sectors


EXPECTED_PRIMARY_ETFS = {
    "energy": ("XLE", ("OIH", "XOP", "AMLP")),
    "semiconductors": ("SMH", ("SOXX", "XSD")),
    "technology": ("XLK", ()),
    "ai-robotics": ("BOTZ", ("ROBO", "IRBO", "ARKQ")),
    "software-cloud": ("IGV", ("WCLD", "SKYY")),
    "cybersecurity": ("CIBR", ("HACK", "BUG")),
    "banks": ("XLF", ("KRE", "KBE")),
    "healthcare-pharma": ("XLV", ("IBB", "XBI")),
    "defense-aerospace": ("ITA", ("XAR", "PPA")),
    "homebuilders": ("XHB", ("ITB",)),
    "industrials": ("XLI", ("PAVE",)),
    "consumer-discretionary": ("XLY", ("XRT",)),
    "consumer-staples": ("XLP", ()),
    "utilities": ("XLU", ()),
    "real-estate": ("XLRE", ("VNQ",)),
    "materials-mining": ("XLB", ("XME",)),
    "gold-metals": ("GDX", ("GLD", "SIL")),
    "clean-energy": ("ICLN", ("TAN", "FAN")),
    "uranium-nuclear": ("URA", ("NLR",)),
    "communication-services": ("XLC", ()),
    "transport-shipping": ("IYT", ()),
}


def test_registry_contains_the_required_21_sectors_and_etfs():
    sectors = load_sectors()
    actual = {
        sector.slug: (sector.primary_etf, sector.comparison_etfs)
        for sector in sectors
    }
    assert actual == EXPECTED_PRIMARY_ETFS


def test_every_sector_has_search_and_source_mappings():
    for sector in load_sectors():
        assert sector.aliases
        assert sector.news_keywords
        assert sector.sic_prefixes
        assert sector.naics_code


def test_search_matches_names_and_aliases_fuzzily():
    exact = search_sectors("Energy")
    assert exact.matches[0].slug == "energy"

    alias = search_sectors("SaaS")
    assert alias.matches[0].slug == "software-cloud"

    typo = search_sectors("semiconducter")
    assert typo.matches[0].slug == "semiconductors"


def test_unknown_search_returns_exactly_three_registry_suggestions():
    result = search_sectors("banana cultivation")
    assert result.matches == ()
    assert len(result.suggestions) == 3
    assert len({sector.slug for sector in result.suggestions}) == 3


def test_ticker_symbols_are_not_search_candidates():
    result = search_sectors("XLE")
    assert result.matches == ()
    assert len(result.suggestions) == 3


def test_blank_search_is_an_empty_state_without_suggestions():
    assert search_sectors("   ").matches == ()
    assert search_sectors("   ").suggestions == ()



def test_no_two_sectors_claim_the_same_sic_prefix():
    # Form D routes on these. An identical prefix in two sectors has no longest
    # match, so the winner comes from an alphabetical tiebreak nobody chose.
    claimed = {}
    for sector in load_sectors():
        for prefix in sector.sic_prefixes:
            assert prefix not in claimed, f"{prefix} claimed by {claimed.get(prefix)} and {sector.slug}"
            claimed[prefix] = sector.slug


def test_sic_resolution_prefers_the_more_specific_sector():
    from ingest.sources.form_d import sector_for_sic

    # 7372 used to be claimed outright by two sectors at once.
    assert sector_for_sic("7372") == "software-cloud"
    assert sector_for_sic("7373") == "cybersecurity"
    # 4911 is electric services generally and belongs to utilities, not to the
    # narrower clean-energy sector that used to claim it.
    assert sector_for_sic("4911") == "utilities"
    assert sector_for_sic("4931") == "clean-energy"
    # 1094 is uranium ore.
    assert sector_for_sic("1094") == "uranium-nuclear"
    assert sector_for_sic("1041") == "gold-metals"
    assert sector_for_sic("3674") == "semiconductors"
    assert sector_for_sic("3576") == "technology"
