ALTER TABLE form_d ADD COLUMN submission_type text;
ALTER TABLE form_d ADD COLUMN previous_accession_no text;

-- Every row written before this migration came through a full-index filter that
-- accepted form type "D" only, so no stored row can be an amendment.
UPDATE form_d SET submission_type = 'D' WHERE submission_type IS NULL;
