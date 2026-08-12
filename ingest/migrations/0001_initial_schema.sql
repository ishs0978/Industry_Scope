CREATE TABLE sectors (
    slug text PRIMARY KEY,
    name text NOT NULL,
    aliases text[] NOT NULL,
    primary_etf text NOT NULL,
    comparison_etfs text[] NOT NULL,
    news_keywords text[] NOT NULL,
    sic_prefixes text[] NOT NULL,
    naics_code text
);

CREATE TABLE prices (
    ticker text NOT NULL,
    date date NOT NULL,
    adj_close numeric NOT NULL,
    close numeric NOT NULL,
    volume bigint,
    PRIMARY KEY (ticker, date)
);

CREATE TABLE etf_meta (
    ticker text PRIMARY KEY,
    name text,
    expense_ratio numeric,
    aum numeric,
    issuer text,
    as_of timestamptz NOT NULL
);

CREATE TABLE holdings (
    fund_ticker text NOT NULL,
    as_of date NOT NULL,
    constituent_ticker text NOT NULL,
    constituent_name text,
    weight numeric NOT NULL,
    sub_sector text,
    PRIMARY KEY (fund_ticker, as_of, constituent_ticker)
);

CREATE TABLE macro_series (
    series_id text NOT NULL,
    date date NOT NULL,
    value numeric,
    PRIMARY KEY (series_id, date)
);

CREATE TABLE macro_meta (
    series_id text PRIMARY KEY,
    label text NOT NULL,
    units text,
    frequency text,
    source text NOT NULL,
    last_release_date date,
    next_release_date date,
    as_of timestamptz NOT NULL
);

CREATE TABLE company_facts (
    cik text NOT NULL,
    ticker text,
    fiscal_period text NOT NULL,
    metric text NOT NULL,
    value numeric,
    filed_date date NOT NULL,
    PRIMARY KEY (cik, fiscal_period, metric)
);

CREATE TABLE form_d (
    accession_no text PRIMARY KEY,
    filed_date date NOT NULL,
    cik text,
    issuer_name text NOT NULL,
    sic_code text,
    sector_slug text REFERENCES sectors(slug),
    total_offering_amount numeric,
    amount_sold numeric,
    state text
);

CREATE TABLE headlines (
    id text PRIMARY KEY,
    sector_slug text NOT NULL REFERENCES sectors(slug),
    published_date timestamptz NOT NULL,
    source text NOT NULL,
    headline text NOT NULL,
    abstract text,
    section text,
    url text NOT NULL
);

CREATE TABLE news_volume (
    sector_slug text NOT NULL REFERENCES sectors(slug),
    date date NOT NULL,
    article_volume numeric,
    avg_tone numeric,
    PRIMARY KEY (sector_slug, date)
);

CREATE TABLE events (
    id text PRIMARY KEY,
    start_date date NOT NULL,
    end_date date,
    sectors text[] NOT NULL,
    title text NOT NULL,
    blurb text NOT NULL DEFAULT '',
    source_url text,
    impact text NOT NULL CHECK (impact IN ('positive', 'negative', 'mixed', 'neutral'))
);

CREATE TABLE ingest_runs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source text NOT NULL,
    started_at timestamptz NOT NULL,
    finished_at timestamptz,
    status text NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    rows_written bigint NOT NULL DEFAULT 0 CHECK (rows_written >= 0),
    error_message text
);

