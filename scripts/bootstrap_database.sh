#!/usr/bin/env bash
# Rebuild the whole database from public sources into an empty Postgres.
#
# Nothing in this database is original: every row is derived from SEC, Yahoo,
# FRED, EIA, BLS, GDELT or NYT. That is what makes moving providers cheap, and
# it also makes this script the disaster recovery plan. Running it against an
# empty database is the only way to know that plan still works.
#
# Usage:  DATABASE_URL=... scripts/bootstrap_database.sh
#
# Stages run in dependency order and each is idempotent, so re-running after a
# failure picks up rather than starting over.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required." >&2
  exit 1
fi
PY=.venv/bin/python

run_py() { $PY -c "$1"; }

stage() {
  printf '\n=== %s ===\n' "$1"
  shift
  "$@" || echo "  ^ stage failed; continuing so later stages still run" >&2
}

stage "Schema and sector registry" $PY -m ingest.db

# Holdings must land before company prices: that source takes its ticker list
# from whatever the funds hold.
stage "Fund prices and metadata" run_py "import os,psycopg
from ingest.sources import prices
c=psycopg.connect(os.environ['DATABASE_URL']); prices.run(c); c.close()"

stage "Fund holdings" run_py "import os,psycopg
from ingest.sources import holdings
c=psycopg.connect(os.environ['DATABASE_URL']); holdings.run(c); c.close()"

COMPANY_PRICES_MAX_SECONDS=3600 COMPANY_META_PER_RUN=900 \
stage "Company weekly prices and analyst view" run_py "import os,psycopg
from ingest.sources import company_prices
c=psycopg.connect(os.environ['DATABASE_URL']); company_prices.run(c); c.close()"

stage "Macro series" run_py "import os,psycopg
from ingest.sources import fred,eia,bls
c=psycopg.connect(os.environ['DATABASE_URL'])
for m in (fred,eia,bls):
    try: m.run(c)
    except Exception as e: print('  ',type(e).__name__,str(e)[:90])
c.close()"

stage "Company fundamentals" run_py "import os,psycopg
from ingest.sources import sec_xbrl
c=psycopg.connect(os.environ['DATABASE_URL']); sec_xbrl.run(c); c.close()"

stage "Curated events" run_py "import os,psycopg
from ingest.sources import events
c=psycopg.connect(os.environ['DATABASE_URL']); events.run(c); c.close()"

# The full Form D history is ~30 quarterly files and the slowest stage by far.
FORM_D_DERA_MAX_QUARTERS=40 FORM_D_DERA_MAX_SECONDS=5400 \
stage "Form D history" run_py "import os,psycopg
from ingest.sources import form_d_dera
c=psycopg.connect(os.environ['DATABASE_URL']); form_d_dera.run(c); c.close()"

FORM_D_MAX_FILINGS=12000 FORM_D_MAX_SECONDS=3600 \
stage "Form D current quarter" run_py "import os,psycopg
from ingest.sources import form_d
c=psycopg.connect(os.environ['DATABASE_URL']); form_d.run(c); c.close()"

# GDELT enforces a window quota, so coverage fills over several runs rather than
# one. News is the least critical stage and deliberately runs last.
stage "News volume and coverage" run_py "import os,psycopg
from ingest.sources import gdelt,gdelt_news,nyt
c=psycopg.connect(os.environ['DATABASE_URL'])
for m in (gdelt,gdelt_news,nyt):
    try: m.run(c)
    except Exception as e: print('  ',type(e).__name__,str(e)[:90])
c.close()"

printf '\n=== Result ===\n'
run_py "import os,psycopg
with psycopg.connect(os.environ['DATABASE_URL']) as c, c.cursor() as cur:
    for t in ('prices','holdings','company_prices','company_meta','company_facts',
              'macro_series','form_d','headlines','events'):
        cur.execute(f'SELECT count(*) FROM {t}')
        print(f'  {t:16} {cur.fetchone()[0]:>9,}')
    cur.execute('SELECT pg_size_pretty(pg_database_size(current_database()))')
    print('  database size    ', cur.fetchone()[0])"
