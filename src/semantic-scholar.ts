import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { renderProviderSearchResult } from "./rendering.ts";
import { emitProgress, textResult, type TextToolUpdate } from "./tool-output.ts";
import { fetchJson, formatPaperText, normalizeDoi } from "./shared.ts";
import type { FullTextRouteResult, PaperRecord } from "./types.ts";

export const SEMANTIC_SCHOLAR_PARAMS = Type.Object({
  query: Type.String({ description: "Search query" }),
  max_results: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default 20, max 100)",
    }),
  ),
  year_from: Type.Optional(
    Type.Number({ description: "Minimum publication year" }),
  ),
  year_to: Type.Optional(
    Type.Number({ description: "Maximum publication year" }),
  ),
  fields_of_study: Type.Optional(
    Type.Array(Type.String({ description: "Field of study" })),
  ),
  min_citation_count: Type.Optional(
    Type.Number({ description: "Minimum citation count" }),
  ),
  open_access_only: Type.Optional(
    Type.Boolean({ description: "Only keep open access papers" }),
  ),
});

export type SemanticScholarSearchParams = Static<typeof SEMANTIC_SCHOLAR_PARAMS>;

type SemanticScholarPaperResponse = {
  paperId?: string;
  title?: string;
  abstract?: string | null;
  year?: number | null;
  citationCount?: number | null;
  tldr?: { text?: string | null } | null;
  externalIds?: Record<string, string | undefined>;
  openAccessPdf?: { url?: string | null } | null;
  fieldsOfStudy?: string[] | null;
  authors?: Array<{ name?: string | null }> | null;
};

export async function trySemanticScholarOpenAccess(
  doi: string,
  signal?: AbortSignal,
): Promise<FullTextRouteResult> {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", doi);
  url.searchParams.set("limit", "5");
  url.searchParams.set(
    "fields",
    "title,openAccessPdf,externalIds,isOpenAccess",
  );
  const data = await fetchJson<{
    data?: Array<{
      openAccessPdf?: { url?: string };
      externalIds?: Record<string, string>;
    }>;
  }>(url.toString(), signal);
  const match = (data.data ?? []).find(
    (item) =>
      normalizeDoi(item.externalIds?.DOI) === normalizeDoi(doi) &&
      item.openAccessPdf?.url,
  );
  const pdfUrl = match?.openAccessPdf?.url;
  if (!pdfUrl) {
    return {
      source: "not_found",
      access_note: "No open-access PDF found via Semantic Scholar",
    };
  }
  return {
    source: "semantic_scholar_oa",
    pdf_url: pdfUrl,
    access_note: "Open-access PDF found via Semantic Scholar openAccessPdf",
  };
}

export type SemanticScholarSearchResult = {
  count: number;
  papers: PaperRecord[];
  query?: string;
};

export async function searchSemanticScholar(
  params: SemanticScholarSearchParams,
  signal?: AbortSignal,
  onUpdate?: TextToolUpdate,
): Promise<SemanticScholarSearchResult> {
  const maxResults = Math.min(
    100,
    Math.max(1, Math.floor(params.max_results ?? 20)),
  );
  const url = new URL(
    "https://api.semanticscholar.org/graph/v1/paper/search",
  );
  url.searchParams.set("query", params.query);
  url.searchParams.set("limit", String(maxResults));
  url.searchParams.set(
    "fields",
    [
      "paperId",
      "title",
      "abstract",
      "year",
      "citationCount",
      "tldr",
      "externalIds",
      "openAccessPdf",
      "fieldsOfStudy",
      "isOpenAccess",
      "authors",
    ].join(","),
  );
  if (params.year_from)
    url.searchParams.set(
      "year",
      `${params.year_from}-${params.year_to ?? ""}`,
    );
  emitProgress(onUpdate, `Searching Semantic Scholar for: ${params.query}`);
  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
  const response = await fetchJson<{ data?: SemanticScholarPaperResponse[] }>(
    url.toString(),
    signal,
    apiKey ? { "x-api-key": apiKey } : undefined,
  );
  let papers: PaperRecord[] = (response.data ?? []).map((item) => ({
    s2_id: item.paperId,
    title: item.title ?? "Untitled",
    abstract: item.abstract ?? undefined,
    year: item.year ?? undefined,
    citation_count: item.citationCount ?? undefined,
    tldr: item.tldr?.text ?? undefined,
    open_access_pdf: item.openAccessPdf?.url ?? undefined,
    external_ids: item.externalIds ?? undefined,
    doi: normalizeDoi(item.externalIds?.DOI),
    pmid: item.externalIds?.PubMed ?? item.externalIds?.PMID,
    authors: Array.isArray(item.authors)
      ? item.authors.map((author) => author.name).filter(Boolean)
      : [],
    source: "semantic_scholar",
  }));
  if (params.fields_of_study?.length) {
    const wanted = new Set(
      params.fields_of_study.map((item: string) => item.toLowerCase()),
    );
    papers = papers.filter((paper, index) => {
      const fields = (response.data?.[index]?.fieldsOfStudy ?? []).map(
        (item: string) => item.toLowerCase(),
      );
      return fields.some((item: string) => wanted.has(item));
    });
  }
  if (params.min_citation_count !== undefined)
    papers = papers.filter(
      (paper) => (paper.citation_count ?? 0) >= params.min_citation_count,
    );
  if (params.open_access_only)
    papers = papers.filter((paper) => !!paper.open_access_pdf);
  if (params.year_from !== undefined)
    papers = papers.filter((paper) => (paper.year ?? 0) >= params.year_from);
  if (params.year_to !== undefined)
    papers = papers.filter((paper) => (paper.year ?? 9999) <= params.year_to);
  return { count: papers.length, papers, query: params.query };
}

export function createSemanticScholarSearchTool() {
  return {
    name: "semantic_scholar_search",
    label: "Semantic Scholar Search",
    description:
      "Search Semantic Scholar for relevance-ranked papers, citation counts, and open-access metadata.",
    parameters: SEMANTIC_SCHOLAR_PARAMS,
    async execute(
      _toolCallId: string,
      params: SemanticScholarSearchParams,
      signal?: AbortSignal,
      onUpdate?: TextToolUpdate,
    ) {
      const result = await searchSemanticScholar(params, signal, onUpdate);
      return textResult(formatPaperText(result.papers), result);
    },
    renderResult(
      result: Parameters<typeof renderProviderSearchResult>[1],
      options: Parameters<typeof renderProviderSearchResult>[2],
      theme: Parameters<typeof renderProviderSearchResult>[3],
    ) {
      return renderProviderSearchResult("semantic_scholar", result, options, theme);
    },
  };
}

export function registerSemanticScholarSearchTool(pi: ExtensionAPI): void {
  pi.registerTool(createSemanticScholarSearchTool());
}
