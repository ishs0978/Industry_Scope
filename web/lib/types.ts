export type Sector = {
  slug: string;
  name: string;
  aliases: string[];
  primary_etf: string;
  comparison_etfs: string[];
  news_keywords: string[];
  sic_prefixes: string[];
  naics_code: string;
};

export type Price = { ticker: string; date: string; adj_close: number; close: number; volume: number | null };
export type EtfMeta = {
  ticker: string; name: string | null; expense_ratio: number | null; aum: number | null;
  issuer: string | null; as_of: string; holdings_status: string; holdings_error: string | null;
};
export type Holding = {
  fund_ticker: string; as_of: string; constituent_ticker: string;
  constituent_name: string | null; weight: number; sub_sector: string | null;
};
export type MacroPoint = { series_id: string; date: string; value: number | null };
export type MacroMeta = {
  series_id: string; label: string; units: string | null; frequency: string | null;
  source: string; last_release_date: string | null; next_release_date: string | null;
  realtime_start: string | null; as_of: string;
};
export type CompanyFact = {
  cik: string; ticker: string | null; fiscal_period: string; metric: string;
  value: number | null; filed_date: string;
};
export type CompanyMeta = { ticker: string; market_cap: number | null; as_of: string };
export type FormD = {
  accession_no: string; filed_date: string; cik: string | null; issuer_name: string;
  sic_code: string | null; sector_slug: string | null; total_offering_amount: number | null;
  amount_sold: number | null; state: string | null;
  submission_type: string | null; previous_accession_no: string | null;
};
export type Headline = {
  id: string; sector_slug: string; published_date: string; source: string;
  headline: string; abstract: string | null; section: string | null; url: string;
};
export type NewsPoint = { sector_slug: string; date: string; article_volume: number | null; avg_tone: number | null };
export type CuratedEvent = {
  id: string; start_date: string; end_date: string | null; sectors: string[];
  title: string; blurb: string; source_url: string | null; impact: string;
};
export type Freshness = {
  source: string; started_at: string; finished_at: string | null; status: string;
  rows_written: number; error_message: string | null; details: Record<string, unknown>;
};
export type SourceError = { source: string; reason: string };

export type IndustryPayload = {
  sector: Sector;
  prices: Price[];
  etfMeta: EtfMeta[];
  holdings: Holding[];
  macro: { meta: MacroMeta[]; series: MacroPoint[] };
  companyFacts: CompanyFact[];
  companyMeta: CompanyMeta[];
  formD: FormD[];
  headlines: Headline[];
  newsVolume: NewsPoint[];
  events: CuratedEvent[];
  freshness: Freshness[];
  errors: SourceError[];
};

