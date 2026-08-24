from pathlib import Path
from ingest.registry import load_sectors, search_sectors


EXPECTED_PRIMARY_ETFS = {
    "energy": ("XLE", ("OIH", "XOP", "AMLP")),
    "semiconductors": ("SMH", ("SOXX", "XSD")),
    "technology": ("XLK", ("VGT", "FTEC")),
    "ai-robotics": ("BOTZ", ("ROBO", "IRBO", "ARKQ")),
    "software-cloud": ("IGV", ("WCLD", "SKYY")),
    "cybersecurity": ("CIBR", ("HACK", "BUG")),
    "banks": ("XLF", ("KRE", "KBE")),
    "healthcare-pharma": ("XLV", ("IBB", "XBI")),
    "defense-aerospace": ("ITA", ("XAR", "PPA")),
    "homebuilders": ("XHB", ("ITB",)),
    "industrials": ("XLI", ("PAVE",)),
    "consumer-discretionary": ("XLY", ("XRT",)),
    "consumer-staples": ("XLP", ("VDC", "FSTA")),
    "utilities": ("XLU", ("VPU", "IDU")),
    "real-estate": ("XLRE", ("VNQ",)),
    "materials-mining": ("XLB", ("XME",)),
    "gold-metals": ("GDX", ("GLD", "SIL")),
    "clean-energy": ("ICLN", ("TAN", "FAN")),
    "uranium-nuclear": ("URA", ("NLR",)),
    "communication-services": ("XLC", ("VOX", "FCOM")),
    "transport-shipping": ("IYT", ("XTN", "FTXR")),
    "bonds": ("AGG", ("BND", "TLT", "LQD")),
    "municipal-bonds": ("MUB", ("VTEB", "TFI")),
}


def test_registry_contains_every_sector_and_its_etfs():
    sectors = load_sectors()
    actual = {
        sector.slug: (sector.primary_etf, sector.comparison_etfs)
        for sector in sectors
    }
    assert actual == EXPECTED_PRIMARY_ETFS


# Bond funds own debt, not issuers, so they carry no SIC prefix: any prefix
# would pull unrelated Form D filings and company fundamentals into their totals.
SECTORS_WITHOUT_OPERATING_COMPANIES = {"bonds", "municipal-bonds"}


def test_every_sector_has_search_and_source_mappings():
    for sector in load_sectors():
        assert sector.aliases
        assert sector.news_keywords
        assert sector.naics_code
        if sector.slug in SECTORS_WITHOUT_OPERATING_COMPANIES:
            assert sector.sic_prefixes == ()
        else:
            assert sector.sic_prefixes


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


def test_the_two_copies_of_each_shared_config_agree():
    """The site and the ingest read separate files that must say the same thing.

    They are duplicated because the web build cannot import from the Python
    package. Nothing enforced that they matched, so a correction applied to one
    copy silently did not apply to the other: seven FRED series were replaced in
    the ingest map while the site kept requesting the deleted ids, and every
    affected macro panel rendered empty in production.
    """
    import yaml

    root = Path(__file__).resolve().parents[1]
    for name, key in (("fred_map.yaml", None), ("sectors.yaml", "sectors"),
                      ("company_groups.yaml", None)):
        ingest = yaml.safe_load((root / "ingest" / "config" / name).read_text(encoding="utf-8"))
        web = yaml.safe_load((root / "web" / "config" / name).read_text(encoding="utf-8"))
        # sectors.yaml also carries holdings_feeds, which only the ingest reads.
        if key:
            ingest, web = ingest[key], web[key]
        assert ingest == web, f"{name} differs between ingest/config and web/config"


def test_no_ticker_was_parsed_as_a_boolean():
    """YAML 1.1 reads a bare ON as true, and onsemi's ticker is ON.

    It left a `true` in the semiconductor group where a company should be, and
    the company itself was absent from a group built to contain it.
    """
    import yaml

    root = Path(__file__).resolve().parents[1]
    for name in ("company_groups.yaml", "sectors.yaml"):
        for directory in ("ingest", "web"):
            document = yaml.safe_load((root / directory / "config" / name).read_text(encoding="utf-8"))
            for found in _walk_tickers(document):
                assert isinstance(found, str), f"{directory}/config/{name} has a non-string ticker: {found!r}"


def _walk_tickers(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in {"tickers", "comparison_etfs"} and isinstance(value, list):
                yield from value
            else:
                yield from _walk_tickers(value)
    elif isinstance(node, list):
        for item in node:
            yield from _walk_tickers(item)
