import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  initTheme, ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import literatureToolsExtension from "../src/index.ts";
import { createEuropePmcFulltextTool, type EuropePmcFulltextParams } from "../src/europe-pmc.ts";
import { createLiteratureSearchTool } from "../src/literature-search.ts";
import { createPubmedSearchTool } from "../src/pubmed.ts";
import { createZoteroSearchTool } from "../src/zotero.ts";

const factories = [createPubmedSearchTool, createZoteroSearchTool, createLiteratureSearchTool, createEuropePmcFulltextTool];

function mockedFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.includes("esearch.fcgi")) return Promise.resolve(Response.json({ esearchresult: { idlist: ["123"], count: "1" } }));
  if (url.includes("/keys/current")) return Promise.resolve(Response.json({ userID: 42 }));
  if (url.includes("/items/top")) return Promise.resolve(Response.json([{ key: "OWNED", data: { title: "Example paper", extra: "PMID: 123", creators: [] } }], { headers: { "Total-Results": "1" } }));
  if (url.includes("/search?")) {
    if (new URL(url).searchParams.get("query") === "PMCID:PMC999") return Promise.resolve(Response.json({ hitCount: 0, resultList: { result: [] } }));
    return Promise.resolve(Response.json({ hitCount: 1, resultList: { result: [{ source: "MED", id: "123", title: "<Evidence>", pmcid: "PMC555", isOpenAccess: "Y", license: "CC BY" }] } }));
  }
  if (url.endsWith("/PMC555/fullTextXML")) return Promise.resolve(new Response("<article><body><sec><title>Results</title><p>Evidence excerpt.</p></sec></body></article>"));
  throw new Error(`Unexpected network request: ${url}`);
}

