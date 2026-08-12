CREATE INDEX prices_date_idx ON prices (date);
CREATE INDEX holdings_fund_as_of_idx ON holdings (fund_ticker, as_of DESC);
CREATE INDEX macro_series_date_idx ON macro_series (date);
CREATE INDEX company_facts_ticker_period_idx ON company_facts (ticker, fiscal_period);
CREATE INDEX form_d_sector_filed_idx ON form_d (sector_slug, filed_date);
CREATE INDEX headlines_sector_published_idx ON headlines (sector_slug, published_date DESC);
CREATE INDEX news_volume_date_idx ON news_volume (date);
CREATE INDEX events_dates_idx ON events (start_date, end_date);
CREATE INDEX ingest_runs_source_started_idx ON ingest_runs (source, started_at DESC);

