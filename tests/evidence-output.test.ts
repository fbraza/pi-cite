import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { evidenceResult, MAX_MODEL_OUTPUT_BYTES, writeEvidenceArtifact } from "../src/evidence-output.ts";
import { LITERATURE_SEARCH_OUTPUT, PUBMED_SEARCH_OUTPUT, EUROPE_PMC_OUTPUT, ZOTERO_SEARCH_OUTPUT } from "../src/output-schemas.ts";

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "pi-cite-output-test-"));
  try { await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function largePaper(index = 0) {
  return {
    title: `Paper ${index}`, pmid: String(1000 + index), doi: `10.1000/${index}`, pmcid: `PMC${1000 + index}`,
    authors: ["Author One"], year: 2025, source: "pubmed", in_zotero: true, zotero_key: `KEY${index}`,
    abstract: "Immune evidence 🧪 界 é. ".repeat(1500),
  };
}

const textOf = (result: { content: { text: string }[] }) => result.content.map(block => block.text).join("");

test("small evidence stays unchanged, while ownership warnings also reach model content", async () => {
  await withDirectory(async directory => {
    const paper = { title: "Small", pmid: "123", abstract: "Complete abstract." };
    const data = { count: 1, papers: [paper], query: "query" };
    const details = { ...data, display_only: true };
    const text = JSON.stringify(data.papers, null, 2);
    const result = await evidenceResult(PUBMED_SEARCH_OUTPUT, text, data, details, { artifactRoot: directory });
    assert.equal(textOf(result), text);
    assert.equal(result.details, details);
    assert.deepEqual(result.structuredContent, data);
    const literature = { count: 1, papers: [paper], providers: {
      pubmed: { searched: true as const, count: 1, query: "query" },
      zotero: { searched: false as const, reason: "Ownership could not be checked" },
    } };
    const warned = await evidenceResult(LITERATURE_SEARCH_OUTPUT, text, literature, literature, { artifactRoot: directory });
    assert.equal(warned.content[0].text, text);
    assert.match(warned.content[1].text, /Ownership could not be checked/);
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test("exact UTF-8 budget boundary is unchanged and an extra byte requires an artifact", async () => {
  await withDirectory(async directory => {
    const data = { count: 1, papers: [{ title: "Evidence", pmid: "123", abstract: "Complete" }], query: "example" };
    const exact = "界".repeat(10922) + "aa";
    assert.equal(Buffer.byteLength(exact), MAX_MODEL_OUTPUT_BYTES);
    const unchanged = await evidenceResult(PUBMED_SEARCH_OUTPUT, exact, data, data, { artifactRoot: directory });
    assert.equal(textOf(unchanged), exact);
    assert.deepEqual(await fs.readdir(directory), []);
    const bounded = await evidenceResult(PUBMED_SEARCH_OUTPUT, exact + "b", data, data, { artifactRoot: directory });
    assert.equal(JSON.parse(textOf(bounded)).model_output.original_bytes, MAX_MODEL_OUTPUT_BYTES + 1);
    assert.equal((await fs.readdir(directory)).length, 1);
  });
});

test("all search schemas retain complete multibyte evidence in artifacts and structured output", async () => {
  await withDirectory(async directory => {
    const papers = Array.from({ length: 12 }, (_, index) => largePaper(index));
    for (const schema of [PUBMED_SEARCH_OUTPUT, ZOTERO_SEARCH_OUTPUT, LITERATURE_SEARCH_OUTPUT]) {
      const data = schema === LITERATURE_SEARCH_OUTPUT
        ? { count: papers.length, papers, providers: { pubmed: { searched: true as const, count: papers.length, query: "exact query" }, zotero: { searched: false as const, reason: "Rate limited" } } }
        : { count: papers.length, papers, query: "exact query", total: 200 };
      const before = structuredClone(data);
      const details = { ...data, events: ["display only"] };
      const result = await evidenceResult(schema, JSON.stringify(papers, null, 2), data, details, { artifactRoot: directory });
      const text = textOf(result);
      assert.ok(Buffer.byteLength(text) <= MAX_MODEL_OUTPUT_BYTES);
      assert.doesNotMatch(text, /\uFFFD/);
      const preview = JSON.parse(text);
      assert.equal(preview.model_output.truncated, true);
      assert.ok(preview.paper_previews.length > 0);
      assert.equal(preview.model_output.total_papers, papers.length);
      assert.equal(preview.model_output.shown_papers, preview.paper_previews.length);
      assert.equal(preview.result_metadata.count, papers.length);
      assert.equal(preview.paper_previews[0].pmid, "1000");
      assert.equal(preview.paper_previews[0].doi, "10.1000/0");
      assert.equal(preview.paper_previews[0].pmcid, "PMC1000");
      assert.equal(preview.paper_previews[0].in_zotero, true);
      assert.equal(preview.paper_previews[0].zotero_key, "KEY0");
      assert.match(preview.paper_previews[0].abstract_excerpt, /Immune evidence/);
      assert.equal(preview.paper_previews[0].abstract, undefined);
      assert.match(preview.model_output.retrieval, /read tool/);
      if (schema === LITERATURE_SEARCH_OUTPUT) assert.equal(preview.result_metadata.providers.zotero.reason, "Rate limited");
      const artifact = await fs.readFile(preview.model_output.full_result_path, "utf8");
      assert.equal(Buffer.byteLength(artifact), preview.model_output.full_result_bytes);
      assert.deepEqual(JSON.parse(artifact), result.structuredContent);
      assert.deepEqual(result.structuredContent, before);
      assert.deepEqual(data, before);
      assert.equal("events" in JSON.parse(artifact), false);
      assert.equal("model_output" in result.structuredContent, false);
      assert.ok("model_output" in result.details);
      assert.equal("model_output" in details, false);
    }
  });
});

test("large Europe PMC excerpts retain actual provenance and distinguish preview from retrieval truncation", async () => {
  await withDirectory(async directory => {
    const prose = "科学的な結果 🧪. ".repeat(1500);
    const data = {
      tool: "europe_pmc_fulltext" as const, status: "full_text" as const,
      identifier: { type: "pmcid" as const, normalized: "PMC555" },
      metadata: { title: "Evidence paper", pmcid: "PMC555", license: "CC BY", is_open_access: true },
      sections: [{ section: "results" as const, heading: "Results", text: prose, truncated: false }],
      requested_sections: ["results" as const], missing_sections: [], section_fallback: false,
      truncated: false, max_chars: 24000, returned_chars: prose.length,
      provenance: { provider: "Europe PMC" as const, api_version: "6.9" as const, search_url: "https://example.org/search", full_text_url: "https://example.org/source" },
      urls: { europe_pmc: "https://example.org/PMC555", pmc: "https://example.org/PMC555" },
    };
    const result = await evidenceResult(EUROPE_PMC_OUTPUT, JSON.stringify(data, null, 2), data, data, { artifactRoot: directory });
    const preview = JSON.parse(textOf(result));
    assert.ok(Buffer.byteLength(textOf(result)) <= MAX_MODEL_OUTPUT_BYTES);
    assert.equal(preview.result_metadata.truncated, false);
    assert.equal(preview.model_output.truncated, true);
    assert.equal(preview.model_output.total_sections, 1);
    assert.equal(preview.model_output.shown_sections, 1);
    assert.equal(preview.result_metadata.identifier.normalized, "PMC555");
    assert.deepEqual(preview.result_metadata.provenance, data.provenance);
    assert.equal(preview.result_metadata.metadata.license, "CC BY");
    assert.equal(preview.section_previews[0].truncated, false);
    assert.ok(preview.section_previews[0].text_excerpt.length < prose.length);
    assert.equal(preview.section_previews[0].text, undefined);
    assert.deepEqual(JSON.parse(await fs.readFile(preview.model_output.full_result_path, "utf8")), data);
  });
});

test("large unavailable full-text results retain fallback reasons and are not operational errors", async () => {
  await withDirectory(async directory => {
    const data = { tool: "europe_pmc_fulltext" as const, status: "unavailable" as const, reason: "not_open_access" as const,
      recommended_fallback: "pubmed_abstract" as const, identifier: { type: "pmcid" as const, normalized: "PMC555" },
      metadata: { title: "Large metadata 🧪. ".repeat(4000), is_open_access: false },
      provenance: { provider: "Europe PMC" as const, api_version: "6.9" as const, search_url: "https://example.org/search" },
    };
    const result = await evidenceResult(EUROPE_PMC_OUTPUT, JSON.stringify(data, null, 2), data, data, { artifactRoot: directory });
    assert.ok(Buffer.byteLength(textOf(result)) <= MAX_MODEL_OUTPUT_BYTES);
    assert.equal(result.isError, undefined);
    const preview = JSON.parse(textOf(result));
    assert.equal(preview.result_metadata.status, "unavailable");
    assert.equal(preview.result_metadata.reason, "not_open_access");
    assert.equal(preview.result_metadata.recommended_fallback, "pubmed_abstract");
    assert.deepEqual(preview.result_metadata.provenance, data.provenance);
    assert.deepEqual(JSON.parse(await fs.readFile(preview.model_output.full_result_path, "utf8")), data);
  });
});

test("JSON escaping, huge metadata, and a single huge record cannot exceed the byte budget", async () => {
  await withDirectory(async directory => {
    for (const value of ["🧪界".repeat(30000), "\u0000\"\\".repeat(30000)]) {
      const paper = { ...largePaper(), title: value, authors: Array(50).fill(value), mesh_terms: Array(50).fill(value), abstract: value };
      const data = { count: 1, papers: [paper], query: value };
      const result = await evidenceResult(PUBMED_SEARCH_OUTPUT, JSON.stringify([paper]), data, data, { artifactRoot: directory });
      assert.ok(Buffer.byteLength(textOf(result)) <= MAX_MODEL_OUTPUT_BYTES);
      const preview = JSON.parse(textOf(result));
      assert.equal(preview.paper_previews.length, 1);
      assert.equal(preview.paper_previews[0].pmid, paper.pmid);
      assert.deepEqual(JSON.parse(await fs.readFile(preview.model_output.full_result_path, "utf8")), data);
    }
  });
});

test("citation identifiers and source warnings remain verbatim or explicitly omitted, never shortened", async () => {
  await withDirectory(async directory => {
    for (const doi of ["10.1000/" + "x".repeat(500), "10.1000/" + "x".repeat(2000)]) {
      const papers = [{ ...largePaper(), doi }];
      const data = { count: 1, papers, providers: { pubmed: { searched: true as const, count: 1, query: "example" }, zotero: { searched: false as const, reason: "Ownership warning" } } };
      const result = await evidenceResult(LITERATURE_SEARCH_OUTPUT, JSON.stringify(papers), data, data, { artifactRoot: directory });
      const preview = JSON.parse(textOf(result));
      if (doi.length < 1024) assert.equal(preview.paper_previews[0].doi, doi);
      else assert.equal(preview.paper_previews[0].doi.omitted, true);
      assert.equal(preview.result_metadata.providers.zotero.reason, "Ownership warning");
      assert.equal(JSON.parse(await fs.readFile(preview.model_output.full_result_path, "utf8")).papers[0].doi, doi);
    }
  });
});

test("artifacts use unique private paths and remain readable until explicitly removed", async () => {
  await withDirectory(async directory => {
    const [first, second] = await Promise.all([writeEvidenceArtifact({ title: "Private" }, { artifactRoot: directory }), writeEvidenceArtifact({ title: "Private" }, { artifactRoot: directory })]);
    assert.notEqual(first.path, second.path);
    assert.equal(await fs.readFile(first.path, "utf8"), JSON.stringify({ title: "Private" }, null, 2));
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(first.path)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(dirname(first.path))).mode & 0o777, 0o700);
    }
    await fs.rm(dirname(first.path), { recursive: true });
    assert.deepEqual(JSON.parse(await fs.readFile(second.path, "utf8")), { title: "Private" });
  });
});

test("invalid data and pre-aborted outputs create no artifact", async () => {
  await withDirectory(async directory => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(writeEvidenceArtifact({ evidence: "x" }, { artifactRoot: directory, signal: controller.signal }), /Request aborted/);
    const schema = Type.Object({ count: Type.Integer() });
    await assert.rejects(evidenceResult(schema, "x".repeat(100000), { count: Number.NaN }, {}, { artifactRoot: directory }), /output schema/);
    await assert.rejects(evidenceResult(schema, "small", { count: 1 }, {}, { artifactRoot: directory, signal: controller.signal }), /Request aborted/);
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test("write failures remove the new artifact directory rather than returning an unreadable path", async t => {
  await withDirectory(async directory => {
    t.mock.method(fs, "writeFile", async () => { throw new Error("disk failure"); });
    await assert.rejects(writeEvidenceArtifact({ evidence: "x" }, { artifactRoot: directory }), /disk failure/);
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test("preview-construction failure removes the complete artifact instead of leaking a file", async () => {
  await withDirectory(async directory => {
    const schema = Type.Object({ metadata: Type.Record(Type.String(), Type.Integer()) });
    const data = { metadata: Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [`field${index}`, index])) };
    await assert.rejects(evidenceResult(schema, JSON.stringify(data), data, {}, { artifactRoot: directory }), /Could not build an evidence preview/);
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test("cancellation during artifact writing removes even a completed file", async t => {
  await withDirectory(async directory => {
    const controller = new AbortController();
    const originalWrite = fs.writeFile;
    t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => { await originalWrite(...args); controller.abort(); });
    await assert.rejects(writeEvidenceArtifact({ evidence: "x" }, { artifactRoot: directory, signal: controller.signal }), /Request aborted/);
    assert.deepEqual(await fs.readdir(directory), []);
  });
});