async function withSession(run: (session: Awaited<ReturnType<typeof createAgentSession>>["session"], directory: string) => Promise<void>, seed?: (manager: SessionManager) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-cite-rendering-"));
  const originalFetch = globalThis.fetch;
  const envNames = ["NCBI_API_KEY", "ZOTERO_API_KEY", "ZOTERO_USER_ID"] as const;
  const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    delete process.env.NCBI_API_KEY;
    process.env.ZOTERO_API_KEY = "test-key";
    process.env.ZOTERO_USER_ID = "42";
    globalThis.fetch = mockedFetch;
    initTheme("dark", false);
    const settingsManager = SettingsManager.inMemory({ theme: "dark", compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [literatureToolsExtension],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const manager = SessionManager.create(directory, join(directory, "sessions"));
    await seed?.(manager);
    session = (await createAgentSession({ cwd: directory, agentDir: directory, resourceLoader, settingsManager, sessionManager: manager })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: error => { errors.push(error); } });
    await run(session, directory);
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("Pi's interactive ToolExecutionComponent supplies context-only errors, expansions, and theme invalidation", () => {
  initTheme("dark", false);
  let redraws = 0;
  // This component needs only requestRender; no live terminal or TUI event loop.
  const ui = { requestRender: () => { redraws++; } } as TUI;
  for (const factory of factories) {
    const tool = factory();
    const component = new ToolExecutionComponent(tool.name, `ui-${tool.name}`, {
      query: "fallback query", pubmed_query: "fallback query", identifier: "PMC555",
    }, { showImages: false }, tool, ui, process.cwd());
    component.markExecutionStarted();
    component.updateResult({ content: [{ type: "text", text: "Waiting for provider" }], details: {}, isError: false }, true);
    assert.doesNotMatch(component.render(80).map(stripTerminalSequences).join("\n"), /✓/);
    component.updateResult({ content: [{ type: "text", text: "HTTP 503: service unavailable" }], details: {}, isError: true });
    let rendered = component.render(80).map(stripTerminalSequences).join("\n");
    assert.match(rendered, /failed/);
    assert.match(rendered, /HTTP 503/);
    assert.doesNotMatch(rendered, /✓/);
    component.setExpanded(true);
    const dark = component.render(120).join("\n");
    rendered = stripTerminalSequences(dark);
    assert.match(rendered, tool.name === "europe_pmc_fulltext" ? /identifier: PMC555/ : /query: fallback query/);
    initTheme("light", false);
    component.invalidate();
    assert.notEqual(component.render(120).join("\n"), dark);
    for (const line of component.render(32)) assert.ok(visibleWidth(line) <= 32);
    initTheme("dark", false);
  }
  assert.equal(redraws, 4);
});

test("real Pi HTML export renders failures, call arguments, unavailable data, and bounded full-text previews", async () => {
  await withSession(async (session, directory) => {
    const output = await session.exportToHtml(join(directory, "session.html"));
    const html = await readFile(output, "utf8");
    const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
    assert.ok(encoded);
    const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      renderedTools: Record<string, { resultHtmlCollapsed?: string; resultHtmlExpanded?: string }>;
    };
    for (const factory of factories) {
      const tool = factory();
      const rendering = data.renderedTools[`${tool.name}-error`];
      assert.ok(rendering?.resultHtmlExpanded, `Missing custom HTML rendering for ${tool.name}`);
      assert.match(rendering.resultHtmlExpanded, /failed/);
      assert.match(rendering.resultHtmlExpanded, /HTTP 503/);
      assert.doesNotMatch(rendering.resultHtmlExpanded, /✓/);
      assert.match(rendering.resultHtmlExpanded.replace(/<[^>]*>/g, ""), tool.name === "europe_pmc_fulltext" ? /identifier: PMC555/ : /query: fallback query/);
      assert.match(rendering.resultHtmlCollapsed ?? "", /failed/);
    }
    const fulltext = data.renderedTools.fulltext;
    assert.match(fulltext.resultHtmlCollapsed ?? "", /open-access excerpts/);
    assert.match(fulltext.resultHtmlExpanded ?? "", /Returned excerpts are truncated/);
    assert.match(fulltext.resultHtmlExpanded ?? "", /provenance: Europe PMC/);
    assert.match(fulltext.resultHtmlExpanded ?? "", /&lt;Evidence&gt;/);
    const unavailable = data.renderedTools.unavailable;
    assert.match(unavailable.resultHtmlExpanded ?? "", /unavailable: not_found/);
    assert.match(unavailable.resultHtmlExpanded ?? "", /fallback: PubMed abstract \(not fetched\)/);
    assert.doesNotMatch(unavailable.resultHtmlExpanded ?? "", /✓| failed/);
  }, async manager => {
    // Seed real authoritative history; never prompt a model to generate fixtures.
    const calls: ToolCall[] = [
      ...factories.map(factory => ({ type: "toolCall" as const, id: `${factory().name}-error`, name: factory().name, arguments: { query: "fallback query", pubmed_query: "fallback query", identifier: "PMC555" } })),
      { type: "toolCall" as const, id: "fulltext", name: "europe_pmc_fulltext", arguments: { identifier: "PMC555", sections: ["results"], max_chars: 5 } },
      { type: "toolCall" as const, id: "unavailable", name: "europe_pmc_fulltext", arguments: { identifier: "PMC999" } },
    ];
    manager.appendMessage({
      role: "assistant", content: calls, api: "openai-completions", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: Date.now(),
    });
    for (const factory of factories) manager.appendMessage({
      role: "toolResult", toolCallId: `${factory().name}-error`, toolName: factory().name,
      content: [{ type: "text", text: "HTTP 503: service unavailable" }], details: {}, isError: true, timestamp: Date.now(),
    });
    const tool = createEuropePmcFulltextTool();
    const fulltextCalls: Array<{ id: string; args: EuropePmcFulltextParams }> = [
      { id: "fulltext", args: { identifier: "PMC555", sections: ["results"], max_chars: 5 } },
      { id: "unavailable", args: { identifier: "PMC999" } },
    ];
    for (const { id, args } of fulltextCalls) {
      const result = await tool.execute(id, args);
      manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: tool.name, ...result, isError: false, timestamp: Date.now() });
    }
  });
});

test("real Pi direct/headless tool execution returns unchanged structured evidence without invoking renderers", async () => {
  await withSession(async session => {
    const calls = [
      ["pubmed_search", { query: "example", fetch_abstracts: false }],
      ["zotero_search", { query: "example" }],
      ["literature_search", { pubmed_query: "example", fetch_abstracts: false }],
      ["europe_pmc_fulltext", { identifier: "PMC555", sections: ["results"] }],
    ] as const;
    for (const [name, args] of calls) {
      const tool = session.agent.state.tools.find(tool => tool.name === name);
      assert.ok(tool, `Expected direct active tool ${name}`);
      let progressCount = 0;
      const result = await tool.execute(`headless-${name}`, args, undefined, () => { progressCount++; });
      assert.ok(progressCount > 0);
      assert.equal(result.isError, undefined);
      assert.ok(result.structuredContent && typeof result.structuredContent === "object");
      const data = result.structuredContent as { count?: number; status?: string; sections?: { text: string }[] };
      if (name === "europe_pmc_fulltext") {
        assert.equal(data.status, "full_text");
        assert.equal(data.sections?.[0].text, "Evidence excerpt.");
      } else assert.equal(data.count, 1);
      assert.ok(result.content.some(block => block.type === "text" && block.text.includes(name === "europe_pmc_fulltext" ? "Evidence excerpt." : "123")));
    }
  });
});
