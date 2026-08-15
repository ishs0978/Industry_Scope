ALTER TABLE form_d ADD COLUMN industry_group text;
CREATE INDEX form_d_industry_group_idx ON form_d (industry_group);
