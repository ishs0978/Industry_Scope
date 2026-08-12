ALTER TABLE ingest_runs DROP CONSTRAINT ingest_runs_status_check;
ALTER TABLE ingest_runs ADD CONSTRAINT ingest_runs_status_check
CHECK (status IN ('pending', 'running', 'success', 'failed'));

ALTER TABLE ingest_runs ADD COLUMN batch_id text;
CREATE INDEX ingest_runs_batch_source_idx ON ingest_runs (batch_id, source);

UPDATE ingest_runs
SET status = 'failed',
    finished_at = now(),
    error_message = COALESCE(error_message, 'Interrupted before a terminal status was recorded')
WHERE status = 'running' AND started_at < now() - interval '1 hour';
