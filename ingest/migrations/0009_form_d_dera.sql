-- Staging tables for the SEC Form D quarterly data sets, so the derived form_d
-- table can be rebuilt without re-downloading anything.
--
-- The grain of each table is the grain the SEC publishes: one row per accession
-- in FORMDSUBMISSION and OFFERING, and one row per accession plus issuer
-- sequence key in ISSUERS. Co-issuers are therefore separate rows here, and any
-- dollar aggregate that joins issuers to offerings would multiply the offering
-- amount by the issuer count.
--
-- Only the columns the derived table and the published stats consume are kept.
-- The full data sets carry 41 offering columns and 23 issuer columns; holding
-- all of them for the whole history costs more storage than this database has,
-- and anything dropped here is one re-download away.
CREATE TABLE form_d_submission_raw (
    accession_no text PRIMARY KEY,
    -- The 021-XXXXXX offering file number, constant across an original and its
    -- amendments. EDGAR assigns it; primary_doc.xml never carries it.
    file_num text,
    filing_date date NOT NULL,
    sic_code text,
    submission_type text,
    -- 'dera' for a published quarterly data set, 'edgar' for the quarter in
    -- progress assembled from the full index. A published data set replaces the
    -- EDGAR rows for its quarter rather than merging with them.
    source text NOT NULL,
    dera_quarter text
);
CREATE INDEX form_d_submission_raw_filing_date_idx ON form_d_submission_raw (filing_date);
-- Only the interim rows are ever selected by source, and they are a small
-- fraction of the table, so a partial index costs almost nothing.
CREATE INDEX form_d_submission_raw_edgar_idx
    ON form_d_submission_raw (filing_date) WHERE source = 'edgar';

CREATE TABLE form_d_issuer_raw (
    accession_no text NOT NULL,
    issuer_seq_key integer NOT NULL,
    is_primary_issuer boolean,
    cik text,
    entity_name text,
    state_or_country text,
    PRIMARY KEY (accession_no, issuer_seq_key)
);

CREATE TABLE form_d_offering_raw (
    accession_no text PRIMARY KEY,
    industry_group_type text,
    investment_fund_type text,
    is_amendment boolean,
    previous_accession_no text,
    sale_date date,
    is_equity_type boolean,
    is_debt_type boolean,
    is_option_to_acquire_type boolean,
    is_pooled_investment_fund_type boolean,
    total_offering_amount numeric,
    total_amount_sold numeric
);

-- One row per published quarterly data set that has been loaded. A re-run keys
-- on this to skip work already done, and the URL is recorded because the SEC's
-- own filenames and directories are not uniform.
CREATE TABLE form_d_dera_quarter (
    quarter text PRIMARY KEY,
    source_url text NOT NULL,
    submissions integer NOT NULL,
    issuers integer NOT NULL,
    offerings integer NOT NULL,
    test_filings_dropped integer NOT NULL DEFAULT 0,
    loaded_at timestamptz NOT NULL DEFAULT now()
);

-- Derived-table columns the staging tables make available. issuer_count is how
-- many issuers the accession names, so the UI can show co-issuers as one row.
ALTER TABLE form_d ADD COLUMN file_num text;
ALTER TABLE form_d ADD COLUMN is_amendment boolean;
ALTER TABLE form_d ADD COLUMN issuer_count integer;
ALTER TABLE form_d ADD COLUMN source text;
