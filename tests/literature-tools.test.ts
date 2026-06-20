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

const originalFetch = globalThis.fetch;
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
		["literature_search", "pubmed_search"],
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
});
