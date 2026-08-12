CREATE TABLE company_meta (
    ticker text PRIMARY KEY,
    market_cap numeric,
    as_of timestamptz NOT NULL
);

ALTER TABLE headlines ADD COLUMN relevance_score integer NOT NULL DEFAULT 0;

CREATE TABLE nyt_archive_months (
    year integer NOT NULL,
    month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
    fetched_at timestamptz NOT NULL,
    historical_complete boolean NOT NULL DEFAULT false,
    document_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (year, month)
);

