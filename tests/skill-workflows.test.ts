import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const document = await readFile(new URL("../skills/literature/references/codemode-workflows.md", import.meta.url), "utf8");
const scripts = [...document.matchAll(/```js\n([\s\S]*?)\n```/g)].map(match => match[1]);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("bundled codemode search example batches, merges identifier bridges/ownership, saves complete data and retains failures", async () => {
  assert.equal(scripts.length, 2);
  const captured: unknown[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const stored: Array<{ key: string; value: unknown }> = [];
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const tools = {
    async literature_search() {
      active++; maximum = Math.max(maximum, active);
      const index = calls++;
      await Promise.resolve();
      active--;
      if (index === 1) throw new Error("query failed");
      return { count: 3, providers: { pubmed: { searched: true, count: 3, query: "effective query" }, zotero: { searched: false, reason: "ownership unavailable" } }, papers: [
        { title: "A", doi: "https://doi.org/10.1/ABC", abstract: "Short", source: "pubmed", in_zotero: false },
        { title: "B", pmid: "123", pmcid: "PMC123", abstract: "Complete longer abstract", source: "zotero", in_zotero: true, zotero_key: "OWNED" },
        { title: "Bridge", doi: "10.1/abc", pmid: "123", source: "pubmed" },
      ] };
    },
    async write(args: { path: string; content: string }) { writes.push(args); },
  };
  await new AsyncFunction("tools", "text", "store", scripts[0])(tools, (value: unknown) => captured.push(value), (key: string, value: unknown) => stored.push({ key, value }));
  assert.ok(maximum <= 2);
  assert.equal(calls, 2);
  assert.equal(writes.length, 1);
  const saved = JSON.parse(writes[0].content);
  assert.equal(saved.failures.length, 1);
  assert.match(saved.failures[0].error, /query failed/);
  assert.equal(saved.searches[0].providers.zotero.reason, "ownership unavailable");
  assert.equal(saved.papers.length, 1);
  assert.equal(saved.papers[0].abstract, "Complete longer abstract");
  assert.equal(saved.papers[0].in_zotero, true);
  assert.equal(saved.papers[0].zotero_key, "OWNED");
  assert.equal(saved.papers[0].pmid, "123");
  assert.equal(saved.papers[0].pmcid, "PMC123");
  assert.deepEqual(saved.papers[0].sources.sort(), ["pubmed", "zotero"]);
  assert.ok(captured.length > 0);
  assert.ok(JSON.stringify(stored).length < 1000);
  assert.doesNotMatch(JSON.stringify(stored), /abstract|papers/);
});

test("bundled full-text example saves unavailable data without automatic fallback retrieval", async () => {
  let active = 0;
  let maximum = 0;
  const writes: Array<{ path: string; content: string }> = [];
  const output: unknown[] = [];
  const tools = {
    async europe_pmc_fulltext({ identifier }: { identifier: string }) {
      active++; maximum = Math.max(maximum, active);
      await Promise.resolve(); active--;
      return { status: "unavailable", identifier: { normalized: identifier }, reason: "not_open_access", recommended_fallback: "pubmed_abstract", provenance: { provider: "Europe PMC", search_url: "https://example.org" } };
    },
    async write(args: { path: string; content: string }) { writes.push(args); },
  };
  await new AsyncFunction("tools", "text", scripts[1])(tools, (value: unknown) => output.push(value));
  assert.ok(maximum <= 2);
  const saved = JSON.parse(writes[0].content);
  assert.equal(saved.evidence.length, 2);
  assert.equal(saved.evidence[0].reason, "not_open_access");
  assert.deepEqual(saved.failures, []);
  assert.ok(output.length > 0);
});
