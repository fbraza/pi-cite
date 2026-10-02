import assert from "node:assert/strict";
import test from "node:test";

import {
	createEuropePmcFulltextTool,
	fetchEuropePmcFulltext,
	normalizeEuropePmcIdentifier,
} from "../src/europe-pmc.ts";

const originalFetch = globalThis.fetch;
const record = {
	source: "MED",
	id: "12345",
	pmcid: "PMC555",
	doi: "10.1000/example",
	title: "Open paper",
	journalInfo: { journal: { title: "Core Journal" } },
	isOpenAccess: "Y",
	license: "CC BY",
};

function searchResponse(
	records: Record<string, unknown>[] = [record],
	hitCount = records.length,
) {
	return new Response(
		JSON.stringify({ hitCount, resultList: { result: records } }),
	);
}

function mockPaper(xml: string) {
	globalThis.fetch = async (input) =>
		String(input).includes("/search?") ? searchResponse() : new Response(xml);
}

const nestedJats = `<article>
  <front><abstract><p>EXCLUDED abstract</p></abstract></front>
  <body>
    <sec><title>Introduction</title><p>Introductory <italic>context</italic>.</p></sec>
    <sec><title>Materials and Methods</title><p>Methods body.</p>
      <fig><caption><p>EXCLUDED figure</p></caption></fig>
      <table-wrap><table><tr><td>EXCLUDED table</td></tr></table></table-wrap>
      <supplementary-material><p>EXCLUDED supplement</p></supplementary-material>
      <sec><title>Cohort selection</title><p>Nested method detail.</p></sec>
    </sec>
    <sec><title>Results and Discussion</title><p>Combined findings &amp; interpretation.</p></sec>
    <ref-list><ref><mixed-citation>EXCLUDED reference</mixed-citation></ref></ref-list>
  </body>
</article>`;

test("Europe PMC normalizes canonical identifiers and rejects malformed ones", () => {
	assert.deepEqual(
		normalizeEuropePmcIdentifier("https://doi.org/10.1000/Example"),
		{
			type: "doi",
			normalized: "10.1000/example",
			query: "DOI:10.1000/example",
		},
	);
	assert.equal(
		normalizeEuropePmcIdentifier("DOI: 10.1000/example").normalized,
		"10.1000/example",
	);
	assert.deepEqual(normalizeEuropePmcIdentifier("PMID: 12345"), {
		type: "pmid",
		normalized: "12345",
		query: "EXT_ID:12345 AND SRC:MED",
	});
	assert.deepEqual(normalizeEuropePmcIdentifier("PMCID: pmc555"), {
		type: "pmcid",
		normalized: "PMC555",
		query: "PMCID:PMC555",
	});
	for (const input of [
		"555abc",
		"PMCID:555",
		"10.1000/example OR cancer",
		"10.1000/%xx",
	]) {
		assert.throws(() => normalizeEuropePmcIdentifier(input), /Malformed/);
	}
});

test("Europe PMC refuses inexact, ambiguous, and incomplete search matches", async () => {
	for (const [records, count, reason] of [
		[[{ ...record, doi: "10.1000/different" }], 1, "not_found"],
		[[record, record], 2, "ambiguous_match"],
		[[record], 6, "ambiguous_match"],
		[[], 0, "not_found"],
	] as const) {
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return searchResponse([...records], count);
		};
		const result = await fetchEuropePmcFulltext({
			identifier: "10.1000/example",
		});
		assert.equal(result.status, "unavailable");
		if (result.status !== "unavailable")
			throw new Error("Expected unavailable text");
		assert.equal(result.reason, reason);
		assert.equal(result.recommended_fallback, "pubmed_abstract");
		assert.equal(calls, 1);
	}
});

test("Europe PMC extracts requested nested scientific sections and provenance", async () => {
	const calls: string[] = [];
	const controller = new AbortController();
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		calls.push(url);
		assert.equal(init?.method, "GET");
		assert.equal(init?.signal, controller.signal);
		if (url.includes("/search?")) {
			assert.equal(
				new URL(url).searchParams.get("query"),
				"EXT_ID:12345 AND SRC:MED",
			);
			assert.equal(new URL(url).searchParams.get("resultType"), "core");
			return searchResponse();
		}
		assert.match(url, /\/PMC555\/fullTextXML$/);
		return new Response(nestedJats);
	};
	const result = await fetchEuropePmcFulltext(
		{
			identifier: "PMID:12345",
			sections: ["methods", "discussion", "methods"],
		},
		controller.signal,
	);
	assert.equal(result.status, "full_text");
	if (result.status !== "full_text") throw new Error("Expected full text");
	assert.deepEqual(result.requested_sections, ["methods", "discussion"]);
	assert.deepEqual(
		result.sections.map(({ heading, section, text }) => ({
			heading,
			section,
			text,
		})),
		[
			{
				heading: "Materials and Methods",
				section: "methods",
				text: "Methods body.",
			},
			{
				heading: "Cohort selection",
				section: "methods",
				text: "Nested method detail.",
			},
			{
				heading: "Results and Discussion",
				section: "discussion",
				text: "Combined findings & interpretation.",
			},
		],
	);
	assert.doesNotMatch(JSON.stringify(result), /EXCLUDED/);
	assert.equal(result.metadata.license, "CC BY");
	assert.equal(result.metadata.journal, "Core Journal");
	assert.equal(result.metadata.is_open_access, true);
	assert.equal(result.provenance.full_text_url, calls[1]);
	assert.deepEqual(result.missing_sections, []);
	assert.equal(result.truncated, false);
});

