import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { renderProviderSearchResult } from "./rendering.ts";
import { emitProgress, textResult, type TextToolUpdate } from "./tool-output.ts";
import {
  fetchJson,
  fetchText,
  formatPaperText,
  normalizeDoi,
  pickAll,
  pickOne,
  sleep,
  unique,
  xmlDecode,
} from "./shared.ts";
import type { PaperRecord } from "./types.ts";

export const PUBMED_SEARCH_PARAMS = Type.Object({
  query: Type.String({
    description:
      "PubMed query string (supports field tags like [tiab], [mh], [pt])",
  }),
  max_results: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default 20, max 200)",
    }),
  ),
  date_from: Type.Optional(
    Type.String({ description: "Start date as YYYY/MM/DD" }),
  ),
  date_to: Type.Optional(
    Type.String({ description: "End date as YYYY/MM/DD" }),
  ),
  publication_types: Type.Optional(
    Type.Array(Type.String({ description: "PubMed publication type" })),
  ),
  fetch_abstracts: Type.Optional(
    Type.Boolean({ description: "Whether to fetch abstracts (default true)" }),
  ),
  sort: Type.Optional(
    Type.Union([
      Type.Literal("relevance"),
      Type.Literal("pub_date"),
      Type.Literal("first_author"),
    ]),
  ),
  api_key: Type.Optional(
    Type.String({
      description: "Environment variable name containing an NCBI API key (defaults to NCBI_API_KEY when omitted)",
    }),
  ),
});

export type PubmedSearchParams = Static<typeof PUBMED_SEARCH_PARAMS>;

export const DEFAULT_NCBI_API_KEY_ENV = "NCBI_API_KEY";

export function getNcbiApiKey(envVarName?: string): string | undefined {
  const keyEnv = envVarName?.trim() || DEFAULT_NCBI_API_KEY_ENV;
  const apiKey = process.env[keyEnv]?.trim();
  return apiKey || undefined;
}

export function addNcbiApiKeyParam(url: URL, envVarName?: string): boolean {
  const apiKey = getNcbiApiKey(envVarName);
  if (!apiKey) return false;
  url.searchParams.set("api_key", apiKey);
  return true;
}

export function normalizePubmedQuery(
  query: string,
  publicationTypes?: string[],
  dateFrom?: string,
  dateTo?: string,
): string {
  const fragments = [query.trim()].filter(Boolean);
  if (publicationTypes && publicationTypes.length > 0) {
    fragments.push(
      `(${publicationTypes.map((item) => `\"${item}\"[Publication Type]`).join(" OR ")})`,
    );
  }
  if (dateFrom || dateTo) {
    const start = dateFrom ?? "1000/01/01";
    const end = dateTo ?? "3000/12/31";
    fragments.push(`(${start}:${end}[Date - Publication])`);
  }
  return fragments.join(" AND ");
}

export function parsePubmedArticle(articleXml: string): PaperRecord {
  const pmid = pickOne(/<PMID[^>]*>(.*?)<\/PMID>/i, articleXml);
  const title =
    pickOne(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/i, articleXml) ??
    "Untitled";
  const abstractSections = pickAll(
    /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/gi,
    articleXml,
  );
  const abstract = abstractSections.join(" ").trim() || undefined;
  const journal =
    pickOne(/<Title>([\s\S]*?)<\/Title>/i, articleXml) ??
    pickOne(/<ISOAbbreviation>(.*?)<\/ISOAbbreviation>/i, articleXml);
  const yearText =
    pickOne(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/i, articleXml) ??
    pickOne(/<ArticleDate[^>]*>[\s\S]*?<Year>(\d{4})<\/Year>/i, articleXml) ??
    pickOne(
      /<PubMedPubDate[^>]*PubStatus=\"pubmed\">[\s\S]*?<Year>(\d{4})<\/Year>/i,
      articleXml,
    );
  const doi =
    normalizeDoi(
      pickOne(
        /<ELocationID[^>]*EIdType=\"doi\"[^>]*>(.*?)<\/ELocationID>/i,
        articleXml,
      ),
    ) ??
    normalizeDoi(
      pickOne(
        /<ArticleId[^>]*IdType=\"doi\"[^>]*>(.*?)<\/ArticleId>/i,
        articleXml,
      ),
    );
  const publicationTypes = unique(
    pickAll(
      /<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/gi,
      articleXml,
    ),
  );
  const meshTerms = unique(
    pickAll(/<DescriptorName[^>]*>([\s\S]*?)<\/DescriptorName>/gi, articleXml),
  );
  const authors = unique(
    Array.from(
      articleXml.matchAll(
        /<Author[\s\S]*?<LastName>(.*?)<\/LastName>[\s\S]*?(?:<ForeName>(.*?)<\/ForeName>|<Initials>(.*?)<\/Initials>)/gi,
      ),
    ).map((match) => {
      const last = xmlDecode(match[1] ?? "");
      const fore = xmlDecode(match[2] ?? match[3] ?? "");
      return [fore, last].filter(Boolean).join(" ").trim();
    }),
  );
  const collectiveAuthors = pickAll(
    /<CollectiveName>([\s\S]*?)<\/CollectiveName>/gi,
    articleXml,
  );
  return {
    pmid,
    doi,
    title,
    abstract,
    authors: unique([...authors, ...collectiveAuthors]),
    journal,
    year: yearText ? Number(yearText) : undefined,
    publication_types: publicationTypes,
    mesh_terms: meshTerms,
    source: "pubmed",
  };
}

