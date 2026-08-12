"""Small, dependency-light PostgreSQL migration runner for Neon."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ingest.registry import load_sectors


MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def migration_files(directory: Path = MIGRATIONS_DIR) -> tuple[Path, ...]:
    files = tuple(sorted(directory.glob("[0-9][0-9][0-9][0-9]_*.sql")))
    versions = [path.name.split("_", 1)[0] for path in files]
    if len(versions) != len(set(versions)):
        raise ValueError("migration version prefixes must be unique")
    return files


def apply_migrations(connection: Any, directory: Path = MIGRATIONS_DIR) -> list[str]:
    """Apply each pending migration in its own transaction."""
    applied: list[str] = []
    with connection.cursor() as cursor:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version text PRIMARY KEY,
                filename text NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    connection.commit()

    for path in migration_files(directory):
        version = path.name.split("_", 1)[0]
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT 1 FROM schema_migrations WHERE version = %s",
                (version,),
            )
            if cursor.fetchone():
                continue
            cursor.execute(path.read_text(encoding="utf-8"))
            cursor.execute(
                "INSERT INTO schema_migrations (version, filename) VALUES (%s, %s)",
                (version, path.name),
            )
        connection.commit()
        applied.append(path.name)

    return applied


def sync_sector_registry(connection: Any) -> int:
    """Upsert the canonical YAML registry after the schema is current."""
    sectors = load_sectors()
    rows = [
        (
            sector.slug,
            sector.name,
            list(sector.aliases),
            sector.primary_etf,
            list(sector.comparison_etfs),
            list(sector.news_keywords),
            list(sector.sic_prefixes),
            sector.naics_code,
        )
        for sector in sectors
    ]
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            INSERT INTO sectors (
                slug,
                name,
                aliases,
                primary_etf,
                comparison_etfs,
                news_keywords,
                sic_prefixes,
                naics_code
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (slug) DO UPDATE SET
                name = EXCLUDED.name,
                aliases = EXCLUDED.aliases,
                primary_etf = EXCLUDED.primary_etf,
                comparison_etfs = EXCLUDED.comparison_etfs,
                news_keywords = EXCLUDED.news_keywords,
                sic_prefixes = EXCLUDED.sic_prefixes,
                naics_code = EXCLUDED.naics_code
            """,
            rows,
        )
    connection.commit()
    return len(rows)


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required")

    try:
        import psycopg
    except ImportError as exc:
        raise SystemExit("psycopg is not installed; run: pip install -r requirements.txt") from exc

    with psycopg.connect(database_url) as connection:
        applied = apply_migrations(connection)
        sector_count = sync_sector_registry(connection)

    if applied:
        print(f"Applied {len(applied)} migration(s): {', '.join(applied)}")
    else:
        print("Database schema is already current")
    print(f"Synchronized {sector_count} sectors")


if __name__ == "__main__":
    main()
