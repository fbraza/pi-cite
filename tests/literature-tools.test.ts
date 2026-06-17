import assert from "node:assert/strict";
import test from "node:test";

import literatureToolsExtension from "../src/index.ts";
import { createFetchFulltextTool } from "../src/fulltext.ts";
import { createLiteratureSearchTool } from "../src/literature-search.ts";
import { createPubmedSearchTool } from "../src/pubmed.ts";
import {
	compactPaperForDisplay,
	formatFoundLine,
	paperIdentifier,
	sourceLabel,
	truncateText,
} from "../src/rendering.ts";

const originalFetch = globalThis.fetch;
const originalSemanticScholarApiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
const originalNcbiApiKey = process.env.NCBI_API_KEY;

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
		["literature_search", "pubmed_search", "semantic_scholar_search", "fetch_fulltext"],
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

test("fetch_fulltext returns a structured error instead of throwing when identifiers are missing", async () => {
	const tool = createFetchFulltextTool();
	const result = await tool.execute("tool-call", {}, undefined, undefined);

	assert.equal(result.isError, true);
	assert.deepEqual(result.content, [{ type: "text", text: "Provide at least one of `pmid` or `doi`." }]);
	assert.deepEqual(result.details, {});
});

test("fetch_fulltext uses NCBI_API_KEY for PubMed-backed lookups", async () => {
	const previousNcbiApiKey = process.env.NCBI_API_KEY;
	process.env.NCBI_API_KEY = "test-ncbi-key";
	const calls: string[] = [];
	globalThis.fetch = async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		if (url.includes("efetch.fcgi")) {
			return new Response(pubmedXml({ doi: "10.1000/example" }), {
				status: 200,
				headers: { "content-type": "application/xml" },
			});
		}
		if (url.includes("elink.fcgi")) {
			return new Response(
				`<LinkSet><LinkSetDb><LinkName>pubmed_pmc</LinkName><Link><Id>98765</Id></Link></LinkSetDb></LinkSet>`,
				{
					status: 200,
					headers: { "content-type": "application/xml" },
				},
			);
		}
		if (url.includes("pmc.ncbi.nlm.nih.gov/articles/PMC98765/")) {
			return new Response(`<html><a href="article.pdf">PDF</a></html>`, {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		}
		throw new Error(`Unexpected fetch: ${url}`);
	};

	const tool = createFetchFulltextTool();
	const result = await tool.execute("tool-call", { pmid: "12345" }, undefined, undefined);

	const pubmedCalls = calls.filter((url) => url.includes("eutils.ncbi.nlm.nih.gov"));
	assert.equal(pubmedCalls.length, 2);
	assert.ok(pubmedCalls.every((url) => new URL(url).searchParams.get("api_key") === "test-ncbi-key"));
	assert.equal(result.details.source, "pmc");
	assert.equal(result.details.pdf_url, "https://pmc.ncbi.nlm.nih.gov/articles/PMC98765/article.pdf");

	if (previousNcbiApiKey === undefined) {
		delete process.env.NCBI_API_KEY;
	} else {
		process.env.NCBI_API_KEY = previousNcbiApiKey;
	}
	globalThis.fetch = originalFetch;
});

test("literature_search always searches PubMed and skips Semantic Scholar when the API key is missing", async () => {
	delete process.env.SEMANTIC_SCHOLAR_API_KEY;
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
		{ pubmed_query: "trained immunity[tiab]", semantic_scholar_query: "trained immunity", max_results: 1 },
		undefined,
		(update: any) => updates.push(update),
	);

	assert.ok(calls.some((url) => url.includes("esearch.fcgi")));
	assert.ok(calls.some((url) => url.includes("efetch.fcgi")));
	assert.ok(calls.every((url) => !url.includes("semanticscholar.org")));
	assert.equal(updates[0].content[0].text, "Starting literature search...");
	assert.ok(updates.some((update) => update.content[0].text === "PubMed q1 found 1 candidate papers."));
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
	assert.deepEqual(result.details.providers.semantic_scholar, {
		searched: false,
		reason: "SEMANTIC_SCHOLAR_API_KEY not configured",
	});
	const rendered = tool
		.renderResult(result, { expanded: true, isPartial: false }, undefined)
		.render(120)
		.join("\n");
	assert.match(rendered, /✓ found:/);
	assert.doesNotMatch(rendered, /Fallback abstract/);
});

test("literature rendering helpers format compact terminal paper lines", () => {
	const paper = {
		pmid: "12345",
		doi: "10.1000/example",
		title: "A very long title about trained immunity in macrophages and inflammatory disease that should be truncated",
		authors: ["Mihai Netea", "Leo Joosten", "Riksen"],
		source: "pubmed;semantic_scholar",
		sources: ["pubmed", "semantic_scholar"],
	};

	assert.equal(paperIdentifier(paper), "DOI:10.1000/example");
	assert.equal(sourceLabel(paper), "PM+S2");
	assert.equal(truncateText("abcdef", 4), "abc…");
	const compact = compactPaperForDisplay(paper);
	assert.deepEqual(compact, {
		first_author: "Netea",
		title: paper.title,
		id: "DOI:10.1000/example",
		source: "PM+S2",
		year: undefined,
		journal: undefined,
		citation_count: undefined,
	});
	const line = formatFoundLine(compact);
	assert.match(line, /✓ found:/);
	assert.match(line, /Netea/);
	assert.match(line, /DOI:10\.1000\/example/);
	assert.doesNotMatch(line, /abstract/i);
});