export function parsePubmedArticles(xml: string): PaperRecord[] {
  const chunks = xml.match(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/gi) ?? [];
  return chunks.map(parsePubmedArticle);
}

export async function lookupPubmedIdentifiers(
  pmid: string,
  signal?: AbortSignal,
): Promise<{ doi?: string; title?: string }> {
  const url = new URL(
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
  );
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("id", pmid);
  url.searchParams.set("retmode", "xml");
  addNcbiApiKeyParam(url);
  const xml = await fetchText(url.toString(), signal);
  const article = parsePubmedArticles(xml)[0];
  return { doi: article?.doi, title: article?.title };
}

export type PubmedSearchResult = {
  count: number;
  papers: PaperRecord[];
  query?: string;
  total?: number;
};

export async function searchPubmed(
  params: PubmedSearchParams,
  signal?: AbortSignal,
  onUpdate?: TextToolUpdate,
): Promise<PubmedSearchResult> {
  const maxResults = Math.min(
    200,
    Math.max(1, Math.floor(params.max_results ?? 20)),
  );
  const query = normalizePubmedQuery(
    params.query,
    params.publication_types,
    params.date_from,
    params.date_to,
  );
  const esearchUrl = new URL(
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
  );
  esearchUrl.searchParams.set("db", "pubmed");
  esearchUrl.searchParams.set("retmode", "json");
  esearchUrl.searchParams.set("retmax", String(maxResults));
  esearchUrl.searchParams.set("sort", params.sort ?? "relevance");
  esearchUrl.searchParams.set("term", query);
  const hasApiKey = addNcbiApiKeyParam(esearchUrl, params.api_key);
  emitProgress(onUpdate, `Searching PubMed for: ${params.query}`);
  const esearch = await fetchJson<{
    esearchresult?: { idlist?: string[]; count?: string };
  }>(esearchUrl.toString(), signal);
  const ids = esearch.esearchresult?.idlist ?? [];
  if (ids.length === 0) {
    return { count: 0, papers: [] };
  }
  if (params.fetch_abstracts === false) {
    const papers = ids.map((pmid) => ({
      pmid,
      title: "PubMed record",
      source: "pubmed",
    }));
    return { count: papers.length, papers, query };
  }
  const rateLimitMs = hasApiKey ? 120 : 350;
  const batchSize = 50;
  const papers: PaperRecord[] = [];
  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize);
    emitProgress(
      onUpdate,
      `Searching PubMed... found ${ids.length} PMIDs, fetching abstracts ${start + 1}-${Math.min(start + batch.length, ids.length)}...`,
    );
    const efetchUrl = new URL(
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
    );
    efetchUrl.searchParams.set("db", "pubmed");
    efetchUrl.searchParams.set("retmode", "xml");
    efetchUrl.searchParams.set("id", batch.join(","));
    addNcbiApiKeyParam(efetchUrl, params.api_key);
    const xml = await fetchText(efetchUrl.toString(), signal);
    papers.push(...parsePubmedArticles(xml));
    if (start + batchSize < ids.length) await sleep(rateLimitMs, signal);
  }
  return {
    count: papers.length,
    papers,
    query,
    total: Number(esearch.esearchresult?.count ?? papers.length),
  };
}

export function createPubmedSearchTool() {
  return {
    name: "pubmed_search",
    label: "PubMed Search",
    description:
      "Search PubMed using typed parameters and return metadata with abstracts when available.",
    parameters: PUBMED_SEARCH_PARAMS,
    async execute(
      _toolCallId: string,
      params: PubmedSearchParams,
      signal?: AbortSignal,
      onUpdate?: TextToolUpdate,
    ) {
      const result = await searchPubmed(params, signal, onUpdate);
      return textResult(formatPaperText(result.papers), result);
    },
    renderResult(
      result: Parameters<typeof renderProviderSearchResult>[1],
      options: Parameters<typeof renderProviderSearchResult>[2],
      theme: Parameters<typeof renderProviderSearchResult>[3],
    ) {
      return renderProviderSearchResult("pubmed", result, options, theme);
    },
  };
}

export function registerPubmedSearchTool(pi: ExtensionAPI): void {
  pi.registerTool(createPubmedSearchTool());
}
