import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { searchPubmed } from "./pubmed.ts";
import {
  compactPapersForDisplay,
  renderLiteratureSearchResult,
  type LiteratureSearchDisplayEvent,
  type LiteratureSearchDisplaySearch,
} from "./rendering.ts";
import { searchSemanticScholar } from "./semantic-scholar.ts";
import { formatPaperText, normalizeDoi, unique } from "./shared.ts";
import { emitProgress, textResult, type TextToolUpdate } from "./tool-output.ts";
import type { PaperRecord } from "./types.ts";

export const LITERATURE_SEARCH_PARAMS = Type.Object({
  pubmed_query: Type.String({
    description:
      "PubMed-ready query using PubMed syntax such as MeSH [mh], title/abstract [tiab], publication type [pt], substance [nm], and Boolean logic.",
  }),
  semantic_scholar_query: Type.Optional(
    Type.String({
      description:
        "Optional natural-language Semantic Scholar query for supplementary search. If omitted and Semantic Scholar is configured, a simplified query is derived from pubmed_query.",
    }),
  ),
  max_results: Type.Optional(
    Type.Number({ description: "Maximum results per provider (default 20)" }),
  ),
  date_from: Type.Optional(
    Type.String({ description: "PubMed publication start date as YYYY/MM/DD" }),
  ),
  date_to: Type.Optional(
    Type.String({ description: "PubMed publication end date as YYYY/MM/DD" }),
  ),
  publication_types: Type.Optional(
    Type.Array(Type.String({ description: "PubMed publication type" })),
  ),
  fetch_abstracts: Type.Optional(
    Type.Boolean({ description: "Whether PubMed should fetch abstracts (default true)" }),
  ),
});

export type LiteratureSearchParams = Static<typeof LITERATURE_SEARCH_PARAMS>;

type ProviderExecution =
  | { searched: true; count: number; query: string; total?: number }
  | { searched: false; reason: string };

export type LiteratureSearchResult = {
  count: number;
  papers: PaperRecord[];
  providers: {
    pubmed: ProviderExecution;
    semantic_scholar: ProviderExecution;
  };
  searches: LiteratureSearchDisplaySearch[];
  events: LiteratureSearchDisplayEvent[];
};

function firstYear(value?: string): number | undefined {
  const match = value?.match(/^(\d{4})/);
  return match?.[1] ? Number(match[1]) : undefined;
}

