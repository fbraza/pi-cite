import type { PaperRecord } from "./types.ts";

export const USER_AGENT = "research-skills-literature-tools/0.1 (+https://github.com/fbraza/research-skills)";

export function unique<T>(items: T[]): T[] {
	return [...new Set(items.filter((item) => item !== undefined && item !== null && item !== ""))];
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		if (!signal) return;
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Request aborted"));
		};
		if (signal.aborted) onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function htmlDecode(text: string): string {
	return text
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function normalizeDoi(raw?: string): string | undefined {
	if (!raw) return undefined;
	return raw
		.trim()
		.replace(/^doi:\s*/i, "")
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.trim() || undefined;
}

export function normalizePmcid(raw?: string): string | undefined {
	if (!raw) return undefined;
	const cleaned = raw.trim().replace(/^pmcid?:\s*/i, "").toUpperCase();
	if (!cleaned) return undefined;
	const digits = cleaned.replace(/^PMC/, "").replace(/\D/g, "");
	if (!digits) return undefined;
	return `PMC${digits}`;
}

export function doiToUrl(doi?: string): string | undefined {
	const normalized = normalizeDoi(doi);
	return normalized ? `https://doi.org/${normalized}` : undefined;
}

export function pmcidToUrl(pmcid?: string): string | undefined {
	const normalized = normalizePmcid(pmcid);
	return normalized ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${normalized}/` : undefined;
}

export function xmlDecode(text: string): string {
	return htmlDecode(text);
}

export function pickAll(regex: RegExp, text: string): string[] {
	const matches: string[] = [];
	for (const match of text.matchAll(regex)) {
		if (match[1]) matches.push(xmlDecode(match[1]));
	}
	return matches;
}

export function pickOne(regex: RegExp, text: string): string | undefined {
	const match = regex.exec(text);
	return match?.[1] ? xmlDecode(match[1]) : undefined;
}

export async function fetchText(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<string> {
	const response = await fetch(url, {
		headers: {
			"user-agent": USER_AGENT,
			accept: "application/json, text/xml, application/xml, text/html;q=0.9, */*;q=0.8",
			...headers,
		},
		signal,
		redirect: "follow",
	});
	if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
	return await response.text();
}

export async function fetchJson<T>(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<T> {
	const text = await fetchText(url, signal, headers);
	return JSON.parse(text) as T;
}

export function formatPaperText(papers: PaperRecord[]): string {
	return JSON.stringify(papers, null, 2);
}

export function normalizedTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Build the set of identity keys used to deduplicate papers across providers
 * and to match PubMed candidates against a Zotero ownership index. Keys cover
 * DOI, PMID, PMCID, and title-year so a paper is matched even when one source
 * is missing an identifier.
 */
export function dedupeKeys(paper: PaperRecord): string[] {
	const doi = normalizeDoi(paper.doi)?.toLowerCase();
	const pmcid = normalizePmcid(paper.pmcid)?.toUpperCase();
	const keys: (string | undefined)[] = [
		doi ? `doi:${doi}` : undefined,
		paper.pmid ? `pmid:${paper.pmid}` : undefined,
		pmcid ? `pmcid:${pmcid}` : undefined,
	];
	const title = normalizedTitle(paper.title);
	if (title && paper.year) keys.push(`title-year:${title}:${paper.year}`);
	return unique(keys);
}
