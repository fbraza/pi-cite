import assert from "node:assert/strict";
import test from "node:test";

import literatureToolsExtension from "../src/index.ts";
import { createLiteratureSearchTool } from "../src/literature-search.ts";
import { createPubmedSearchTool } from "../src/pubmed.ts";
import {
	compactPaperForDisplay,
	formatFoundLine,
	formatPaperPreviewLine,
	paperIdentifier,
	sourceLabel,
	truncateText,
} from "../src/rendering.ts";
import { createZoteroSearchTool } from "../src/zotero.ts";
import {
	buildZoteroOwnershipIndex,
	markPapersWithZoteroOwnership,
	zoteroItemToPaperRecord,
} from "../src/zotero.ts";
import { dedupeKeys, doiToUrl, normalizePmcid, pmcidToUrl } from "../src/shared.ts";
import type { PaperRecord } from "../src/types.ts";

const originalFetch = globalThis.fetch;
const originalNcbiApiKey = process.env.NCBI_API_KEY;
const originalZoteroApiKey = process.env.ZOTERO_API_KEY;
const originalZoteroUserId = process.env.ZOTERO_USER_ID;

function pubmedXml({
	pmid = "12345",
	title = "Fallback paper",
	abstract = "Fallback abstract.",
	journal = "Fallback Journal",
	year = "2024",
	doi,
}: {
	pmid?: string;
	title?: string;
	abstract?: string;
	journal?: string;
	year?: string;
	doi?: string;
} = {}) {
	return `<PubmedArticleSet>
		<PubmedArticle>
			<MedlineCitation>
				<PMID>${pmid}</PMID>
				<Article>
					<ArticleTitle>${title}</ArticleTitle>
					<Abstract><AbstractText>${abstract}</AbstractText></Abstract>
					<Journal><Title>${journal}</Title><JournalIssue><PubDate><Year>${year}</Year></PubDate></JournalIssue></Journal>
					${doi ? `<ELocationID EIdType="doi">${doi}</ELocationID>` : ""}
				</Article>
			</MedlineCitation>
		</PubmedArticle>
	</PubmedArticleSet>`;
}

function zoteroItemFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		key: "ZOTKEY1",
		version: 1,
		library: { type: "user", id: 475425 },
		meta: { creatorSummary: "Smith", parsedDate: "2023-06-01", numChildren: 1 },
		data: {
			key: "ZOTKEY1",
			itemType: "journalArticle",
			title: "Owned paper",
			abstractNote: "Owned abstract.",
			creators: [{ creatorType: "author", firstName: "Jane", lastName: "Smith" }],
			publicationTitle: "Owned Journal",
			date: "2023-06-01",
			DOI: "10.1000/example",
			url: "https://doi.org/10.1000/example",
			extra: "PMID: 111\nPMCID: PMC555",
			tags: [],
		},
		...overrides,
	};
}

test("literature extension registers all expected tools", () => {
	const tools: Array<{ name: string }> = [];
	const fakePi = {
		registerTool(tool: { name: string }) {
			tools.push(tool);
		},
	} as any;

	literatureToolsExtension(fakePi);

	assert.deepEqual(
		tools.map((tool) => tool.name),
		["literature_search", "pubmed_search", "zotero_search"],
	);
});

test("pubmed_search emits pi-compliant progress updates, returns text content, and uses NCBI_API_KEY", async () => {
	const previousNcbiApiKey = process.env.NCBI_API_KEY;
	process.env.NCBI_API_KEY = "test-ncbi-key";
	const calls: string[] = [];
	globalThis.fetch = async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		return new Response(
			JSON.stringify({
				esearchresult: { idlist: ["12345"], count: "1" },
			}),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	};

	const tool = createPubmedSearchTool();
	const updates: any[] = [];
	const result = await tool.execute(
		"tool-call",
		{ query: "trained immunity", max_results: 1, fetch_abstracts: false },
		undefined,
		(update: any) => updates.push(update),
	);

	assert.equal(new URL(calls[0]!).searchParams.get("api_key"), "test-ncbi-key");
	assert.equal(updates.length, 1);
	assert.deepEqual(updates[0].content, [{ type: "text", text: "Searching PubMed for: trained immunity" }]);
	assert.deepEqual(updates[0].details, {});
	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].type, "text");
	assert.deepEqual(JSON.parse(result.content[0].text), [{ pmid: "12345", title: "PubMed record", source: "pubmed" }]);
	assert.deepEqual(result.details, {
		count: 1,
		papers: [{ pmid: "12345", title: "PubMed record", source: "pubmed" }],
		query: "trained immunity",
	});

	if (previousNcbiApiKey === undefined) {
		delete process.env.NCBI_API_KEY;
	} else {
		process.env.NCBI_API_KEY = previousNcbiApiKey;
	}
	globalThis.fetch = originalFetch;
});

