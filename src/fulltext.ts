import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { addNcbiApiKeyParam, lookupPubmedIdentifiers } from "./pubmed.ts";
import {
  fetchText,
  normalizeDoi,
  savePdf,
  unique,
  USER_AGENT,
} from "./shared.ts";
import { emitProgress, errorResult, textResult, type TextToolUpdate } from "./tool-output.ts";
import { trySemanticScholarOpenAccess } from "./semantic-scholar.ts";
import type { FullTextRouteResult } from "./types.ts";

export const FETCH_FULLTEXT_PARAMS = Type.Object({
  pmid: Type.Optional(Type.String({ description: "PubMed ID" })),
  doi: Type.Optional(Type.String({ description: "Digital Object Identifier" })),
  output_dir: Type.Optional(
    Type.String({ description: "Directory where the PDF should be saved" }),
  ),
});

export type FetchFulltextParams = Static<typeof FETCH_FULLTEXT_PARAMS>;

const SCIHUB_MIRRORS = [
  "https://sci-hub.st",
  "https://sci-hub.ru",
  "https://sci-hub.se",
];
const PDF_PATTERNS = [
  /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/gi,
  /<meta[^>]+property=["']og:pdf["'][^>]+content=["']([^"']+)["']/gi,
  /<meta[^>]+name=["']dc\.identifier["'][^>]+content=["']([^"']*\.pdf[^"']*)["']/gi,
  /<(?:iframe|embed|object)[^>]+(?:src|data)=["']([^"']+)["']/gi,
  /<a[^>]+data-track-action=["'][^"']*pdf[^"']*["'][^>]+href=["']([^"']+)["']/gi,
  /<a[^>]+aria-label=["'][^"']*pdf[^"']*["'][^>]+href=["']([^"']+)["']/gi,
  /["']((?:https?:)?\/\/[^"']+?\.pdf(?:\?[^"']*)?)["']/gi,
  /["']((?:https?:)?\/\/[^"']+?\/pdf(?:\/|\?|$)[^"']*)["']/gi,
  /<a[^>]+href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi,
];

const OA_LINK_PATTERNS = [
  /<a[^>]+href=["']([^"']+)["'][^>]*>[^<]*(?:download\s+pdf|pdf|full\s+text|view\s+pdf)[^<]*<\/a>/gi,
  /<a[^>]+class=["'][^"']*(?:pdf|download|article-pdf)[^"']*["'][^>]+href=["']([^"']+)["']/gi,
  /<link[^>]+type=["']application\/pdf["'][^>]+href=["']([^"']+)["']/gi,
];

const KNOWN_PDF_QUERY_FLAGS = [
  "pdf=1",
  "download=true",
  "download=1",
  "downloadpdf=true",
  "is_pdf=true",
];

function extractPdfCandidates(html: string, pageUrl: string): string[] {
  const urls: string[] = [];
  for (const pattern of PDF_PATTERNS) {
    for (const match of html.matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      try {
        urls.push(
          new URL(
            raw.startsWith("//") ? `https:${raw}` : raw,
            pageUrl,
          ).toString(),
        );
      } catch {
        // ignore invalid candidate
      }
    }
  }
  return unique(urls);
}

function extractOpenAccessLinks(html: string, pageUrl: string): string[] {
  const urls: string[] = [];
  for (const pattern of OA_LINK_PATTERNS) {
    for (const match of html.matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      try {
        urls.push(
          new URL(
            raw.startsWith("//") ? `https:${raw}` : raw,
            pageUrl,
          ).toString(),
        );
      } catch {
        // ignore invalid candidate
      }
    }
  }
  return unique(urls);
}

function candidatePdfVariants(url: string): string[] {
  const variants = [url];
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.toLowerCase().endsWith(".pdf")) {
      variants.push(
        new URL(
          `${parsed.pathname}.pdf${parsed.search}`,
          `${parsed.origin}`,
        ).toString(),
      );
    }
    for (const flag of KNOWN_PDF_QUERY_FLAGS) {
      const withFlag = new URL(parsed.toString());
      const [key, value] = flag.split("=");
      withFlag.searchParams.set(key, value);
      variants.push(withFlag.toString());
    }
    if (/article|full|abstract/i.test(parsed.pathname)) {
      variants.push(
        new URL(
          parsed.pathname.replace(/(article|full|abstract)/i, "pdf"),
          parsed.origin,
        ).toString(),
      );
    }
  } catch {
    // ignore malformed URLs
  }
  return unique(variants);
}

function publisherSpecificPdfVariants(url: string): string[] {
  const variants: string[] = [];
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    if (/nature\.com$/.test(host)) {
      variants.push(
        new URL(pathname.replace(/$/, ".pdf"), parsed.origin).toString(),
      );
      variants.push(new URL(`${pathname}.pdf`, parsed.origin).toString());
    }

    if (/cell\.com$/.test(host) || /sciencedirect\.com$/.test(host)) {
      variants.push(
        new URL(
          pathname.replace(/\/fulltext$/i, "/pdf"),
          parsed.origin,
        ).toString(),
      );
      variants.push(
        new URL(
          pathname.replace(/\/fulltext$/i, "/pdf?download=true"),
          parsed.origin,
        ).toString(),
      );
      variants.push(
        new URL(
          pathname.replace(/\/article\//i, "/article/am/pii/"),
          parsed.origin,
        ).toString(),
      );
    }

    if (/wiley\.com$/.test(host) || /onlinelibrary\.wiley\.com$/.test(host)) {
      variants.push(
        new URL(pathname.replace(/\/full$/i, "/pdf"), parsed.origin).toString(),
      );
      variants.push(
        new URL(
          pathname.replace(/\/full$/i, "/pdfdirect"),
          parsed.origin,
        ).toString(),
      );
      variants.push(
        new URL(
          pathname.replace(/\/doi\//i, "/doi/pdf/"),
          parsed.origin,
        ).toString(),
      );
      variants.push(
        new URL(
          pathname.replace(/\/doi\//i, "/doi/epdf/"),
          parsed.origin,
        ).toString(),
      );
    }

    if (/tandfonline\.com$/.test(host)) {
      variants.push(
        new URL(pathname.replace(/\/full$/i, "/pdf"), parsed.origin).toString(),
      );
      variants.push(
        new URL(
          pathname.replace(/\/full$/i, "/pdf?download=true"),
          parsed.origin,
        ).toString(),
      );
    }
  } catch {
    // ignore malformed URLs
  }
  return unique(variants);
}

async function headOrGet(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal,
      headers: { "user-agent": USER_AGENT, accept: "application/pdf,*/*" },
      redirect: "follow",
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (
      response.ok &&
      (contentType.includes("pdf") || url.toLowerCase().includes(".pdf"))
    )
      return true;
  } catch {
    // fall through
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      signal,
      headers: { "user-agent": USER_AGENT, accept: "application/pdf,*/*" },
      redirect: "follow",
    });
    const contentType = response.headers.get("content-type") ?? "";
    return (
      response.ok &&
      (contentType.includes("pdf") || url.toLowerCase().includes(".pdf"))
    );
  } catch {
    return false;
  }
}

async function resolvePublisherPdfFromPage(
  pageUrl: string,
  html: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const directCandidates = extractPdfCandidates(html, pageUrl);
  for (const candidate of directCandidates.flatMap((value) => [
    ...candidatePdfVariants(value),
    ...publisherSpecificPdfVariants(value),
  ])) {
    if (await headOrGet(candidate, signal)) return candidate;
  }

  for (const candidate of [
    ...candidatePdfVariants(pageUrl),
    ...publisherSpecificPdfVariants(pageUrl),
  ]) {
    if (await headOrGet(candidate, signal)) return candidate;
  }

  for (const landingPage of extractOpenAccessLinks(html, pageUrl)) {
    for (const candidate of [
      ...candidatePdfVariants(landingPage),
      ...publisherSpecificPdfVariants(landingPage),
    ]) {
      if (await headOrGet(candidate, signal)) return candidate;
    }
    try {
      const nestedHtml = await fetchText(landingPage, signal, {
        accept: "text/html,application/xhtml+xml,*/*",
      });
      const nestedCandidates = extractPdfCandidates(nestedHtml, landingPage);
      for (const candidate of nestedCandidates.flatMap((value) => [
        ...candidatePdfVariants(value),
        ...publisherSpecificPdfVariants(value),
      ])) {
        if (await headOrGet(candidate, signal)) return candidate;
      }
    } catch {
      // ignore nested landing page failures
    }
  }

  return undefined;
}

async function tryPubmedCentral(
  pmid: string,
  signal?: AbortSignal,
): Promise<FullTextRouteResult> {
  const url = new URL(
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi",
  );
  url.searchParams.set("dbfrom", "pubmed");
  url.searchParams.set("db", "pmc");
  url.searchParams.set("id", pmid);
  addNcbiApiKeyParam(url);
  const xml = await fetchText(url.toString(), signal);
  const linkSet =
    /<LinkSetDb>[\s\S]*?<LinkName>pubmed_pmc<\/LinkName>[\s\S]*?<Id>(\d+)<\/Id>[\s\S]*?<\/LinkSetDb>/i.exec(
      xml,
    );
  if (!linkSet?.[1]) {
    return {
      source: "not_found",
      access_note: "No PMC full text linked from PubMed",
      is_preprint: false,
    };
  }
  const pmcId = `PMC${linkSet[1]}`;
  const articleUrl = `https://pmc.ncbi.nlm.nih.gov/articles/${pmcId}/`;
  const articleHtml = await fetchText(articleUrl, signal);
  const pdfMatch = articleHtml.match(
    /href=["']([^"']+\.pdf(?:\?pdf=render)?)["']/i,
  );
  const pdfUrl = pdfMatch?.[1]
    ? new URL(pdfMatch[1], articleUrl).toString()
    : `https://pmc.ncbi.nlm.nih.gov/articles/${pmcId}/pdf`;
  return {
    source: "pmc",
    pdf_url: pdfUrl,
    access_note: `Open access via PubMed Central (${pmcId})`,
    is_preprint: false,
  };
}

async function tryPublisherOpenAccess(
  doi: string,
  signal?: AbortSignal,
): Promise<FullTextRouteResult> {
  const doiUrl = `https://doi.org/${encodeURIComponent(doi)}`;
  const response = await fetch(doiUrl, {
    method: "GET",
    signal,
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    return {
      source: "not_found",
      access_note: `DOI landing page unavailable (${response.status})`,
      is_preprint: false,
    };
  }
  const html = await response.text();
  const finalUrl = response.url || doiUrl;
  const pdfUrl = await resolvePublisherPdfFromPage(finalUrl, html, signal);
  if (pdfUrl) {
    return {
      source: "publisher_oa",
      pdf_url: pdfUrl,
      access_note:
        "PDF found on publisher/open-access landing page or linked OA page",
      is_preprint: false,
    };
  }
  return {
    source: "not_found",
    access_note: "No direct PDF found on publisher/open-access landing page",
    is_preprint: false,
  };
}

async function trySciHub(
  doi: string,
  signal?: AbortSignal,
): Promise<FullTextRouteResult> {
  for (const mirror of SCIHUB_MIRRORS) {
    try {
      const pageUrl = `${mirror}/${encodeURIComponent(doi)}`;
      const html = await fetchText(pageUrl, signal, {
        accept: "text/html,*/*",
      });
      const candidates = extractPdfCandidates(html, pageUrl);
      for (const candidate of candidates) {
        if (await headOrGet(candidate, signal)) {
          return {
            source: "scihub",
            pdf_url: candidate,
            access_note: `PDF resolved through Sci-Hub mirror ${mirror}`,
            is_preprint: false,
          };
        }
      }
    } catch {
      // try next mirror
    }
  }
  return {
    source: "not_found",
    access_note: "Sci-Hub did not yield a PDF",
    is_preprint: false,
  };
}

function hasResolvedPdf(route: FullTextRouteResult): route is FullTextRouteResult & { pdf_url: string } {
  return route.source !== "not_found" && Boolean(route.pdf_url);
}

async function buildResolvedPdfResult(
  route: FullTextRouteResult & { pdf_url: string },
  outputDir: string | undefined,
  preferredId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { ...route };
  if (outputDir) {
    result.pdf_path = await savePdf(route.pdf_url, outputDir, preferredId, signal);
  }
  return result;
}

export function createFetchFulltextTool() {
  return {
    name: "fetch_fulltext",
    label: "Fetch Full Text",
    description:
      "Retrieve a paper PDF using PMC, publisher OA, then Sci-Hub fallback.",
    parameters: FETCH_FULLTEXT_PARAMS,
    async execute(
      _toolCallId: string,
      params: FetchFulltextParams,
      signal?: AbortSignal,
      onUpdate?: TextToolUpdate,
    ) {
      if (!params.pmid && !params.doi) {
        return errorResult("Provide at least one of `pmid` or `doi`.");
      }
      let pmid = params.pmid?.trim() || undefined;
      let doi = normalizeDoi(params.doi);
      if (!doi && pmid) {
        emitProgress(onUpdate, `Resolving DOI from PubMed for PMID ${pmid}...`);
        const identifiers = await lookupPubmedIdentifiers(pmid, signal);
        doi = identifiers.doi;
      }

      const attempts: FullTextRouteResult[] = [];

      if (pmid) {
        emitProgress(onUpdate, `Checking PubMed Central for PMID ${pmid}...`);
        const pmc = await tryPubmedCentral(pmid, signal);
        attempts.push(pmc);
        if (hasResolvedPdf(pmc)) {
          const result = await buildResolvedPdfResult(
            pmc,
            params.output_dir,
            pmid ?? doi ?? "paper",
            signal,
          );
          return textResult(JSON.stringify(result, null, 2), result);
        }
      }

      if (doi) {
        emitProgress(
          onUpdate,
          `Checking publisher open-access routes for DOI ${doi}...`,
        );
        const publisher = await tryPublisherOpenAccess(doi, signal);
        attempts.push(publisher);
        if (hasResolvedPdf(publisher)) {
          const result = await buildResolvedPdfResult(
            publisher,
            params.output_dir,
            doi,
            signal,
          );
          return textResult(JSON.stringify(result, null, 2), result);
        }

        emitProgress(
          onUpdate,
          `Checking Semantic Scholar open-access PDF metadata for DOI ${doi}...`,
        );
        let preprint: FullTextRouteResult;
        try {
          preprint = await trySemanticScholarOpenAccess(doi, signal);
        } catch (err) {
          preprint = {
            source: "not_found",
            access_note: `Semantic Scholar lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        attempts.push(preprint);
        if (hasResolvedPdf(preprint)) {
          const result = await buildResolvedPdfResult(
            preprint,
            params.output_dir,
            doi,
            signal,
          );
          return textResult(JSON.stringify(result, null, 2), result);
        }

        emitProgress(onUpdate, `Trying Sci-Hub fallback for DOI ${doi}...`);
        const scihub = await trySciHub(doi, signal);
        attempts.push(scihub);
        if (hasResolvedPdf(scihub)) {
          const result = await buildResolvedPdfResult(
            scihub,
            params.output_dir,
            doi,
            signal,
          );
          return textResult(JSON.stringify(result, null, 2), result);
        }
      }

      const result = {
        source: "not_found",
        access_note:
          "No full-text PDF found via PMC, publisher OA, Semantic Scholar OA, or Sci-Hub",
        attempts,
      };
      return textResult(JSON.stringify(result, null, 2), result);
    },
  };
}

export function registerFetchFulltextTool(pi: ExtensionAPI): void {
  pi.registerTool(createFetchFulltextTool());
}