test("Europe PMC preserves nested list paragraphs once and bounds the exact excerpt", async () => {
	mockPaper(`<article><body><sec><title>Results</title>
    <p>Before.<list><list-item><p>First item.</p></list-item>
    <list-item><p>Second item.</p></list-item></list>After.</p><p>Closing.</p>
  </sec></body></article>`);
	const expected =
		"Before.\n\nFirst item.\n\nSecond item.\n\nAfter.\n\nClosing.";
	for (const cap of [1, 27, expected.length, 24_000]) {
		const result = await fetchEuropePmcFulltext({
			identifier: "PMC555",
			sections: ["results"],
			max_chars: cap,
		});
		if (result.status !== "full_text") throw new Error("Expected full text");
		assert.equal(result.sections[0].text, expected.slice(0, cap));
		assert.equal(result.returned_chars, Math.min(expected.length, cap));
		assert.equal(result.truncated, cap < expected.length);
		assert.equal(result.sections[0].truncated, cap < expected.length);
	}
});

test("Europe PMC only falls back to unclassified sections for default selection", async () => {
	mockPaper(
		"<article><body><sec><title>Overview</title><p>Readable prose.</p></sec></body></article>",
	);
	const defaultResult = await fetchEuropePmcFulltext({ identifier: "PMC555" });
	if (defaultResult.status !== "full_text")
		throw new Error("Expected full text");
	assert.equal(defaultResult.section_fallback, true);
	assert.equal(defaultResult.sections[0].section, "other");
	const explicitResult = await fetchEuropePmcFulltext({
		identifier: "PMC555",
		sections: ["results"],
	});
	if (explicitResult.status !== "full_text")
		throw new Error("Expected full text");
	assert.equal(explicitResult.section_fallback, false);
	assert.deepEqual(explicitResult.sections, []);
	assert.deepEqual(explicitResult.missing_sections, ["results"]);
});

test("Europe PMC never retrieves XML for non-OA papers or missing PMCIDs", async () => {
	for (const [overrides, reason] of [
		[{ isOpenAccess: "N" }, "not_open_access"],
		[{ pmcid: undefined }, "no_pmcid"],
	] as const) {
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return searchResponse([{ ...record, ...overrides }]);
		};
		const result = await fetchEuropePmcFulltext({
			identifier: "10.1000/example",
		});
		if (result.status !== "unavailable")
			throw new Error("Expected unavailable text");
		assert.equal(result.reason, reason);
		assert.equal(calls, 1);
	}
});

test("Europe PMC handles missing XML and declared or streamed oversized sources", async () => {
	for (const response of [
		new Response("missing", { status: 404 }),
		new Response("oversized", {
			headers: { "content-length": String(5 * 1024 * 1024 + 1) },
		}),
		new Response("x".repeat(5 * 1024 * 1024 + 1)),
	]) {
		globalThis.fetch = async (input) =>
			String(input).includes("/search?") ? searchResponse() : response;
		const result = await fetchEuropePmcFulltext({ identifier: "PMC555" });
		if (result.status !== "unavailable")
			throw new Error("Expected unavailable text");
		assert.equal(
			result.reason,
			response.status === 404 ? "xml_not_available" : "source_too_large",
		);
	}
});

test("Europe PMC rejects invalid excerpt limits before network access", async () => {
	globalThis.fetch = async () => {
		throw new Error("Unexpected network access");
	};
	for (const cap of [0, -1, 1.5, 24_001, Number.NaN]) {
		await assert.rejects(
			fetchEuropePmcFulltext({ identifier: "PMC555", max_chars: cap }),
			/max_chars/,
		);
	}
});

test("Europe PMC reports provider and malformed payload failures", async () => {
	for (const status of [429, 503]) {
		globalThis.fetch = async () => new Response("failure", { status });
		await assert.rejects(
			fetchEuropePmcFulltext({ identifier: "PMC555" }),
			new RegExp(`HTTP ${status}`),
		);
	}
	globalThis.fetch = async () => new Response("not JSON");
	await assert.rejects(
		fetchEuropePmcFulltext({ identifier: "PMC555" }),
		/malformed search JSON/,
	);
	for (const xml of [
		"<article><body><sec>",
		"<article><body><sec><p>Broken</sec></body></article>",
		"<article/>",
	]) {
		mockPaper(xml);
		await assert.rejects(
			fetchEuropePmcFulltext({ identifier: "PMC555" }),
			/unparseable XML|malformed full-text XML/,
		);
	}
});

