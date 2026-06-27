import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { renderProviderSearchResult } from "./rendering.ts";
import { emitProgress, textResult, type TextToolUpdate } from "./tool-output.ts";
import type { PaperRecord } from "./types.ts";
import {
	USER_AGENT,
	dedupeKeys,
	formatPaperText,
	normalizeDoi,
	normalizePmcid,
	sleep,
} from "./shared.ts";

export const ZOTERO_API_BASE = "https://api.zotero.org";
export const ZOTERO_API_VERSION = "3";
export const ZOTERO_MAX_LIMIT = 100;
export const ZOTERO_DEFAULT_INDEX_CAP = 2000;

export const DEFAULT_ZOTERO_API_KEY_ENV = "ZOTERO_API_KEY";
export const DEFAULT_ZOTERO_USER_ID_ENV = "ZOTERO_USER_ID";
export const DEFAULT_ZOTERO_LIBRARY_ENV = "ZOTERO_LIBRARY";
export const DEFAULT_ZOTERO_GROUP_ID_ENV = "ZOTERO_GROUP_ID";

export const ZOTERO_SEARCH_PARAMS = Type.Object({
	query: Type.String({
		description: "Quick-search query for the Zotero library (title/creators/year, plus full text when qmode=everything).",
	}),
	max_results: Type.Optional(
		Type.Number({ description: "Maximum results to return (default 25, max 100)" }),
	),
	qmode: Type.Optional(
		Type.Union([Type.Literal("everything"), Type.Literal("titleCreatorYear")], {
			description: "Quick-search mode (default everything, which includes indexed full text).",
		}),
	),
	item_type: Type.Optional(
		Type.String({ description: "Filter by Zotero item type, e.g. journalArticle" }),
	),
	api_key: Type.Optional(
		Type.String({
			description: "Environment variable name containing a Zotero API key (defaults to ZOTERO_API_KEY when omitted).",
		}),
	),
});

export type ZoteroSearchParams = Static<typeof ZOTERO_SEARCH_PARAMS>;

// Module-level backoff window shared across all Zotero requests in a process.
let zoteroBackoffUntil = 0;

async function respectBackoff(signal?: AbortSignal): Promise<void> {
	const wait = zoteroBackoffUntil - Date.now();
	if (wait > 0) await sleep(wait, signal);
}

function updateBackoffFromResponse(response: Response): void {
	const header = response.headers.get("Backoff") ?? response.headers.get("Retry-After");
	if (!header) return;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds > 0) {
		zoteroBackoffUntil = Math.max(zoteroBackoffUntil, Date.now() + seconds * 1000);
	}
}

export type ZoteroFetchOptions = {
	apiKey: string;
	method?: string;
	body?: unknown;
	parse?: "json" | "text";
};

export async function zoteroFetch<T>(
	url: string,
	{ apiKey, method = "GET", body, parse = "json" }: ZoteroFetchOptions,
	signal?: AbortSignal,
): Promise<{ data: T; response: Response }> {
	await respectBackoff(signal);
	const headers: Record<string, string> = {
		"Zotero-API-Key": apiKey,
		"Zotero-API-Version": ZOTERO_API_VERSION,
		"user-agent": USER_AGENT,
		accept: "application/json",
	};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await fetch(url, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
		signal,
		redirect: "follow",
	});
	updateBackoffFromResponse(response);
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		const snippet = text ? `: ${text.slice(0, 200)}` : "";
		throw new Error(`Zotero API ${response.status} ${response.statusText} for ${url}${snippet}`);
	}
	const data = (parse === "json" ? await response.json() : await response.text()) as T;
	return { data, response };
}

export function getZoteroApiKey(envVarName?: string): string | undefined {
	const keyEnv = envVarName?.trim() || DEFAULT_ZOTERO_API_KEY_ENV;
	return process.env[keyEnv]?.trim() || undefined;
}

export function getZoteroLibraryType(): "user" | "group" {
	const value = process.env[DEFAULT_ZOTERO_LIBRARY_ENV]?.trim().toLowerCase();
	return value === "group" ? "group" : "user";
}

