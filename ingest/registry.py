"""Load, validate, and search the hand-maintained sector registry."""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
import re
from typing import Any

import yaml


REGISTRY_PATH = Path(__file__).parent / "config" / "sectors.yaml"
EXPECTED_SECTOR_COUNT = 20
REQUIRED_FIELDS = {
    "slug",
    "name",
    "aliases",
    "primary_etf",
    "comparison_etfs",
    "news_keywords",
    "sic_prefixes",
    "naics_code",
}


@dataclass(frozen=True)
class Sector:
    slug: str
    name: str
    aliases: tuple[str, ...]
    primary_etf: str
    comparison_etfs: tuple[str, ...]
    news_keywords: tuple[str, ...]
    sic_prefixes: tuple[str, ...]
    naics_code: str


@dataclass(frozen=True)
class SearchResult:
    matches: tuple[Sector, ...]
    suggestions: tuple[Sector, ...]


def _normalize(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value.lower()).split())


def _validate_entry(raw: dict[str, Any], index: int) -> None:
    missing = REQUIRED_FIELDS - raw.keys()
    extra = raw.keys() - REQUIRED_FIELDS
    if missing or extra:
        raise ValueError(
            f"sector entry {index} has missing fields {sorted(missing)} "
            f"and unknown fields {sorted(extra)}"
        )

    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", str(raw["slug"])):
        raise ValueError(f"invalid sector slug: {raw['slug']!r}")

    if not re.fullmatch(r"[A-Z][A-Z0-9.-]*", str(raw["primary_etf"])):
        raise ValueError(f"invalid primary ETF for {raw['slug']}")

    list_fields = ("aliases", "comparison_etfs", "news_keywords", "sic_prefixes")
    for field in list_fields:
        if not isinstance(raw[field], list):
            raise ValueError(f"{raw['slug']}.{field} must be a list")

    nonempty_fields = ("aliases", "news_keywords", "sic_prefixes")
    for field in nonempty_fields:
        if not raw[field] or any(not str(item).strip() for item in raw[field]):
            raise ValueError(f"{raw['slug']}.{field} cannot be empty")

    if not str(raw["naics_code"]).strip():
        raise ValueError(f"{raw['slug']}.naics_code cannot be empty")


def load_sectors(path: Path = REGISTRY_PATH) -> tuple[Sector, ...]:
    """Load the registry and fail loudly if its hand-maintained data is invalid."""
    with path.open(encoding="utf-8") as registry_file:
        document = yaml.safe_load(registry_file)

    if not isinstance(document, dict) or not isinstance(document.get("sectors"), list):
        raise ValueError("registry root must contain a sectors list")

    raw_sectors = document["sectors"]
    if len(raw_sectors) != EXPECTED_SECTOR_COUNT:
        raise ValueError(
            f"registry must contain {EXPECTED_SECTOR_COUNT} sectors; "
            f"found {len(raw_sectors)}"
        )

    sectors: list[Sector] = []
    for index, raw in enumerate(raw_sectors):
        if not isinstance(raw, dict):
            raise ValueError(f"sector entry {index} must be an object")
        _validate_entry(raw, index)
        sectors.append(
            Sector(
                slug=str(raw["slug"]),
                name=str(raw["name"]),
                aliases=tuple(str(item) for item in raw["aliases"]),
                primary_etf=str(raw["primary_etf"]),
                comparison_etfs=tuple(str(item) for item in raw["comparison_etfs"]),
                news_keywords=tuple(str(item) for item in raw["news_keywords"]),
                sic_prefixes=tuple(str(item) for item in raw["sic_prefixes"]),
                naics_code=str(raw["naics_code"]),
            )
        )

    slugs = [sector.slug for sector in sectors]
    if len(slugs) != len(set(slugs)):
        raise ValueError("sector slugs must be unique")

    primary_etfs = [sector.primary_etf for sector in sectors]
    if len(primary_etfs) != len(set(primary_etfs)):
        raise ValueError("primary ETFs must be unique")

    return tuple(sectors)


def _sector_score(query: str, sector: Sector) -> float:
    candidates = (sector.name, *sector.aliases)
    normalized_candidates = tuple(_normalize(candidate) for candidate in candidates)

    if query in normalized_candidates:
        return 1.0
    if any(query in candidate or candidate in query for candidate in normalized_candidates):
        return 0.9
    return max(SequenceMatcher(None, query, candidate).ratio() for candidate in normalized_candidates)


def search_sectors(
    query: str,
    sectors: tuple[Sector, ...] | None = None,
    *,
    match_threshold: float = 0.62,
    suggestion_count: int = 3,
) -> SearchResult:
    """Return registry-only matches, or the closest sectors when nothing matches.

    ETF symbols are intentionally excluded from candidates. Search never attempts
    to infer arbitrary industries or resolve free text to a ticker.
    """
    available = sectors if sectors is not None else load_sectors()
    normalized_query = _normalize(query)
    if not normalized_query:
        return SearchResult(matches=(), suggestions=())

    ranked = sorted(
        ((_sector_score(normalized_query, sector), sector) for sector in available),
        key=lambda item: (-item[0], item[1].name),
    )
    matches = tuple(sector for score, sector in ranked if score >= match_threshold)
    if matches:
        return SearchResult(matches=matches, suggestions=())

    suggestions = tuple(sector for _, sector in ranked[:suggestion_count])
    return SearchResult(matches=(), suggestions=suggestions)

