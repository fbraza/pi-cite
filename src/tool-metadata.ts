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
    "Submit at most two searches or selected full-text calls at a time; await Promise.allSettled to retain successes and warnings. Provider lanes share pacing/backoff within this loaded runtime, not across processes. Separate literature_search calls repeat the ownership scan.",
    "Final direct text is limited to 32 KiB UTF-8; large results include model_output.full_result_path for complete JSON. Read/copy that private temporary file for full evidence. Structured script results remain complete; save large sets with write, not store().",
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
