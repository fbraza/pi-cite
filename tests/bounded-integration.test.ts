import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager, createReadTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import literatureToolsExtension from "../src/index.ts";
import { LITERATURE_TOOL_NAMES } from "../src/tool-metadata.ts";
import { MAX_MODEL_OUTPUT_BYTES } from "../src/evidence-output.ts";

const abstract = "Complete immune findings 🧪 界. ".repeat(3000);
const xml = `<PubmedArticle><MedlineCitation><PMID>123</PMID><Article><ArticleTitle>Evidence paper</ArticleTitle><Abstract><AbstractText>${abstract}</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`;
const fulltext = "科学的な結果 🧪. ".repeat(1500);

test("real Pi direct calls bound all four tools, retrieve complete artifacts, and codemode keeps complete nested evidence", { timeout: 30_000 }, async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pi-cite-bounded-"));
  const envNames = ["NCBI_API_KEY", "ZOTERO_API_KEY", "ZOTERO_USER_ID"] as const;
  const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  let session: AgentSession | undefined;
  const savedCandidates = join(directory, "candidates.json");
  const artifactPaths: string[] = [];
  const code = `
    const results = await Promise.allSettled([
      tools.pubmed_search({ query: "example", fetch_abstracts: true }),
      tools.zotero_search({ query: "example" }),
      tools.literature_search({ pubmed_query: "example", fetch_abstracts: true }),
      tools.europe_pmc_fulltext({ identifier: "PMC555", sections: ["results"] }),
      tools.europe_pmc_fulltext({ identifier: "malformed" })
    ]);
    const searches = results.slice(0, 3).map(result => {
      if (result.status !== "fulfilled") throw result.reason;
      if ("model_output" in result.value) throw new Error("Presentation metadata leaked into structured evidence");
      return result.value;
    });
    if (results[3].status !== "fulfilled" || results[4].status !== "rejected") throw new Error("Lost success/failure outcomes");
    await tools.write({ path: ${JSON.stringify(savedCandidates)}, content: JSON.stringify({ searches, fulltext: results[3].value }, null, 2) });
    store("selected_pmids", searches[0].papers.map(paper => paper.pmid));
    return { abstract_lengths: searches.map(search => search.papers[0].abstract.length),
      section_length: results[3].value.sections[0].text.length, failure: results[4].status, owned: searches[2].papers[0].in_zotero };
  `;
  try {
    process.env.NCBI_API_KEY = "test-key";
    process.env.ZOTERO_API_KEY = "test-key";
    process.env.ZOTERO_USER_ID = "42";
    const originalMkdtemp = fs.mkdtemp;
    t.mock.method(fs, "mkdtemp", ((prefix: string, options?: any) => {
      assert.match(prefix, /pi-cite-evidence-/);
      return originalMkdtemp(join(directory, "pi-cite-evidence-"), options);
    }) as typeof fs.mkdtemp);
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("esearch.fcgi")) return Response.json({ esearchresult: { idlist: ["123"], count: "1" } });
      if (url.includes("efetch.fcgi")) return new Response(xml);
      if (url.includes("/keys/current")) return Response.json({ userID: 42 });
      if (url.includes("/items/top")) return Response.json([{ key: "OWNED", data: { title: "Evidence paper", extra: "PMID: 123", abstractNote: abstract, creators: [] } }], { headers: { "Total-Results": "1" } });
      if (url.includes("/search?")) return Response.json({ hitCount: 1, resultList: { result: [{ source: "MED", id: "123", title: "Evidence paper", pmcid: "PMC555", isOpenAccess: "Y", license: "CC BY" }] } });
      if (url.endsWith("/PMC555/fullTextXML")) return new Response(`<article><body><sec><title>Results</title><p>${fulltext}</p></sec></body></article>`);
      throw new Error(`Unexpected network request: ${url}`);
    });
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode", ...LITERATURE_TOOL_NAMES.map(name => `+${name}`)], compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [literatureToolsExtension, createCodemodeExtension({ models: false })],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const manager = SessionManager.inMemory(directory);
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "bounded", name: "codemode", arguments: { code } }],
      api: "openai-completions", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    session = (await createAgentSession({ cwd: directory, agentDir: directory, resourceLoader, settingsManager, sessionManager: manager })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: error => { errors.push(error); } });
    for (const [name, args] of [
      ["pubmed_search", { query: "example", fetch_abstracts: true }],
      ["zotero_search", { query: "example" }],
      ["literature_search", { pubmed_query: "example", fetch_abstracts: true }],
      ["europe_pmc_fulltext", { identifier: "PMC555", sections: ["results"] }],
    ] as const) {
      const tool: AgentSession["agent"]["state"]["tools"][number] | undefined = session.agent.state.tools.find(tool => tool.name === name);
      assert.ok(tool);
      const result = await tool.execute(`direct-${name}`, args);
      const text = result.content.filter(block => block.type === "text").map(block => block.text).join("");
      assert.ok(Buffer.byteLength(text) <= MAX_MODEL_OUTPUT_BYTES);
      const preview = JSON.parse(text);
      assert.equal(preview.model_output.truncated, true);
      artifactPaths.push(preview.model_output.full_result_path);
      const artifact = await fs.readFile(preview.model_output.full_result_path, "utf8");
      assert.deepEqual(JSON.parse(artifact), result.structuredContent);
      // Exercise the actual Pi read tool, rather than only Node's filesystem.
      const read = await createReadTool(directory).execute("artifact-read", { path: preview.model_output.full_result_path, offset: 1, limit: 3 });
      assert.ok(read.content.some(block => block.type === "text" && block.text.includes("{")));
    }
    const codemode = session.agent.state.tools.find(tool => tool.name === "codemode");
    assert.ok(codemode);
    const result = await codemode.execute("bounded", { code });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const text = result.content.filter(block => block.type === "text").map(block => block.text).at(-1)!;
    const summary = JSON.parse(text);
    assert.deepEqual(summary.abstract_lengths, [abstract.trim().length, abstract.trim().length, abstract.trim().length]);
    assert.equal(summary.failure, "rejected");
    assert.equal(summary.owned, true);
    const saved = JSON.parse(await fs.readFile(savedCandidates, "utf8"));
    assert.equal(saved.searches[0].papers[0].abstract, abstract.trim());
    assert.equal(saved.searches[1].papers[0].abstract, abstract.trim());
    assert.equal(saved.fulltext.sections[0].text.length, summary.section_length);
    assert.deepEqual(errors, []);
    assert.equal(session.messages.length, 1, "Nested calls must not add transcript entries");
    session.dispose();
    session = undefined;
    for (const path of artifactPaths) assert.ok(JSON.parse(await fs.readFile(path, "utf8")), "Successful artifacts must survive shutdown for transcript retrieval");
  } finally {
    session?.dispose();
    for (const name of envNames) { if (originalEnv[name] === undefined) delete process.env[name]; else process.env[name] = originalEnv[name]; }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
