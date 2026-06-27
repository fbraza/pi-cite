import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { searchPubmed } from "./pubmed.ts";
import {
  compactPapersForDisplay,
  renderLiteratureSearchResult,
  type LiteratureSearchDisplayEvent,
  type LiteratureSearchDisplaySearch,
} from "./rendering.ts";
import { formatPaperText, normalizeDoi, unique, dedupeKeys } from "./shared.ts";
import { emitProgress, textResult, type TextToolUpdate } from "./tool-output.ts";
import type { PaperRecord } from "./types.ts";
import {
	getZoteroApiKey,
	markPapersWithZoteroOwnership,
	prepareZoteroOwnership,
	ZOTERO_DEFAULT_INDEX_CAP,
} from "./zotero.ts";

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
    zotero?: ProviderExecution;
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

  let papers = dedupeLiteraturePapers(pubmed.papers);

  const providers: LiteratureSearchResult["providers"] = {
    pubmed: {
      searched: true,
      count: pubmed.count,
      query: pubmed.query ?? params.pubmed_query,
      total: pubmed.total,
    },
  };

  // Zotero ownership check: when an API key is configured and PubMed returned
  // candidates, scan the user's library and flag which candidates they already
  // own. The library JSON is consumed inside the extension; only the resulting
  // in_zotero flag reaches the agent's context.
  const zoteroApiKey = getZoteroApiKey();
  if (zoteroApiKey && papers.length > 0) {
    try {
      events.push({ phase: "zotero_start" });
      emitEvent("Checking your Zotero library...");
      const ownership = await prepareZoteroOwnership({
        apiKey: zoteroApiKey,
        cap: ZOTERO_DEFAULT_INDEX_CAP,
        signal,
        onProgress: ({ items, total }) => {
          events.push({ phase: "zotero_progress", library_items: items, total });
          emitEvent(
            `Reading Zotero library... ${items}${total ? ` of ~${total}` : ""} items`,
          );
        },
      });
      const marked = markPapersWithZoteroOwnership(papers, ownership.index);
      const matched = marked.filter((paper) => paper.in_zotero).length;
      papers = marked;
      providers.zotero = {
        searched: true,
        count: ownership.libraryItems,
        query: "ownership scan",
        total: ownership.total,
      };
      events.push({
        phase: "zotero_results",
        library_items: ownership.libraryItems,
        matched,
        total_candidates: papers.length,
      });
      emitEvent(
        `${matched} of ${papers.length} candidates already in your Zotero library.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providers.zotero = { searched: false, reason: message };
      events.push({
        phase: "query_error",
        provider: "zotero",
        query_index: 0,
        query: "ownership scan",
        error: message,
      });
      emitEvent("Zotero check failed; continuing without ownership flags.");
    }
  } else if (zoteroApiKey) {
    providers.zotero = { searched: false, reason: "No PubMed candidates to check" };
  }

  events.push({ phase: "complete", count: papers.length });
  const zoteroMatched = papers.filter((paper) => paper.in_zotero).length;
  const zoteroNote =
    providers.zotero?.searched && zoteroMatched > 0
      ? ` (${zoteroMatched} already in Zotero)`
      : "";
  emitEvent(
    `Literature search complete: ${papers.length} PubMed ${papers.length === 1 ? "paper" : "papers"}${zoteroNote}.`,
  );

  return {
    count: papers.length,
    papers,
    providers,
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
