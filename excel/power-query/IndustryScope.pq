let
    SlugTable = Excel.CurrentWorkbook(){[Name="IndustrySlug"]}[Content],
    Slug = Text.Trim(Text.From(SlugTable{0}[Column1])),
    ApiBaseTable = Excel.CurrentWorkbook(){[Name="ApiBaseUrl"]}[Content],
    ApiBase = Text.Trim(Text.From(ApiBaseTable{0}[Column1])),
    Source = Json.Document(Web.Contents(ApiBase & "/api/industry/" & Uri.EscapeDataString(Slug))),
    Sector = Source[sector],
    Prices = Table.FromRecords(Source[prices]),
    Holdings = Table.FromRecords(Source[holdings]),
    CompanyFacts = Table.FromRecords(Source[companyFacts]),
    FormD = Table.FromRecords(Source[formD]),
    MacroSeries = Table.FromRecords(Source[macro][series]),
    MacroMeta = Table.FromRecords(Source[macro][meta]),
    Events = Table.FromRecords(Source[events]),
    Headlines = Table.FromRecords(Source[headlines]),
    Result = [Sector=Sector, Prices=Prices, Holdings=Holdings, CompanyFacts=CompanyFacts,
              FormD=FormD, MacroSeries=MacroSeries, MacroMeta=MacroMeta,
              Events=Events, Headlines=Headlines]
in
    Result

