-- Which Form D issuers are already SEC reporting companies.
--
-- Form D is a private placement exemption, and the panel described its filers
-- as private companies. Many are not: Roblox, HEICO, MasTec, Dillard's, Joby
-- and Compass all appear, because a listed company placing securities
-- privately files the same form. Naming them alongside genuinely private
-- issuers, under a heading about private companies, is simply wrong.
--
-- The SEC publishes the ticker-to-CIK registry, so this is a lookup rather than
-- a judgement: a CIK in that file has a listed security.
CREATE TABLE reporting_companies (
    cik text PRIMARY KEY,
    ticker text NOT NULL,
    name text
);

ALTER TABLE form_d ADD COLUMN issuer_ticker text;