test("literature_search uses Semantic Scholar as supplementary search when the API key exists and deduplicates results", async () => {
	process.env.SEMANTIC_SCHOLAR_API_KEY = "test-s2-key";
	const calls: Array<{ url: string; headers?: HeadersInit }> = [];
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, headers: init?.headers });
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
				pubmedXml({ doi: "10.1000/example" }),
				{
					status: 200,
					headers: { "content-type": "application/xml" },
				},
			);
		}

		if (url.includes("semanticscholar.org")) {
			return new Response(
				JSON.stringify({
					data: [
						{
							paperId: "s2-1",
							title: "Fallback paper",
							abstract: "Semantic Scholar abstract.",
							year: 2024,
							citationCount: 42,
							externalIds: { DOI: "10.1000/example", PubMed: "12345" },
							openAccessPdf: { url: "https://example.org/paper.pdf" },
							authors: [{ name: "Ada Lovelace" }],
						},
					],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}

		throw new Error(`Unexpected fetch: ${url}`);
	};

	const tool = createLiteratureSearchTool();
	const result = await tool.execute(
		"tool-call",
		{ pubmed_query: "trained immunity[tiab]", semantic_scholar_query: "trained immunity", max_results: 1 },
		undefined,
		undefined,
	);

	assert.ok(calls.some((call) => call.url.includes("esearch.fcgi")));
	assert.ok(calls.some((call) => call.url.includes("efetch.fcgi")));
	const semanticScholarCall = calls.find((call) => call.url.includes("semanticscholar.org"));
	assert.ok(semanticScholarCall);
	assert.equal((semanticScholarCall.headers as Record<string, string>)["x-api-key"], "test-s2-key");
	assert.equal(result.details.count, 1);
	assert.deepEqual(result.details.providers.pubmed, {
		searched: true,
		count: 1,
		query: "trained immunity[tiab]",
		total: 1,
	});
	assert.deepEqual(result.details.providers.semantic_scholar, {
		searched: true,
		count: 1,
		query: "trained immunity",
	});
	assert.deepEqual(result.details.papers[0].sources, ["pubmed", "semantic_scholar"]);
	assert.equal(result.details.papers[0].citation_count, 42);
	assert.equal(result.details.papers[0].open_access_pdf, "https://example.org/paper.pdf");
	assert.equal(JSON.parse(result.content[0].text).length, 1);
});

test("literature_search derives a Semantic Scholar query from pubmed_query when needed", async () => {
	process.env.SEMANTIC_SCHOLAR_API_KEY = "test-s2-key";
	const semanticScholarQueries: string[] = [];
	globalThis.fetch = async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("esearch.fcgi")) {
			return new Response(JSON.stringify({ esearchresult: { idlist: [], count: "0" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.includes("semanticscholar.org")) {
			semanticScholarQueries.push(new URL(url).searchParams.get("query") ?? "");
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error(`Unexpected fetch: ${url}`);
	};

	const tool = createLiteratureSearchTool();
	await tool.execute(
		"tool-call",
		{ pubmed_query: "(trained immunity[tiab] OR immune memory[mh])", max_results: 1 },
		undefined,
		undefined,
	);

	assert.deepEqual(semanticScholarQueries, ["trained immunity immune memory"]);
});

test("literature_search keeps PubMed results when supplementary Semantic Scholar fails", async () => {
	process.env.SEMANTIC_SCHOLAR_API_KEY = "test-s2-key";
	globalThis.fetch = async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("esearch.fcgi")) {
			return new Response(JSON.stringify({ esearchresult: { idlist: ["12345"], count: "1" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.includes("efetch.fcgi")) {
			return new Response(pubmedXml({ doi: "10.1000/example" }), {
				status: 200,
				headers: { "content-type": "application/xml" },
			});
		}
		if (url.includes("semanticscholar.org")) {
			return new Response("rate limited", { status: 429 });
		}
		throw new Error(`Unexpected fetch: ${url}`);
	};

	const tool = createLiteratureSearchTool();
	const result = await tool.execute(
		"tool-call",
		{ pubmed_query: "trained immunity[tiab]", semantic_scholar_query: "trained immunity", max_results: 1 },
		undefined,
		undefined,
	);

	assert.equal(result.details.count, 1);
	assert.equal(result.details.papers[0].source, "pubmed");
	assert.match(result.details.providers.semantic_scholar.reason, /Semantic Scholar search failed/);
	assert.ok(result.details.events.some((event: any) => event.phase === "query_error"));
});

test.after(() => {
	globalThis.fetch = originalFetch;
	if (originalSemanticScholarApiKey === undefined) {
		delete process.env.SEMANTIC_SCHOLAR_API_KEY;
	} else {
		process.env.SEMANTIC_SCHOLAR_API_KEY = originalSemanticScholarApiKey;
	}
	if (originalNcbiApiKey === undefined) {
		delete process.env.NCBI_API_KEY;
	} else {
		process.env.NCBI_API_KEY = originalNcbiApiKey;
	}
});
