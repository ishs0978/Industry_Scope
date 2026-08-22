-- What kind of security the offering sells, carried from the filer's own
-- checkboxes so the panel can report how much of a sector's private money is
-- debt rather than equity.
--
-- Blank is not a missing answer. These are checkboxes: the data sets leave the
-- column empty when the filer did not tick it, and the XML omits the element
-- entirely, both of which mean "no". The rebuild normalizes that to false so a
-- reader can filter on `is_debt_type = false` and get the same answer whichever
-- source the row came from. An offering can carry more than one type; the boxes
-- are not exclusive.
ALTER TABLE form_d ADD COLUMN is_equity_type boolean;
ALTER TABLE form_d ADD COLUMN is_debt_type boolean;
ALTER TABLE form_d ADD COLUMN is_option_to_acquire_type boolean;