test("Europe PMC tool emits Pi progress and returns JSON text with structured details", async () => {
	mockPaper(nestedJats);
	const updates: any[] = [];
	const tool = createEuropePmcFulltextTool();
	const result = await tool.execute(
		"tool-call",
		{ identifier: "PMC555", sections: ["all"], max_chars: 20 },
		undefined,
		(update) => updates.push(update),
	);
	assert.equal(result.content[0].type, "text");
	assert.equal(result.content[0].text, JSON.stringify(result.details, null, 2));
	const parsed = JSON.parse(result.content[0].text);
	assert.equal(parsed.status, "full_text");
	assert.equal(parsed.identifier.normalized, "PMC555");
	if (result.details.status !== "full_text")
		throw new Error("Expected full text");
	assert.equal(result.details.returned_chars, 20);
	assert.equal(result.details.truncated, true);
	assert.equal(result.details.sections.length, 4);
	assert.deepEqual(
		updates.map((update) => update.content[0].text),
		[
			"Resolving Europe PMC paper: PMC555",
			"Retrieving Europe PMC open-access full text: PMC555",
		],
	);
	assert.ok(
		updates.every(
			(update) => update.content[0].type === "text" && !update.isError,
		),
	);
});

test("excluded nested sections cannot steal the surrounding scientific section", async () => {
	mockPaper(`<article><body><sec><title>Methods</title><p>Before.</p>
    <supplementary-material><sec><title>Excluded</title><p>EXCLUDED</p></sec></supplementary-material>
    <sec><title>Cohort</title><p>After.</p></sec>
  </sec></body></article>`);
	const result = await fetchEuropePmcFulltext({
		identifier: "PMC555",
		sections: ["methods"],
	});
	if (result.status !== "full_text") throw new Error("Expected full text");
	assert.deepEqual(
		result.sections.map(({ heading, text }) => ({ heading, text })),
		[
			{ heading: "Methods", text: "Before." },
			{ heading: "Cohort", text: "After." },
		],
	);
});

test("Europe PMC rejects HTML and bodies outside the main JATS article", async () => {
	for (const xml of [
		"<html><body><p>Service temporarily unavailable</p></body></html>",
		"<article><front><body><p>Not article evidence.</p></body></front></article>",
		"<article><body><p>Evidence.</p></body></article><article/>",
	]) {
		mockPaper(xml);
		await assert.rejects(
			fetchEuropePmcFulltext({ identifier: "PMC555" }),
			/malformed full-text XML/,
		);
	}
});

test("all sections retain unheaded body prose in document order", async () => {
	mockPaper(`<article><body><p>Unheaded beginning.</p>
    <sec><title>Methods</title><p>Method details.</p></sec>
    <p>Unheaded ending.</p></body></article>`);
	const result = await fetchEuropePmcFulltext({
		identifier: "PMC555",
		sections: ["all"],
	});
	if (result.status !== "full_text") throw new Error("Expected full text");
	assert.deepEqual(
		result.sections.map(({ section, text }) => ({ section, text })),
		[
			{ section: "other", text: "Unheaded beginning." },
			{ section: "methods", text: "Method details." },
			{ section: "other", text: "Unheaded ending." },
		],
	);
	assert.equal(result.truncated, false);
});

test("tool output bounds oversized headings and excessive section counts", async () => {
	const tool = createEuropePmcFulltextTool();
	mockPaper(
		`<article><body><sec><title>${"x".repeat(1_000_000)}</title><p>x</p></sec></body></article>`,
	);
	const headingResult = await tool.execute("tool-call", {
		identifier: "PMC555",
		sections: ["all"],
		max_chars: 1,
	});
	if (headingResult.details.status !== "full_text")
		throw new Error("Expected full text");
	assert.equal(headingResult.details.sections[0].heading.length, 200);
	assert.equal(headingResult.details.sections[0].text, "x");
	assert.equal(headingResult.details.sections[0].truncated, true);
	assert.equal(headingResult.details.truncated, true);
	assert.ok(headingResult.content[0].text.length < 2000);
	mockPaper(
		`<article><body>${"<sec><title>Results</title><p>x</p></sec>".repeat(1000)}</body></article>`,
	);
	const manyResult = await tool.execute("tool-call", {
		identifier: "PMC555",
		sections: ["all"],
		max_chars: 24_000,
	});
	if (manyResult.details.status !== "full_text")
		throw new Error("Expected full text");
	assert.equal(manyResult.details.sections.length, 50);
	assert.equal(manyResult.details.returned_chars, 50);
	assert.equal(manyResult.details.truncated, true);
	assert.ok(manyResult.content[0].text.length < 10_000);
});

test.afterEach(() => {
	globalThis.fetch = originalFetch;
});