export function simplifyPubmedQueryForSemanticScholar(query: string): string {
  const simplified = query
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\b(?:AND|OR|NOT)\b/gi, " ")
    .replace(/[()"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return simplified || query.trim();
}

function sourceList(paper: PaperRecord): string[] {
  return unique([
    ...(paper.sources ?? []),
    ...(paper.source ? paper.source.split(";") : []),
  ].map((source) => source.trim()).filter(Boolean));
}

function normalizedTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeKeys(paper: PaperRecord): string[] {
  const doi = normalizeDoi(paper.doi)?.toLowerCase();
  const keys = [
    doi ? `doi:${doi}` : undefined,
    paper.pmid ? `pmid:${paper.pmid}` : undefined,
    paper.s2_id ? `s2:${paper.s2_id}` : undefined,
  ];
  const title = normalizedTitle(paper.title);
  if (title && paper.year) keys.push(`title-year:${title}:${paper.year}`);
  return unique(keys);
}

function mergePapers(existing: PaperRecord, incoming: PaperRecord): PaperRecord {
  const sources = unique([...sourceList(existing), ...sourceList(incoming)]);
  return {
    ...incoming,
    ...existing,
    doi: normalizeDoi(existing.doi) ?? normalizeDoi(incoming.doi),
    pmid: existing.pmid ?? incoming.pmid,
    s2_id: existing.s2_id ?? incoming.s2_id,
    title: existing.title !== "Untitled" ? existing.title : incoming.title,
    abstract: existing.abstract ?? incoming.abstract,
    authors: unique([...(existing.authors ?? []), ...(incoming.authors ?? [])]),
    journal: existing.journal ?? incoming.journal,
    year: existing.year ?? incoming.year,
    publication_types: unique([
      ...(existing.publication_types ?? []),
      ...(incoming.publication_types ?? []),
    ]),
    mesh_terms: unique([...(existing.mesh_terms ?? []), ...(incoming.mesh_terms ?? [])]),
    citation_count: existing.citation_count ?? incoming.citation_count,
    tldr: existing.tldr ?? incoming.tldr,
    open_access_pdf: existing.open_access_pdf ?? incoming.open_access_pdf,
    external_ids: { ...(incoming.external_ids ?? {}), ...(existing.external_ids ?? {}) },
    source: sources.join(";"),
    sources,
  };
}

export function dedupeLiteraturePapers(papers: PaperRecord[]): PaperRecord[] {
  const merged: PaperRecord[] = [];
  const keyToIndex = new Map<string, number>();

  for (const paper of papers) {
    const keys = dedupeKeys(paper);
    const existingIndex = keys
      .map((key) => keyToIndex.get(key))
      .find((index) => index !== undefined);

    if (existingIndex === undefined) {
      const index = merged.length;
      const sources = sourceList(paper);
      merged.push({ ...paper, source: sources.join(";"), sources });
      for (const key of keys) keyToIndex.set(key, index);
      continue;
    }

    merged[existingIndex] = mergePapers(merged[existingIndex], paper);
    for (const key of dedupeKeys(merged[existingIndex])) keyToIndex.set(key, existingIndex);
  }

  return merged;
}

export async function searchLiterature(
  params: LiteratureSearchParams,
  signal?: AbortSignal,
  onUpdate?: TextToolUpdate,
): Promise<LiteratureSearchResult> {
  const maxResults = Math.min(
    200,
    Math.max(1, Math.floor(params.max_results ?? 20)),
  );

  const events: LiteratureSearchDisplayEvent[] = [{ phase: "start" }];
  const searches: LiteratureSearchDisplaySearch[] = [];
  const emitEvent = (text: string) => {
    emitProgress(onUpdate, text, { events: [...events] });
  };

  emitEvent("Starting literature search...");

  events.push({
    phase: "query_start",
    provider: "pubmed",
    query_index: 1,
    query: params.pubmed_query,
  });
  emitEvent(`Searching PubMed q1: ${params.pubmed_query}`);

  const pubmed = await searchPubmed(
    {
      query: params.pubmed_query,
      max_results: maxResults,
      date_from: params.date_from,
      date_to: params.date_to,
      publication_types: params.publication_types,
      fetch_abstracts: params.fetch_abstracts,
    },
    signal,
    undefined,
  );

  const pubmedDisplayPapers = compactPapersForDisplay(pubmed.papers);
  searches.push({
    provider: "pubmed",
    query_index: 1,
    query: pubmed.query ?? params.pubmed_query,
    count: pubmed.count,
    papers: pubmedDisplayPapers,
  });
  events.push({
    phase: "query_results",
    provider: "pubmed",
    query_index: 1,
    query: pubmed.query ?? params.pubmed_query,
    count: pubmed.count,
    papers: pubmedDisplayPapers,
  });
  emitEvent(`PubMed q1 found ${pubmed.count} candidate papers.`);

  const semanticScholarApiKey = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
  let semanticScholar: ProviderExecution = {
    searched: false,
    reason: "SEMANTIC_SCHOLAR_API_KEY not configured",
  };
  let semanticScholarPapers: PaperRecord[] = [];

  if (semanticScholarApiKey) {
    const semanticScholarQuery =
      params.semantic_scholar_query?.trim() ||
      simplifyPubmedQueryForSemanticScholar(params.pubmed_query);

    events.push({
      phase: "query_start",
      provider: "semantic_scholar",
      query_index: 1,
      query: semanticScholarQuery,
    });
    emitEvent(`Searching Semantic Scholar q1: ${semanticScholarQuery}`);

    try {
      const semanticScholarResult = await searchSemanticScholar(
        {
          query: semanticScholarQuery,
          max_results: Math.min(100, maxResults),
          year_from: firstYear(params.date_from),
          year_to: firstYear(params.date_to),
        },
        signal,
        undefined,
      );
      semanticScholarPapers = semanticScholarResult.papers;
      const semanticScholarDisplayPapers = compactPapersForDisplay(
        semanticScholarResult.papers,
      );
      searches.push({
        provider: "semantic_scholar",
        query_index: 1,
        query: semanticScholarQuery,
        count: semanticScholarResult.count,
        papers: semanticScholarDisplayPapers,
      });
      events.push({
        phase: "query_results",
        provider: "semantic_scholar",
        query_index: 1,
        query: semanticScholarQuery,
        count: semanticScholarResult.count,
        papers: semanticScholarDisplayPapers,
      });
      emitEvent(
        `Semantic Scholar q1 found ${semanticScholarResult.count} candidate papers.`,
      );
      semanticScholar = {
        searched: true,
        count: semanticScholarResult.count,
        query: semanticScholarQuery,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      events.push({
        phase: "query_error",
        provider: "semantic_scholar",
        query_index: 1,
        query: semanticScholarQuery,
        error: message,
      });
      semanticScholar = {
        searched: false,
        reason: `Semantic Scholar search failed: ${message}`,
      };
      emitEvent(`Semantic Scholar q1 failed: ${message}`);
    }
  }

  events.push({ phase: "dedupe" });
  emitEvent("Deduplicating literature results...");

  const papers = dedupeLiteraturePapers([
    ...pubmed.papers,
    ...semanticScholarPapers,
  ]);
  events.push({
    phase: "complete",
    count: papers.length,
    papers: compactPapersForDisplay(papers),
  });
  emitEvent(`Literature search complete: ${papers.length} merged papers.`);

  return {
    count: papers.length,
    papers,
    providers: {
      pubmed: {
        searched: true,
        count: pubmed.count,
        query: pubmed.query ?? params.pubmed_query,
        total: pubmed.total,
      },
      semantic_scholar: semanticScholar,
    },
    searches,
    events,
  };
}

export function createLiteratureSearchTool() {
  return {
    name: "literature_search",
    label: "Literature Search",
    description:
      "Run the literature workflow search: PubMed is always searched first with a PubMed-ready query; Semantic Scholar is searched as supplementary metadata when SEMANTIC_SCHOLAR_API_KEY is configured.",
    parameters: LITERATURE_SEARCH_PARAMS,
    async execute(
      _toolCallId: string,
      params: LiteratureSearchParams,
      signal?: AbortSignal,
      onUpdate?: TextToolUpdate,
    ) {
      const result = await searchLiterature(params, signal, onUpdate);
      return textResult(formatPaperText(result.papers), result);
    },
    renderResult(
      result: Parameters<typeof renderLiteratureSearchResult>[0],
      options: Parameters<typeof renderLiteratureSearchResult>[1],
      theme: Parameters<typeof renderLiteratureSearchResult>[2],
    ) {
      return renderLiteratureSearchResult(result, options, theme);
    },
  };
}

export function registerLiteratureSearchTool(pi: ExtensionAPI): void {
  pi.registerTool(createLiteratureSearchTool());
}
