import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { searchPubmed } from "./pubmed.ts";
import {
  compactPapersForDisplay,
  renderLiteratureSearchResult,
  type LiteratureSearchDisplayEvent,
  type LiteratureSearchDisplaySearch,
} from "./rendering.ts";
import { formatPaperText, normalizeDoi, unique } from "./shared.ts";
import { emitProgress, textResult, type TextToolUpdate } from "./tool-output.ts";
import type { PaperRecord } from "./types.ts";

export const LITERATURE_SEARCH_PARAMS = Type.Object({
  pubmed_query: Type.String({
    description:
      "PubMed-ready query using PubMed syntax such as MeSH [mh], title/abstract [tiab], publication type [pt], substance [nm], and Boolean logic.",
  }),
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
  };
  searches: LiteratureSearchDisplaySearch[];
  events: LiteratureSearchDisplayEvent[];
};

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

  emitEvent("Searching PubMed...");

  events.push({
    phase: "query_start",
    provider: "pubmed",
    query_index: 1,
    query: params.pubmed_query,
  });
  emitEvent("Searching PubMed...");

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
  });
  emitEvent(`Found ${pubmed.count} PubMed ${pubmed.count === 1 ? "paper" : "papers"}.`);

  events.push({ phase: "dedupe" });
  emitEvent("Preparing results...");

  const papers = dedupeLiteraturePapers(pubmed.papers);
  events.push({
    phase: "complete",
    count: papers.length,
  });
  emitEvent(`Literature search complete: ${papers.length} PubMed ${papers.length === 1 ? "paper" : "papers"}.`);

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
      "Run the literature workflow search against PubMed using a PubMed-ready query (MeSH [mh], title/abstract [tiab], publication type [pt], substance [nm], and Boolean logic).",
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
