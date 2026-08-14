"""Fail the ingest job when prices did not actually advance.

`upsert_rows` returning zero is not an error anywhere, so the job can otherwise
complete "successfully" while writing no new rows at all. The site then keeps
serving frozen numbers with every source reporting green.
"""

from __future__ import annotations

from datetime import date
import os
import sys

import psycopg


# Four days covers a long weekend plus a public holiday.
MAX_AGE_DAYS = 4


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is required", file=sys.stderr)
        return 1
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT max(date) FROM prices")
            latest = cursor.fetchone()[0]
    if latest is None:
        print("No rows in prices at all.", file=sys.stderr)
        return 1
    age_days = (date.today() - latest).days
    print(f"Latest stored price date is {latest} ({age_days} day(s) old).")
    if age_days > MAX_AGE_DAYS:
        print(
            f"Stale: no price newer than {MAX_AGE_DAYS} days, so this run wrote "
            "nothing usable even though its sources reported success.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
