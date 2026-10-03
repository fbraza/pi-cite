import assert from "node:assert/strict";
import test from "node:test";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { createEuropePmcFulltextTool } from "../src/europe-pmc.ts";
import { createLiteratureSearchTool } from "../src/literature-search.ts";
import { createPubmedSearchTool } from "../src/pubmed.ts";
import { createZoteroSearchTool } from "../src/zotero.ts";
import { PAPER_RECORD_SCHEMA } from "../src/output-schemas.ts";
import { emitProgress, structuredResult, type TextToolPayload } from "../src/tool-output.ts";

const originalFetch = globalThis.fetch;
const envNames = ["NCBI_API_KEY", "ZOTERO_API_KEY", "ZOTERO_USER_ID"] as const;
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

const pubmedXml = `<PubmedArticleSet><PubmedArticle><MedlineCitation>
  <PMID>12345</PMID><Article><ArticleTitle>Example paper</ArticleTitle>
  <Abstract><AbstractText>Example abstract.</AbstractText></Abstract>
  <Journal><Title>Example Journal</Title><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal>
  <ELocationID EIdType="doi">10.1000/example</ELocationID>
  </Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
const zoteroItem = {
  key: "OWNED", data: {
    title: "Example paper", DOI: "10.1000/example", extra: "PMID: 12345\nPMCID: PMC555",
    abstractNote: "Owned abstract.", date: "2024",
    creators: [{ firstName: "Jane", lastName: "Smith", creatorType: "author" }],
  },
};
const europeRecord = {
  source: "MED", id: "12345", doi: "10.1000/example", pmcid: "PMC555",
  isOpenAccess: "Y", license: "CC BY",
};
const jats = "<article><body><sec><title>Results</title><p>Example findings.</p></sec></body></article>";

function assertSchema(schema: TSchema, data: unknown): void {
  assert.equal(Value.Check(schema, data), true, JSON.stringify(Value.Errors(schema, data)));
  // The in-process value itself must already be JSON-safe, not just serializable.
  assert.deepEqual(data, JSON.parse(JSON.stringify(data)));
}

function assertSearchText(result: { content: Array<{ text: string }>; structuredContent: { papers: unknown } }): void {
  assert.equal(result.content[0].text, JSON.stringify(result.structuredContent.papers, null, 2));
}

function mockSearches({ empty = false, zoteroFailure = false } = {}): void {
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("esearch.fcgi"))
      return Response.json({ esearchresult: { idlist: empty ? [] : ["12345"], count: empty ? "0" : "7" } });
    if (url.includes("efetch.fcgi")) return new Response(pubmedXml);
    if (url.includes("/keys/current")) {
      if (zoteroFailure) return new Response("denied", { status: 403 });
      return Response.json({ userID: 42 });
    }
    if (url.includes("/items/top"))
      return Response.json(empty ? [] : [zoteroItem], { headers: { "Total-Results": empty ? "0" : "8" } });
    throw new Error(`Unexpected network request: ${url}`);
  };
}

test.beforeEach(() => {
  for (const name of envNames) delete process.env[name];
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of envNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

test("paper schema accepts minimal and complete records and rejects invalid fields", () => {
  assertSchema(PAPER_RECORD_SCHEMA, { title: "Minimal paper" });
  assertSchema(PAPER_RECORD_SCHEMA, {
    title: "Complete paper", pmid: "12345", pmcid: "PMC555", doi: "10.1000/example",
    abstract: "Abstract.", authors: ["Jane Smith"], journal: "Journal", year: 2024,
    publication_types: ["Journal Article"], mesh_terms: ["Humans"], source: "pubmed",
    sources: ["pubmed", "zotero"], date: "2024-01-01", category: "research",
    version: "1", license: "CC BY", in_zotero: true, zotero_key: "OWNED",
  });
  for (const data of [{}, { title: 123 }, { title: "Paper", abstract: 1 }, { title: "Paper", year: 2024.5 }, { title: "Paper", unknown: true }])
    assert.equal(Value.Check(PAPER_RECORD_SCHEMA, data), false);
});

test("structured result preserves evidence/details, omits undefined fields, and does not mutate data", () => {
  const data: { count: number; papers: Array<{ title: string; abstract?: string }>; total?: number } = {
    count: 1, papers: [{ title: "Paper", abstract: undefined }], total: undefined,
  };
  const details = { events: [{ phase: "complete" }] };
  const schema = Type.Object({
    count: Type.Integer(), papers: Type.Array(PAPER_RECORD_SCHEMA), total: Type.Optional(Type.Integer()),
  });
  const result = structuredResult(schema, "Evidence text", data, details);
  assert.deepEqual(result.content, [{ type: "text", text: "Evidence text" }]);
  assert.deepEqual(result.structuredContent, { count: 1, papers: [{ title: "Paper" }] });
  assert.equal(result.details, details);
  assert.equal(Object.hasOwn(data, "total"), true);
  assert.equal(Object.hasOwn(data.papers[0], "abstract"), true);
  assert.throws(() => structuredResult(schema, "Evidence", { ...data, total: Number.NaN }, details), /output schema/);
  const updates: TextToolPayload[] = [];
  emitProgress(update => updates.push(update), "Progress", { phase: "start" });
  assert.deepEqual(updates, [{ content: [{ type: "text", text: "Progress" }], details: { phase: "start" } }]);
  assert.equal(Object.hasOwn(updates[0], "structuredContent"), false);
});

test("PubMed structured outputs validate for full, identifier-only, and empty results", async () => {
  const tool = createPubmedSearchTool();
  for (const scenario of ["full", "identifiers", "empty"] as const) {
    mockSearches({ empty: scenario === "empty" });
    const updates: TextToolPayload[] = [];
    const result = await tool.execute("call", {
      query: "example[tiab]", publication_types: ["Journal Article"], date_from: "2020/01/01",
      fetch_abstracts: scenario !== "identifiers",
    }, undefined, update => updates.push(update));
    assertSchema(tool.outputSchema, result.structuredContent);
    assertSearchText(result);
    assert.equal(result.structuredContent.query, 'example[tiab] AND ("Journal Article"[Publication Type]) AND (2020/01/01:3000/12/31[Date - Publication])');
    assert.equal(result.structuredContent.count, scenario === "empty" ? 0 : 1);
    assert.equal(result.structuredContent.count, result.structuredContent.papers.length);
    if (scenario === "full") {
      assert.equal(result.structuredContent.total, 7);
      assert.equal(result.structuredContent.papers[0].abstract, "Example abstract.");
    }
    assert.ok(updates.length > 0);
    assert.ok(updates.every(update => !Object.hasOwn(update, "structuredContent")));
    assert.equal(result.isError, undefined);
  }
});

test("Zotero structured outputs retain query, ownership, identifiers, total, and optional fields", async () => {
  process.env.ZOTERO_API_KEY = "test-key";
  process.env.ZOTERO_USER_ID = "42";
  const tool = createZoteroSearchTool();
  for (const empty of [false, true]) {
    mockSearches({ empty });
    const result = await tool.execute("call", { query: "example" });
    assertSchema(tool.outputSchema, result.structuredContent);
    assertSearchText(result);
    assert.equal(result.structuredContent.query, "example");
    assert.equal(result.structuredContent.count, empty ? 0 : 1);
    assert.equal(result.structuredContent.total, empty ? 0 : 8);
    if (!empty) {
      const paper = result.structuredContent.papers[0];
      assert.equal(paper.in_zotero, true);
      assert.equal(paper.zotero_key, "OWNED");
      assert.equal(paper.pmcid, "PMC555");
      assert.equal(Object.hasOwn(paper, "journal"), false);
    }
  }
});

test("literature structured outputs exclude display state and preserve provider outcomes", async () => {
  const tool = createLiteratureSearchTool();
  for (const scenario of ["no-key", "owned", "ownership-failure", "empty"] as const) {
    if (scenario === "no-key") delete process.env.ZOTERO_API_KEY;
    else process.env.ZOTERO_API_KEY = "test-key";
    process.env.ZOTERO_USER_ID = "42";
    mockSearches({ empty: scenario === "empty", zoteroFailure: scenario === "ownership-failure" });
    const result = await tool.execute("call", { pubmed_query: "example[tiab]" });
    const data = result.structuredContent;
    assertSchema(tool.outputSchema, data);
    assertSearchText(result);
    assert.deepEqual(Object.keys(data).sort(), ["count", "papers", "providers"]);
    assert.ok(result.details.events.length > 0);
    assert.ok(Array.isArray(result.details.searches));
    assert.equal(data.providers.pubmed.searched, true);
    if (scenario === "no-key") assert.equal(Object.hasOwn(data.providers, "zotero"), false);
    if (scenario === "owned") {
      assert.equal(data.providers.zotero?.searched, true);
      assert.equal(data.papers[0].in_zotero, true);
      assert.equal(data.papers[0].zotero_key, "OWNED");
    }
    if (scenario === "ownership-failure") {
      assert.ok(data.providers.zotero && !data.providers.zotero.searched);
      assert.match(data.providers.zotero.reason, /403/);
      assert.equal(result.isError, undefined);
      assert.equal(Object.hasOwn(data.papers[0], "in_zotero"), false);
    }
    if (scenario === "empty") {
      assert.equal(data.count, 0);
      assert.ok(data.providers.zotero && !data.providers.zotero.searched);
      assert.equal(data.providers.zotero.reason, "No PubMed candidates to check");
    }
    assert.equal(Value.Check(tool.outputSchema, { ...data, events: result.details.events }), false);
  }
});

test("Europe PMC structured full text validates with excerpts, provenance, truncation, and missing sections", async () => {
  const tool = createEuropePmcFulltextTool();
  for (const max_chars of [1, 24_000]) {
    globalThis.fetch = async input => String(input).includes("/search?")
      ? Response.json({ hitCount: 1, resultList: { result: [europeRecord] } }) : new Response(jats);
    const result = await tool.execute("call", { identifier: "PMC555", sections: ["results", "methods"], max_chars });
    const data = result.structuredContent;
    assertSchema(tool.outputSchema, data);
    assert.equal(result.content[0].text, JSON.stringify(data, null, 2));
    assert.equal(data.status, "full_text");
    if (data.status !== "full_text") throw new Error("Expected full text");
    assert.equal(data.metadata.license, "CC BY");
    assert.equal(Object.hasOwn(data.metadata, "title"), false);
    assert.equal(data.truncated, max_chars === 1);
    assert.deepEqual(data.missing_sections, ["methods"]);
    assert.match(data.provenance.full_text_url, /PMC555\/fullTextXML$/);
    assert.equal(Value.Check(tool.outputSchema, { ...data, provenance: {} }), false);
    assert.equal(Value.Check(tool.outputSchema, { ...data, status: "unknown" }), false);
  }
});

test("every Europe PMC unavailable reason is a valid structured success with fallback", async () => {
  const tool = createEuropePmcFulltextTool();
  for (const reason of ["not_found", "ambiguous_match", "not_open_access", "no_pmcid", "xml_not_available", "source_too_large"] as const) {
    globalThis.fetch = async input => {
      if (!String(input).includes("/search?")) {
        if (reason === "xml_not_available") return new Response("missing", { status: 404 });
        return new Response("large", { headers: { "content-length": String(5 * 1024 * 1024 + 1) } });
      }
      const records = reason === "not_found" ? [] : reason === "ambiguous_match" ? [europeRecord, europeRecord] : [{
        ...europeRecord,
        isOpenAccess: reason === "not_open_access" ? "N" : "Y",
        pmcid: reason === "no_pmcid" ? undefined : "PMC555",
      }];
      return Response.json({ hitCount: records.length, resultList: { result: records } });
    };
    const result = await tool.execute("call", { identifier: "10.1000/example" });
    const data = result.structuredContent;
    assertSchema(tool.outputSchema, data);
    assert.equal(data.status, "unavailable");
    if (data.status !== "unavailable") throw new Error("Expected unavailable");
    assert.equal(data.reason, reason);
    assert.equal(data.recommended_fallback, "pubmed_abstract");
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, JSON.stringify(data, null, 2));
    assert.equal(Value.Check(tool.outputSchema, { ...data, reason: "unknown" }), false);
  }
});

test("malformed provider totals fail the output contract instead of returning non-JSON numbers", async () => {
  globalThis.fetch = async input => String(input).includes("esearch.fcgi")
    ? Response.json({ esearchresult: { idlist: ["12345"], count: "invalid" } }) : new Response(pubmedXml);
  await assert.rejects(createPubmedSearchTool().execute("call", { query: "example" }), /output schema/);
  await assert.rejects(createLiteratureSearchTool().execute("call", { pubmed_query: "example" }), /output schema/);
  process.env.ZOTERO_API_KEY = "test-key";
  process.env.ZOTERO_USER_ID = "42";
  globalThis.fetch = async input => String(input).includes("/keys/current")
    ? Response.json({ userID: 42 }) : Response.json([], { headers: { "Total-Results": "invalid" } });
  await assert.rejects(createZoteroSearchTool().execute("call", { query: "example" }), /output schema/);
});

test("operational failures still reject instead of becoming structured successes", async () => {
  globalThis.fetch = async () => new Response("failure", { status: 503 });
  await assert.rejects(createPubmedSearchTool().execute("call", { query: "example" }), /503/);
  await assert.rejects(createLiteratureSearchTool().execute("call", { pubmed_query: "example" }), /503/);
  await assert.rejects(createZoteroSearchTool().execute("call", { query: "example" }), /ZOTERO_API_KEY/);
  process.env.ZOTERO_API_KEY = "test-key";
  await assert.rejects(createZoteroSearchTool().execute("call", { query: "example" }), /503/);
  await assert.rejects(createEuropePmcFulltextTool().execute("call", { identifier: "PMC555" }), /503/);
});
