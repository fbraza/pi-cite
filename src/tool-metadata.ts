import type { ToolAnnotations, ToolNamespace } from "@earendil-works/pi-coding-agent";

export const LITERATURE_TOOL_NAMES = [
  "literature_search", "pubmed_search", "zotero_search", "europe_pmc_fulltext",
] as const;
export type LiteratureToolName = (typeof LITERATURE_TOOL_NAMES)[number];

export const LITERATURE_NAMESPACE: ToolNamespace = {
  name: "literature",
  description: "Search literature and retrieve open-access evidence.",
  instructions: [
    "literature_search searches PubMed and optionally checks Zotero ownership; pubmed_search skips that ownership scan.",
    "Use PubMed-ready queries with MeSH, title/abstract, publication-type, and Boolean syntax.",
    "Search results are objects: use result.papers, not JSON.parse(result). Preserve identifiers and provider warnings when filtering.",
    "zotero_search is read-only and requires a configured Zotero API key.",
    "Retrieve Europe PMC full text only when requested by the user. Inspect status, provenance, missing_sections, and truncation; unavailable is normal fallback data, not an error.",
    "Keep provider requests conservative; separate literature_search calls repeat the ownership scan. Use Promise.allSettled to retain successful calls when another fails.",
    "Print only the evidence needed for the current task; codemode does not send unprinted data to the model.",
  ].join("\n"),
};

export const LITERATURE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const LITERATURE_TOOL_METADATA = {
  namespace: LITERATURE_NAMESPACE,
  annotations: LITERATURE_ANNOTATIONS,
};
