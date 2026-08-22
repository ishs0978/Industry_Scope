-- Weekly closes for the individual companies held by the sector funds.
--
-- The prices table holds daily bars for the fifty funds the site tracks. It
-- held nothing at all for the ~800 companies inside them, so a company had no
-- chart and no return history. Daily bars for all of them would be about 330 MB
-- against a database ceiling of 512 MB, and the questions a company page
-- answers are yearly and multi-year, so weekly closes carry the same answers at
-- a sixth of the size. Fund charts stay daily.
CREATE TABLE company_prices (
    ticker text NOT NULL,
    week_ending date NOT NULL,
    adj_close numeric NOT NULL,
    close numeric,
    PRIMARY KEY (ticker, week_ending)
);
CREATE INDEX company_prices_ticker_week_idx ON company_prices (ticker, week_ending);

-- What the market and the analysts covering a company currently think, beside
-- the figures the company itself reported. These are opinions with a date on
-- them, not reported facts, and the page labels them that way.
ALTER TABLE company_meta ADD COLUMN name text;
ALTER TABLE company_meta ADD COLUMN trailing_pe numeric;
ALTER TABLE company_meta ADD COLUMN forward_pe numeric;
ALTER TABLE company_meta ADD COLUMN price_to_book numeric;
ALTER TABLE company_meta ADD COLUMN dividend_yield numeric;
ALTER TABLE company_meta ADD COLUMN target_mean_price numeric;
ALTER TABLE company_meta ADD COLUMN analyst_count integer;
ALTER TABLE company_meta ADD COLUMN recommendation text;