export function getZoteroGroupId(): string | undefined {
	return process.env[DEFAULT_ZOTERO_GROUP_ID_ENV]?.trim() || undefined;
}

export function getZoteroUserIdFromEnv(): string | undefined {
	return process.env[DEFAULT_ZOTERO_USER_ID_ENV]?.trim() || undefined;
}

export type ZoteroLibrary = { type: "user" | "group"; id: string };

function libraryPrefix(library: ZoteroLibrary): string {
	return library.type === "user"
		? `${ZOTERO_API_BASE}/users/${library.id}`
		: `${ZOTERO_API_BASE}/groups/${library.id}`;
}

export type ZoteroKeyInfo = {
	userID?: number;
	username?: string;
	access?: {
		user?: { library?: boolean; files?: boolean; notes?: boolean; write?: boolean };
		groups?: unknown;
	};
};

export async function verifyZoteroAccess(apiKey: string, signal?: AbortSignal): Promise<ZoteroKeyInfo> {
	const { data } = await zoteroFetch<ZoteroKeyInfo>(`${ZOTERO_API_BASE}/keys/current`, { apiKey }, signal);
	return data;
}

export async function resolveZoteroContext(
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ apiKey: string; library: ZoteroLibrary; keyInfo: ZoteroKeyInfo }> {
	const keyInfo = await verifyZoteroAccess(apiKey, signal);
	const libraryType = getZoteroLibraryType();
	if (libraryType === "group") {
		const groupId = getZoteroGroupId();
		if (!groupId) {
			throw new Error("ZOTERO_GROUP_ID is required when ZOTERO_LIBRARY=group");
		}
		return { apiKey, library: { type: "group", id: groupId }, keyInfo };
	}
	const userId = getZoteroUserIdFromEnv() ?? (keyInfo.userID ? String(keyInfo.userID) : undefined);
	if (!userId) {
		throw new Error("Could not determine Zotero user ID; set ZOTERO_USER_ID");
	}
	return { apiKey, library: { type: "user", id: userId }, keyInfo };
}

export type ZoteroCreator = {
	creatorType?: string;
	firstName?: string;
	lastName?: string;
	name?: string;
};

export type ZoteroItem = {
	key: string;
	version: number;
	library?: { type?: string; id?: number };
	meta?: { creatorSummary?: string; parsedDate?: string; numChildren?: number };
	data: {
		key: string;
		itemType: string;
		title?: string;
		abstractNote?: string;
		creators?: ZoteroCreator[];
		publicationTitle?: string;
		date?: string;
		DOI?: string;
		url?: string;
		extra?: string;
		tags?: Array<{ tag?: string } | string>;
		[k: string]: unknown;
	};
};

function parsePmidFromExtra(extra?: string): string | undefined {
	if (!extra) return undefined;
	const match = extra.match(/PMID:\s*(\d+)/i);
	return match?.[1] || undefined;
}

function parsePmcidFromExtra(extra?: string): string | undefined {
	if (!extra) return undefined;
	const match = extra.match(/PMC\s*\d+/i);
	return match ? normalizePmcid(match[0]) : undefined;
}

function yearFromDate(date?: string, parsedDate?: string): number | undefined {
	const source = parsedDate || date;
	if (!source) return undefined;
	const match = String(source).match(/\b(\d{4})\b/);
	return match ? Number(match[1]) : undefined;
}

function creatorToAuthor(creator: ZoteroCreator): string | undefined {
	if (creator.name) return creator.name.trim() || undefined;
	const first = (creator.firstName || "").trim();
	const last = (creator.lastName || "").trim();
	const name = [first, last].filter(Boolean).join(" ").trim();
	return name || undefined;
}

