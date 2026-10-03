import { Type, type Static } from "typebox";

/** Public data contracts. UI event histories and display previews are not tool outputs. */
export const PAPER_RECORD_SCHEMA = Type.Object({
  pmid: Type.Optional(Type.String()),
  pmcid: Type.Optional(Type.String()),
  doi: Type.Optional(Type.String()),
  title: Type.String(),
  abstract: Type.Optional(Type.String()),
  authors: Type.Optional(Type.Array(Type.String())),
  journal: Type.Optional(Type.String()),
  year: Type.Optional(Type.Integer()),
  publication_types: Type.Optional(Type.Array(Type.String())),
  mesh_terms: Type.Optional(Type.Array(Type.String())),
  source: Type.Optional(Type.String()),
  sources: Type.Optional(Type.Array(Type.String())),
  date: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),
  version: Type.Optional(Type.String()),
  license: Type.Optional(Type.String()),
  in_zotero: Type.Optional(Type.Boolean()),
  zotero_key: Type.Optional(Type.String()),
}, { additionalProperties: false });

const searchProperties = {
  count: Type.Integer({ minimum: 0, description: "Number of returned papers." }),
  papers: Type.Array(PAPER_RECORD_SCHEMA),
  total: Type.Optional(Type.Integer({ minimum: 0, description: "Total provider matches, when reported." })),
};

export const PUBMED_SEARCH_OUTPUT = Type.Object({
  ...searchProperties,
  query: Type.String({ description: "Effective PubMed query, including filters." }),
}, { additionalProperties: false });

export const ZOTERO_SEARCH_OUTPUT = Type.Object({
  ...searchProperties,
  query: Type.String({ description: "Requested Zotero query." }),
}, { additionalProperties: false });

export const PROVIDER_EXECUTION_SCHEMA = Type.Union([
  Type.Object({
    searched: Type.Literal(true),
    count: Type.Integer({ minimum: 0, description: "Returned PubMed papers or scanned Zotero library items." }),
    query: Type.String(),
    total: Type.Optional(Type.Integer({ minimum: 0 })),
  }, { additionalProperties: false }),
  Type.Object({
    searched: Type.Literal(false),
    reason: Type.String(),
  }, { additionalProperties: false }),
]);

export const LITERATURE_SEARCH_OUTPUT = Type.Object({
  count: searchProperties.count,
  papers: searchProperties.papers,
  providers: Type.Object({
    pubmed: PROVIDER_EXECUTION_SCHEMA,
    zotero: Type.Optional(PROVIDER_EXECUTION_SCHEMA),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const bodySections = ["introduction", "methods", "results", "discussion", "conclusion"] as const;
export const EUROPE_PMC_SECTIONS = [...bodySections, "all"] as const;
export const EUROPE_PMC_SECTION_SCHEMA = Type.Enum(EUROPE_PMC_SECTIONS);
const bodySectionSchema = Type.Enum(bodySections);

export const EUROPE_PMC_UNAVAILABLE_REASON_SCHEMA = Type.Union([
  Type.Literal("not_found"),
  Type.Literal("ambiguous_match"),
  Type.Literal("not_open_access"),
  Type.Literal("no_pmcid"),
  Type.Literal("xml_not_available"),
  Type.Literal("source_too_large"),
]);

export const EUROPE_PMC_METADATA_SCHEMA = Type.Object({
  title: Type.Optional(Type.String()),
  author_string: Type.Optional(Type.String()),
  journal: Type.Optional(Type.String()),
  year: Type.Optional(Type.String()),
  doi: Type.Optional(Type.String()),
  pmid: Type.Optional(Type.String()),
  pmcid: Type.Optional(Type.String()),
  license: Type.Optional(Type.String()),
  is_open_access: Type.Boolean(),
}, { additionalProperties: false });

const identifierSchema = Type.Object({
  type: Type.Union([Type.Literal("doi"), Type.Literal("pmid"), Type.Literal("pmcid")]),
  normalized: Type.String(),
}, { additionalProperties: false });

const provenanceProperties = {
  provider: Type.Literal("Europe PMC"),
  api_version: Type.Literal("6.9"),
  search_url: Type.String(),
};

export const EUROPE_PMC_UNAVAILABLE_OUTPUT = Type.Object({
  tool: Type.Literal("europe_pmc_fulltext"),
  status: Type.Literal("unavailable"),
  reason: EUROPE_PMC_UNAVAILABLE_REASON_SCHEMA,
  recommended_fallback: Type.Literal("pubmed_abstract"),
  identifier: identifierSchema,
  metadata: Type.Optional(EUROPE_PMC_METADATA_SCHEMA),
  provenance: Type.Object({
    ...provenanceProperties,
    full_text_url: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const EUROPE_PMC_FULLTEXT_OUTPUT = Type.Object({
  tool: Type.Literal("europe_pmc_fulltext"),
  status: Type.Literal("full_text"),
  identifier: identifierSchema,
  metadata: EUROPE_PMC_METADATA_SCHEMA,
  sections: Type.Array(Type.Object({
    section: Type.Union([bodySectionSchema, Type.Literal("other")]),
    heading: Type.String(),
    text: Type.String(),
    truncated: Type.Boolean(),
  }, { additionalProperties: false })),
  requested_sections: Type.Array(EUROPE_PMC_SECTION_SCHEMA),
  missing_sections: Type.Array(bodySectionSchema),
  section_fallback: Type.Boolean(),
  truncated: Type.Boolean(),
  max_chars: Type.Integer({ minimum: 1, maximum: 24_000 }),
  returned_chars: Type.Integer({ minimum: 0 }),
  provenance: Type.Object({
    ...provenanceProperties,
    full_text_url: Type.String(),
  }, { additionalProperties: false }),
  urls: Type.Object({
    europe_pmc: Type.String(),
    doi: Type.Optional(Type.String()),
    pmc: Type.String(),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const EUROPE_PMC_OUTPUT = Type.Union([EUROPE_PMC_FULLTEXT_OUTPUT, EUROPE_PMC_UNAVAILABLE_OUTPUT]);

export type PaperRecord = Static<typeof PAPER_RECORD_SCHEMA>;
export type PubmedSearchOutput = Static<typeof PUBMED_SEARCH_OUTPUT>;
export type ZoteroSearchOutput = Static<typeof ZOTERO_SEARCH_OUTPUT>;
export type LiteratureSearchOutput = Static<typeof LITERATURE_SEARCH_OUTPUT>;
export type EuropePmcSection = Static<typeof EUROPE_PMC_SECTION_SCHEMA>;
export type EuropePmcMetadata = Static<typeof EUROPE_PMC_METADATA_SCHEMA>;
export type EuropePmcUnavailableReason = Static<typeof EUROPE_PMC_UNAVAILABLE_REASON_SCHEMA>;
export type EuropePmcUnavailableResult = Static<typeof EUROPE_PMC_UNAVAILABLE_OUTPUT>;
export type EuropePmcFulltextResult = Static<typeof EUROPE_PMC_FULLTEXT_OUTPUT>;
export type EuropePmcResult = Static<typeof EUROPE_PMC_OUTPUT>;
