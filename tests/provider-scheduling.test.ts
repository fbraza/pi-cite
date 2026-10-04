import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import test from "node:test";
import { searchPubmed, lookupPubmedIdentifiers } from "../src/pubmed.ts";
import { fetchText } from "../src/shared.ts";
import { zoteroFetch } from "../src/zotero.ts";
import { searchLiterature } from "../src/literature-search.ts";
import { fetchEuropePmcFulltext } from "../src/europe-pmc.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const ncbiUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/esearch.fcgi";

test("concurrent PubMed searches and identifier lookup share NCBI pacing and body-consumption concurrency", async t => {
  const envName = "PI_CITE_TEST_NCBI_KEY";
  const saved = process.env[envName];
  const savedDefault = process.env.NCBI_API_KEY;
  delete process.env.NCBI_API_KEY;
  process.env[envName] = "test-key";
  const starts: Array<{ url: string; time: number }> = [];
  let active = 0;
  let maximum = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    starts.push({ url, time: Date.now() });
    active++;
    maximum = Math.max(maximum, active);
    // The response body deliberately stays pending after the fetch returns.
    return {
      ok: true, headers: new Headers(),
      async text() {
        await wait(5);
        active--;
        return url.includes("esearch.fcgi") ? JSON.stringify({ esearchresult: { idlist: ["123"], count: "1" } }) : "<PubmedArticle><MedlineCitation><Article><ArticleTitle>Example</ArticleTitle></Article></MedlineCitation></PubmedArticle>";
      },
    } as Response;
  });
  try {
    const searches = await Promise.allSettled([
      searchPubmed({ query: "one", fetch_abstracts: false, api_key: envName }),
      searchPubmed({ query: "two", fetch_abstracts: false, api_key: envName }),
      lookupPubmedIdentifiers("123"),
    ]);
    assert.deepEqual(searches.map(result => result.status), ["fulfilled", "fulfilled", "fulfilled"]);
    assert.equal(maximum, 1);
    assert.equal(starts.length, 3);
    assert.ok(starts[1].time - starts[0].time >= 120);
    assert.ok(starts[2].time - starts[1].time >= 350, "An unkeyed lookup must use conservative spacing even after keyed searches");
    assert.ok(starts[0].url.includes("api_key=test-key"));
  } finally {
    if (saved === undefined) delete process.env[envName]; else process.env[envName] = saved;
    if (savedDefault === undefined) delete process.env.NCBI_API_KEY; else process.env.NCBI_API_KEY = savedDefault;
  }
});

test("NCBI Retry-After defers sibling requests without retrying a failed request", async t => {
  const starts: number[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    starts.push(Date.now());
    return starts.length === 1
      ? new Response("Rate limited", { status: 429, headers: { "Retry-After": "0.4" } })
      : new Response("complete");
  });
  const results = await Promise.allSettled([fetchText(ncbiUrl), fetchText(ncbiUrl)]);
  assert.deepEqual(results.map(result => result.status), ["rejected", "fulfilled"]);
  assert.ok(starts[1] - starts[0] >= 400);
  assert.equal(starts.length, 2);
});

test("Zotero serialization holds through JSON parsing and uses the longest Backoff/Retry-After", async t => {
  const starts: number[] = [];
  let active = 0;
  let maximum = 0;
  t.mock.method(globalThis, "fetch", async () => {
    starts.push(Date.now());
    active++;
    maximum = Math.max(maximum, active);
    const index = starts.length;
    return {
      ok: true, headers: new Headers(index === 1 ? { "Backoff": "0.03", "Retry-After": "0.06" } : {}),
      async json() { await wait(5); active--; return { index }; },
    } as Response;
  });
  const results = await Promise.all([zoteroFetch("https://api.zotero.org/first", { apiKey: "key" }), zoteroFetch("https://api.zotero.org/second", { apiKey: "key" })]);
  assert.equal(maximum, 1);
  assert.ok(starts[1] - starts[0] >= 60);
  assert.deepEqual(results.map(result => result.data), [{ index: 1 }, { index: 2 }]);
});

test("Zotero queued cancellation never sends HTTP and preserves another active request", async t => {
  const started = deferred();
  const finish = deferred();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return { ok: true, headers: new Headers(), async json() { started.resolve(); await finish.promise; return {}; } } as Response;
  });
  const first = zoteroFetch("https://api.zotero.org/first", { apiKey: "key" });
  await started.promise;
  const controller = new AbortController();
  const second = zoteroFetch("https://api.zotero.org/cancelled", { apiKey: "key" }, controller.signal);
  const rejected = assert.rejects(second, /Request aborted/);
  controller.abort();
  try {
    await rejected;
    assert.equal(requests, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    finish.resolve();
    await first;
  }
});

test("cancelling literature_search during ownership checking rejects instead of producing a warning success", async t => {
  const names = ["ZOTERO_API_KEY", "ZOTERO_USER_ID"] as const;
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.ZOTERO_API_KEY = "test-key";
  process.env.ZOTERO_USER_ID = "42";
  const controller = new AbortController();
  const updates: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("esearch.fcgi")) return Response.json({ esearchresult: { idlist: ["123"], count: "1" } });
    if (url.includes("/keys/current")) { controller.abort(); throw new Error("aborted HTTP"); }
    throw new Error(`Unexpected request: ${url}`);
  });
  try {
    await assert.rejects(searchLiterature({ pubmed_query: "example", fetch_abstracts: false }, controller.signal, update => {
      updates.push(...update.content.map(block => block.text));
    }), /Request aborted/);
    assert.doesNotMatch(updates.join("\n"), /continuing without ownership|search complete/i);
  } finally {
    for (const name of names) { if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; }
  }
});

test("Europe PMC shares backoff across concurrent calls and retains successful unavailable outcomes", async t => {
  const starts: number[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    starts.push(Date.now());
    if (starts.length === 1) return new Response("busy", { status: 429, headers: { "Retry-After": "0.03" } });
    return Response.json({ hitCount: 0, resultList: { result: [] } });
  });
  const results = await Promise.allSettled([fetchEuropePmcFulltext({ identifier: "PMC111" }), fetchEuropePmcFulltext({ identifier: "PMC222" })]);
  assert.deepEqual(results.map(result => result.status), ["rejected", "fulfilled"]);
  assert.ok(starts[1] - starts[0] >= 30);
  const second = results[1];
  assert.ok(second.status === "fulfilled");
  assert.equal(second.value.status, "unavailable");
});

test("Europe PMC serializes XML body reads and cancelled calls cannot return unavailable successes", async t => {
  let active = 0;
  let maximum = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    active++;
    maximum = Math.max(maximum, active);
    if (url.includes("/search?")) return {
      ok: true, status: 200, headers: new Headers(),
      async json() { await wait(2); active--; return { hitCount: 1, resultList: { result: [{ source: "MED", id: "1", pmcid: "PMC111", isOpenAccess: "Y" }] } }; },
    } as Response;
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ async start(controller) {
      await wait(10);
      controller.enqueue(encoder.encode("<article><body><sec><title>Results</title><p>Evidence</p></sec></body></article>"));
      active--;
      controller.close();
    } }));
  });
  const results = await Promise.all([fetchEuropePmcFulltext({ identifier: "PMC111" }), fetchEuropePmcFulltext({ identifier: "PMC111" })]);
  assert.equal(maximum, 1);
  assert.ok(results.every(result => result.status === "full_text"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchEuropePmcFulltext({ identifier: "PMC999" }, controller.signal), /Request aborted/);
});