export function zoteroItemToPaperRecord(item: ZoteroItem): PaperRecord {
	const d = item.data;
	const doi = normalizeDoi(typeof d.DOI === "string" ? d.DOI : undefined);
	const extra = typeof d.extra === "string" ? d.extra : undefined;
	const pmid = parsePmidFromExtra(extra);
	const pmcid = parsePmcidFromExtra(extra);
	const authors = (d.creators ?? [])
		.map(creatorToAuthor)
		.filter((author): author is string => Boolean(author));
	const abstract = d.abstractNote?.trim() || undefined;
	return {
		title: d.title || "Untitled",
		abstract,
		doi,
		pmid,
		pmcid,
		authors,
		journal: d.publicationTitle || undefined,
		year: yearFromDate(d.date, item.meta?.parsedDate),
		source: "zotero",
		in_zotero: true,
		zotero_key: item.key,
	};
}

function parseNextLink(linkHeader: string | null): string | undefined {
	if (!linkHeader) return undefined;
	const match = linkHeader.match(/<([^>]+)>;\s*rel=["']next["']/i);
	return match?.[1];
}

export type ZoteroTopItemsResult = {
	items: ZoteroItem[];
	total: number;
	next?: string;
};

export async function fetchZoteroTopItems(
	{
		apiKey,
		library,
		limit,
		start,
		sort,
		direction,
		signal,
	}: {
		apiKey: string;
		library: ZoteroLibrary;
		limit?: number;
		start?: number;
		sort?: string;
		direction?: string;
		signal?: AbortSignal;
	},
): Promise<ZoteroTopItemsResult> {
	const url = new URL(`${libraryPrefix(library)}/items/top`);
	url.searchParams.set("limit", String(Math.min(ZOTERO_MAX_LIMIT, Math.max(1, limit ?? ZOTERO_MAX_LIMIT))));
	if (start) url.searchParams.set("start", String(start));
	if (sort) url.searchParams.set("sort", sort);
	if (direction) url.searchParams.set("direction", direction);
	const { data, response } = await zoteroFetch<ZoteroItem[]>(url.toString(), { apiKey }, signal);
	const total = Number(response.headers.get("Total-Results") ?? data.length);
	const next = parseNextLink(response.headers.get("Link"));
	return { items: data, total, next };
}

export type ZoteroOwnershipIndex = Map<string, string>;

export function buildZoteroOwnershipIndex(items: ZoteroItem[]): ZoteroOwnershipIndex {
	const index: ZoteroOwnershipIndex = new Map();
	for (const item of items) {
		const paper = zoteroItemToPaperRecord(item);
		if (!paper.zotero_key) continue;
		for (const key of dedupeKeys(paper)) {
			if (!index.has(key)) index.set(key, paper.zotero_key);
		}
	}
	return index;
}

/**
 * Fetch the user's top-level library items (excluding child attachments/notes)
 * and build a dedupe-key -> Zotero item key index used to flag PubMed papers
 * the user already owns. The library JSON is consumed here in code and never
 * reaches the agent's context; only the resulting in_zotero flag does.
 */
export async function fetchAllZoteroTopItems({
	apiKey,
	library,
	cap,
	signal,
	onProgress,
}: {
	apiKey: string;
	library: ZoteroLibrary;
	cap?: number;
	signal?: AbortSignal;
	onProgress?: (info: { items: number; total?: number }) => void;
}): Promise<{ items: ZoteroItem[]; total?: number }> {
	const max = Math.max(1, cap ?? ZOTERO_DEFAULT_INDEX_CAP);
	const all: ZoteroItem[] = [];
	let total: number | undefined;
	let next: string | undefined;

	const first = await fetchZoteroTopItems({
		apiKey,
		library,
		limit: ZOTERO_MAX_LIMIT,
		start: 0,
		sort: "dateModified",
		direction: "desc",
		signal,
	});
	total = first.total;
	all.push(...first.items);
	next = first.next;
	onProgress?.({ items: all.length, total });

	while (next && all.length < max) {
		const { data, response } = await zoteroFetch<ZoteroItem[]>(next, { apiKey }, signal);
		all.push(...data);
		next = parseNextLink(response.headers.get("Link"));
		onProgress?.({ items: all.length, total });
		if (data.length === 0) break;
	}

	return { items: all.slice(0, max), total };
}

export type ZoteroOwnershipResult = {
	index: ZoteroOwnershipIndex;
	library: ZoteroLibrary;
	libraryItems: number;
	total?: number;
};

export async function prepareZoteroOwnership({
	apiKey,
	cap,
	signal,
	onProgress,
}: {
	apiKey: string;
	cap?: number;
	signal?: AbortSignal;
	onProgress?: (info: { items: number; total?: number }) => void;
}): Promise<ZoteroOwnershipResult> {
	const ctx = await resolveZoteroContext(apiKey, signal);
	const { items, total } = await fetchAllZoteroTopItems({
		apiKey,
		library: ctx.library,
		cap,
		signal,
		onProgress,
	});
	const index = buildZoteroOwnershipIndex(items);
	return { index, library: ctx.library, libraryItems: items.length, total };
}

/**
 * Mark each candidate paper with in_zotero (and zotero_key) when it matches an
 * entry in the ownership index. Papers that do not match are explicitly
 * flagged in_zotero: false so the caller can distinguish "checked, not owned"
 * from "not checked" (undefined).
 */
export function markPapersWithZoteroOwnership(
	papers: PaperRecord[],
	index: ZoteroOwnershipIndex,
): PaperRecord[] {
	return papers.map((paper) => {
		for (const key of dedupeKeys(paper)) {
			const zoteroKey = index.get(key);
			if (zoteroKey) return { ...paper, in_zotero: true, zotero_key: zoteroKey };
		}
		return { ...paper, in_zotero: false };
	});
}

export type ZoteroSearchResult = {
	count: number;
	papers: PaperRecord[];
	total?: number;
};

export async function searchZotero(
	params: ZoteroSearchParams,
	signal?: AbortSignal,
	onUpdate?: TextToolUpdate,
): Promise<ZoteroSearchResult> {
	const apiKey = getZoteroApiKey(params.api_key);
	if (!apiKey) {
		throw new Error("ZOTERO_API_KEY is not set; cannot search the Zotero library");
	}
	const ctx = await resolveZoteroContext(apiKey, signal);
	const maxResults = Math.min(
		ZOTERO_MAX_LIMIT,
		Math.max(1, Math.floor(params.max_results ?? 25)),
	);
	const url = new URL(`${libraryPrefix(ctx.library)}/items/top`);
	url.searchParams.set("q", params.query);
	url.searchParams.set("qmode", params.qmode ?? "everything");
	url.searchParams.set("limit", String(maxResults));
	if (params.item_type) url.searchParams.set("itemType", params.item_type);
	url.searchParams.set("sort", "dateModified");
	url.searchParams.set("direction", "desc");
	emitProgress(onUpdate, `Searching Zotero library for: ${params.query}`);
	const { data, response } = await zoteroFetch<ZoteroItem[]>(url.toString(), { apiKey }, signal);
	const papers = data.map(zoteroItemToPaperRecord);
	const total = Number(response.headers.get("Total-Results") ?? papers.length);
	return { count: papers.length, papers, total };
}

export function createZoteroSearchTool() {
	return {
		name: "zotero_search",
		label: "Zotero Search",
		description:
			"Search your Zotero library by keyword (title/creators/year, and indexed full text when qmode=everything). Returns metadata and abstracts of papers you already own.",
		parameters: ZOTERO_SEARCH_PARAMS,
		async execute(
			_toolCallId: string,
			params: ZoteroSearchParams,
			signal?: AbortSignal,
			onUpdate?: TextToolUpdate,
		) {
			const result = await searchZotero(params, signal, onUpdate);
			return textResult(formatPaperText(result.papers), result);
		},
		renderResult(
			result: Parameters<typeof renderProviderSearchResult>[1],
			options: Parameters<typeof renderProviderSearchResult>[2],
			theme: Parameters<typeof renderProviderSearchResult>[3],
		) {
			return renderProviderSearchResult("zotero", result, options, theme);
		},
	};
}

export function registerZoteroSearchTool(pi: ExtensionAPI): void {
	pi.registerTool(createZoteroSearchTool());
}
