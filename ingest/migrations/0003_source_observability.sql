ALTER TABLE ingest_runs ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE etf_meta ADD COLUMN holdings_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE etf_meta ADD COLUMN holdings_error text;

ALTER TABLE etf_meta ADD CONSTRAINT etf_meta_holdings_status_check
CHECK (holdings_status IN ('unknown', 'available', 'stale', 'unsupported'));

