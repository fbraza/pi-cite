import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import literatureToolsExtension from "../src/index.ts";

const code = `
      const pubmed = await tools.pubmed_search({ query: "example", fetch_abstracts: false });
      const zotero = await tools.zotero_search({ query: "example" });
      const literature = await tools.literature_search({ pubmed_query: "example", fetch_abstracts: false });
      const fulltext = await tools.europe_pmc_fulltext({ identifier: "PMC555", sections: ["results"] });
      const unavailable = await tools.europe_pmc_fulltext({ identifier: "PMC999" });
      for (const data of [pubmed, zotero, literature, fulltext, unavailable]) {
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected structured object");
      }
      if (pubmed.papers[0].pmid !== "12345" || pubmed.query !== "example") throw new Error("Missing PubMed fields");
      if (!zotero.papers[0].in_zotero || zotero.query !== "example") throw new Error("Missing Zotero fields");
      if (!literature.papers[0].in_zotero || !literature.providers.zotero.searched) throw new Error("Missing ownership data");
      if ("events" in literature || "searches" in literature) throw new Error("Display state leaked");
      if (fulltext.status !== "full_text" || fulltext.sections[0].text !== "Example findings.") throw new Error("Missing excerpts");
      if (unavailable.status !== "unavailable" || unavailable.recommended_fallback !== "pubmed_abstract") throw new Error("Missing fallback");
      const failures = await Promise.allSettled([tools.europe_pmc_fulltext({ identifier: "malformed" })]);
      if (failures[0].status !== "rejected") throw new Error("Operational failures must reject");
      const declaration = await describeTool("pubmed_search");
      if (!declaration || !declaration.includes("papers")) throw new Error("Missing structured declaration");
      return { types: [pubmed, zotero, literature, fulltext, unavailable].map(value => typeof value),
        counts: [pubmed.count, zotero.count, literature.count], statuses: [fulltext.status, unavailable.status] };
    `;

// Real Pi session + nested-call pipeline + QuickJS; only external provider HTTP is mocked.
test("Pi codemode receives structured objects from all four literature tools", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cite-codemode-"));
  const originalFetch = globalThis.fetch;
  const envNames = ["NCBI_API_KEY", "ZOTERO_API_KEY", "ZOTERO_USER_ID"] as const;
  const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    delete process.env.NCBI_API_KEY;
    process.env.ZOTERO_API_KEY = "test-key";
    process.env.ZOTERO_USER_ID = "42";
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [literatureToolsExtension, createCodemodeExtension({ models: false })],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const manager = SessionManager.inMemory(directory);
    // Pi requires an issuing assistant message for nested calls. Seed authoritative
    // session history rather than modifying agent state or making a live model request.
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "integration", name: "codemode", arguments: { code } }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    const created = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      resourceLoader,
      settingsManager,
      sessionManager: manager,
      tools: ["codemode", "literature_search", "pubmed_search", "zotero_search", "europe_pmc_fulltext"],
    });
    session = created.session;
    await session.bindExtensions({});

    globalThis.fetch = async input => {
      const url = String(input);
      if (url.includes("esearch.fcgi")) return Response.json({ esearchresult: { idlist: ["12345"], count: "1" } });
      if (url.includes("/keys/current")) return Response.json({ userID: 42 });
      if (url.includes("/items/top")) return Response.json([
        { key: "OWNED", data: { title: "Example paper", extra: "PMID: 12345", creators: [] } },
      ], { headers: { "Total-Results": "1" } });
      if (url.includes("/search?")) {
        if (new URL(url).searchParams.get("query") === "PMCID:PMC999")
          return Response.json({ hitCount: 0, resultList: { result: [] } });
        return Response.json({ hitCount: 1, resultList: { result: [
          { source: "MED", id: "12345", pmcid: "PMC555", isOpenAccess: "Y", license: "CC BY" },
        ] } });
      }
      if (url.endsWith("/PMC555/fullTextXML"))
        return new Response("<article><body><sec><title>Results</title><p>Example findings.</p></sec></body></article>");
      throw new Error(`Unexpected network request: ${url}`);
    };
    const codemode = session.agent.state.tools.find(tool => tool.name === "codemode");
    assert.ok(codemode);
    const result = await codemode.execute("integration", { code }, undefined);
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const output = result.content.filter(block => block.type === "text").map(block => block.text);
    assert.deepEqual(JSON.parse(output.at(-1)!), {
      types: ["object", "object", "object", "object", "object"],
      counts: [1, 1, 1], statuses: ["full_text", "unavailable"],
    });
    assert.equal(session.messages.length, 1, "Nested calls must not add transcript entries");
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