test("literature_search searches PubMed, streams progress, and reports only the pubmed provider", async () => {
	const previousZoteroKey = process.env.ZOTERO_API_KEY;
	delete process.env.ZOTERO_API_KEY;
	const calls: string[] = [];
	globalThis.fetch = async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		if (url.includes("esearch.fcgi")) {
			return new Response(
				JSON.stringify({
					esearchresult: { idlist: ["12345"], count: "1" },
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}

		if (url.includes("efetch.fcgi")) {
			return new Response(
				pubmedXml(),
				{
					status: 200,
					headers: { "content-type": "application/xml" },
				},
			);
		}

		throw new Error(`Unexpected fetch: ${url}`);
	};

	const tool = createLiteratureSearchTool();
	const updates: any[] = [];
	const result = await tool.execute(
		"tool-call",
		{ pubmed_query: "trained immunity[tiab]", max_results: 1 },
		undefined,
		(update: any) => updates.push(update),
	);

	assert.ok(calls.some((url) => url.includes("esearch.fcgi")));
	assert.ok(calls.some((url) => url.includes("efetch.fcgi")));
	assert.ok(calls.every((url) => url.includes("eutils.ncbi.nlm.nih.gov")));
	assert.equal(updates[0].content[0].text, "Searching PubMed...");
	assert.ok(updates.some((update) => update.content[0].text === "Found 1 PubMed paper."));
	assert.equal(result.isError, undefined);
	assert.deepEqual(JSON.parse(result.content[0].text), [
		{
			pmid: "12345",
			title: "Fallback paper",
			abstract: "Fallback abstract.",
			authors: [],
			journal: "Fallback Journal",
			year: 2024,
			publication_types: [],
			mesh_terms: [],
			source: "pubmed",
			sources: ["pubmed"],
		},
	]);
	assert.deepEqual(result.details.providers.pubmed, {
		searched: true,
		count: 1,
		query: "trained immunity[tiab]",
		total: 1,
	});
	assert.deepEqual(Object.keys(result.details.providers), ["pubmed"]);
	const partialRendered = tool
		.renderResult(updates.at(-1), { expanded: false, isPartial: true }, undefined)
		.render(120)
		.join("\n");
	assert.equal(partialRendered.trimEnd(), "● literature_search found 1 PubMed paper");
	const rendered = tool
		.renderResult(result, { expanded: true, isPartial: false }, undefined)
		.render(120)
		.join("\n");
	assert.match(rendered, /✓ literature_search 1 PubMed paper/);
	assert.match(rendered, /query: trained immunity\[tiab\]/);
	assert.match(rendered, /1\. Unknown 2024 — Fallback paper/);
	assert.doesNotMatch(rendered, /Fallback abstract/);
	assert.doesNotMatch(rendered, /✓ found:/);
	assert.doesNotMatch(rendered, /deduplicating/i);
	assert.doesNotMatch(rendered, /merged/i);
	assert.doesNotMatch(rendered, /\(PM\)/);
	if (previousZoteroKey === undefined) {
		delete process.env.ZOTERO_API_KEY;
	} else {
		process.env.ZOTERO_API_KEY = previousZoteroKey;
	}
	globalThis.fetch = originalFetch;
});

test("shared helpers normalize PMCID/DOI and build dedupe keys", () => {
	assert.equal(normalizePmcid("pmcid: PMC555"), "PMC555");
	assert.equal(normalizePmcid("PMC555"), "PMC555");
	assert.equal(normalizePmcid("555"), "PMC555");
	assert.equal(normalizePmcid(undefined), undefined);
	assert.equal(doiToUrl("10.1000/example"), "https://doi.org/10.1000/example");
	assert.equal(doiToUrl("https://doi.org/10.1000/example"), "https://doi.org/10.1000/example");
	assert.equal(doiToUrl(undefined), undefined);
	assert.equal(pmcidToUrl("PMC555"), "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC555/");
	assert.equal(pmcidToUrl(undefined), undefined);
	const keys = dedupeKeys({
		title: "Owned paper",
		doi: "10.1000/example",
		pmid: "111",
		pmcid: "PMC555",
		year: 2023,
		source: "zotero",
	});
	assert.deepEqual(keys.sort(), [
		"doi:10.1000/example",
		"pmcid:PMC555",
		"pmid:111",
		"title-year:owned paper:2023",
	]);
});

test("zoteroItemToPaperRecord extracts DOI, PMID, and PMCID from item + extra", () => {
	const paper = zoteroItemToPaperRecord(zoteroItemFixture() as any);
	assert.deepEqual(paper, {
		title: "Owned paper",
		abstract: "Owned abstract.",
		doi: "10.1000/example",
		pmid: "111",
		pmcid: "PMC555",
		authors: ["Jane Smith"],
		journal: "Owned Journal",
		year: 2023,
		source: "zotero",
		in_zotero: true,
		zotero_key: "ZOTKEY1",
	});
});

test("buildZoteroOwnershipIndex indexes DOI, PMID, PMCID, and title-year", () => {
	const index = buildZoteroOwnershipIndex([zoteroItemFixture() as any]);
	assert.equal(index.get("doi:10.1000/example"), "ZOTKEY1");
	assert.equal(index.get("pmid:111"), "ZOTKEY1");
	assert.equal(index.get("pmcid:PMC555"), "ZOTKEY1");
	assert.equal(index.get("title-year:owned paper:2023"), "ZOTKEY1");
	assert.equal(index.get("doi:10.9999/nope"), undefined);
});

test("markPapersWithZoteroOwnership flags owned candidates and marks the rest false", () => {
	const index = buildZoteroOwnershipIndex([zoteroItemFixture() as any]);
	const candidates: PaperRecord[] = [
		{ title: "Owned paper", doi: "10.1000/example", year: 2023, source: "pubmed" },
		{ title: "New paper", doi: "10.9999/nope", year: 2024, source: "pubmed" },
	];
	const marked = markPapersWithZoteroOwnership(candidates, index);
	assert.equal(marked[0].in_zotero, true);
	assert.equal(marked[0].zotero_key, "ZOTKEY1");
	assert.equal(marked[1].in_zotero, false);
	assert.equal(marked[1].zotero_key, undefined);
});

test("zotero_search validates the key and returns owned papers", async () => {
	const previousKey = process.env.ZOTERO_API_KEY;
	const previousUser = process.env.ZOTERO_USER_ID;
	process.env.ZOTERO_API_KEY = "test-zotero-key";
	process.env.ZOTERO_USER_ID = "475425";
	try {
		const calls: string[] = [];
		globalThis.fetch = async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);
			if (url.includes("/keys/current")) {
				return new Response(JSON.stringify({ userID: 475425, username: "tester" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("/items/top")) {
				return new Response(JSON.stringify([zoteroItemFixture()]), {
					status: 200,
					headers: { "content-type": "application/json", "Total-Results": "1" },
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};

		const tool = createZoteroSearchTool();
		const updates: any[] = [];
		const result = await tool.execute(
			"tool-call",
			{ query: "trained immunity", max_results: 5 },
			undefined,
			(update: any) => updates.push(update),
		);

		assert.ok(calls.some((url) => url.includes("/keys/current")));
		assert.ok(calls.some((url) => url.includes("/items/top")));
		assert.equal(result.isError, undefined);
		const papers = JSON.parse(result.content[0].text);
		assert.equal(papers.length, 1);
		assert.equal(papers[0].doi, "10.1000/example");
		assert.equal(papers[0].in_zotero, true);
		assert.equal(result.details.count, 1);
		assert.equal(result.details.total, 1);
		assert.ok(
			updates.some((u) => u.content[0].text === "Searching Zotero library for: trained immunity"),
		);
	} finally {
		process.env.ZOTERO_API_KEY = previousKey;
		process.env.ZOTERO_USER_ID = previousUser;
		globalThis.fetch = originalFetch;
	}
});

test("literature_search marks PubMed candidates already in the Zotero library", async () => {
	const previousKey = process.env.ZOTERO_API_KEY;
	const previousUser = process.env.ZOTERO_USER_ID;
	process.env.ZOTERO_API_KEY = "test-zotero-key";
	process.env.ZOTERO_USER_ID = "475425";
	try {
		globalThis.fetch = async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("esearch.fcgi")) {
				return new Response(
					JSON.stringify({ esearchresult: { idlist: ["12345"], count: "1" } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("efetch.fcgi")) {
				return new Response(
					pubmedXml({ doi: "10.1000/example", title: "Owned paper", year: "2023" }),
					{ status: 200, headers: { "content-type": "application/xml" } },
				);
			}
			if (url.includes("/keys/current")) {
				return new Response(JSON.stringify({ userID: 475425, username: "tester" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("/items/top")) {
				return new Response(JSON.stringify([zoteroItemFixture()]), {
					status: 200,
					headers: { "content-type": "application/json", "Total-Results": "1" },
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};

		const tool = createLiteratureSearchTool();
		const updates: any[] = [];
		const result = await tool.execute(
			"tool-call",
			{ pubmed_query: "trained immunity[tiab]", max_results: 1 },
			undefined,
			(update: any) => updates.push(update),
		);

		const papers = JSON.parse(result.content[0].text);
		assert.equal(papers.length, 1);
		assert.equal(papers[0].doi, "10.1000/example");
		assert.equal(papers[0].in_zotero, true);
		assert.equal(papers[0].zotero_key, "ZOTKEY1");
		assert.equal(result.details.providers.zotero.searched, true);
		assert.ok(updates.some((u) => /already in your Zotero library/.test(u.content[0].text)));
	} finally {
		process.env.ZOTERO_API_KEY = previousKey;
		process.env.ZOTERO_USER_ID = previousUser;
		globalThis.fetch = originalFetch;
	}
});

test("literature rendering helpers format compact terminal paper lines", () => {
	const paper = {
		pmid: "12345",
		doi: "10.1000/example",
		title: "A very long title about trained immunity in macrophages and inflammatory disease that should be truncated",
		authors: ["Mihai Netea", "Leo Joosten", "Riksen"],
		source: "pubmed",
		sources: ["pubmed"],
	};

	assert.equal(paperIdentifier(paper), "DOI:10.1000/example");
	assert.equal(sourceLabel(paper), "PM");
	assert.equal(sourceLabel({ title: "External paper", source: "external" }), "—");
	assert.equal(truncateText("abcdef", 4), "abc…");
	const compact = compactPaperForDisplay(paper);
	assert.deepEqual(compact, {
		first_author: "Netea",
		title: paper.title,
		id: "DOI:10.1000/example",
		source: "PM",
		year: undefined,
		journal: undefined,
	});
	const line = formatFoundLine(compact);
	assert.match(line, /✓ found:/);
	assert.match(line, /Netea/);
	assert.match(line, /DOI:10\.1000\/example/);
	assert.doesNotMatch(line, /abstract/i);
	const previewLine = formatPaperPreviewLine({ ...compact, year: 2024 }, 0);
	assert.equal(
		previewLine,
		"  1. Netea 2024 — A very long title about trained immunity in macrophages and inflammatory disease that s…",
	);
	assert.doesNotMatch(previewLine, /DOI|PMID|\(PM\)/);
});

test.after(() => {
	globalThis.fetch = originalFetch;
	if (originalNcbiApiKey === undefined) {
		delete process.env.NCBI_API_KEY;
	} else {
		process.env.NCBI_API_KEY = originalNcbiApiKey;
	}
	if (originalZoteroApiKey === undefined) {
		delete process.env.ZOTERO_API_KEY;
	} else {
		process.env.ZOTERO_API_KEY = originalZoteroApiKey;
	}
	if (originalZoteroUserId === undefined) {
		delete process.env.ZOTERO_USER_ID;
	} else {
		process.env.ZOTERO_USER_ID = originalZoteroUserId;
	}
});
