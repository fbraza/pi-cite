import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import literatureToolsExtension from "../src/index.ts";
import { LITERATURE_ANNOTATIONS, LITERATURE_NAMESPACE, LITERATURE_TOOL_NAMES } from "../src/tool-metadata.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function harness({ active = ["read"], unavailable = [] as string[], defaultTools = undefined as string[] | undefined } = {}) {
  const tools = new Map<string, ToolDefinition<any, any>>();
  const handlers = new Map<string, Handler[]>();
  let selected = [...active];
  let branch: SessionEntry[] = [];
  let bound = false;
  let registrations = 0;
  let updates = 0;
  const settings = { defaultTools };
  const pi = {
    registerTool(tool: ToolDefinition<any, any>) {
      registrations++;
      if (!unavailable.includes(tool.name)) tools.set(tool.name, tool);
    },
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    getActiveTools() {
      assert.ok(bound, "Session APIs must not be read during factory loading");
      return [...selected];
    },
    getAllTools() {
      assert.ok(bound);
      return [...tools.values()];
    },
    getSettings() {
      assert.ok(bound);
      return settings;
    },
    setActiveTools(names: string[]) {
      assert.ok(bound);
      updates++;
      selected = [...names];
    },
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", id: String(branch.length), parentId: branch.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(), customType, data: structuredClone(data) });
    },
  } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  const load = () => { bound = false; handlers.clear(); literatureToolsExtension(pi); bound = true; };
  const fire = async (type: string, reason = "startup") => {
    for (const handler of handlers.get(type) ?? []) await handler({ type, reason }, ctx);
  };
  load();
  return {
    tools, settings, load, fire,
    get active() { return [...selected]; },
    set active(names: string[]) { selected = [...names]; },
    get branch() { return branch; },
    set branch(entries: SessionEntry[]) { branch = entries; },
    get registrations() { return registrations; },
    get updates() { return updates; },
  };
}

function assertExposure(h: ReturnType<typeof harness>, exposure: "direct" | "codemode") {
  for (const name of LITERATURE_TOOL_NAMES) assert.equal(h.tools.get(name)?.exposure, exposure, name);
}

test("loading registers default-inactive tools with shared metadata, without reading session APIs", () => {
  const h = harness();
  assert.equal(h.registrations, 4);
  for (const name of LITERATURE_TOOL_NAMES) {
    const tool = h.tools.get(name)!;
    assert.equal(tool.defaultActive, false);
    assert.equal(tool.exposure, "direct");
    assert.equal(tool.namespace, LITERATURE_NAMESPACE);
    assert.deepEqual(tool.annotations, LITERATURE_ANNOTATIONS);
  }
});

test("automatic exposure follows active codemode, not registration, and preserves unrelated tools", async () => {
  const h = harness({ active: ["read", "bash", "codemode"] });
  await h.fire("session_start");
  assertExposure(h, "codemode");
  assert.deepEqual(h.active, ["read", "bash", "codemode"]);
  h.active = ["read", "bash"];
  await h.fire("before_agent_start");
  assertExposure(h, "direct");
  assert.deepEqual(h.active, ["read", "bash", ...LITERATURE_TOOL_NAMES]);
  h.active = [...h.active, "codemode"];
  await h.fire("before_agent_start");
  assertExposure(h, "codemode");
  assert.deepEqual(h.active, ["read", "bash", "codemode"]);
});

test("unchanged boundaries do not re-register tools, update selections, or append state", async () => {
  for (const active of [["read"], ["read", "codemode"]]) {
    const h = harness({ active });
    await h.fire("session_start");
    const baseline = [h.registrations, h.updates, h.branch.length];
    for (let i = 0; i < 5; i++) await h.fire("before_agent_start");
    assert.deepEqual([h.registrations, h.updates, h.branch.length], baseline);
  }
});

test("explicit startup selections stay active even when codemode is enabled", async () => {
  const h = harness({ active: ["read", "codemode", "pubmed_search"] });
  await h.fire("session_start");
  assert.deepEqual(h.active, ["read", "codemode", "pubmed_search"]);
  assert.equal(h.tools.get("pubmed_search")!.exposure, "direct");
  assert.equal(h.tools.get("literature_search")!.exposure, "codemode");
});

test("first upgrade/reload conservatively preserves pre-existing active selections", async () => {
  const h = harness({ active: ["read", "codemode", ...LITERATURE_TOOL_NAMES] });
  await h.fire("session_start", "reload");
  assert.deepEqual(h.active, ["read", "codemode", ...LITERATURE_TOOL_NAMES]);
  assertExposure(h, "direct");
});

test("manual disable survives codemode toggles and reload; explicit reactivation works", async () => {
  const h = harness();
  await h.fire("session_start");
  h.active = h.active.filter(name => name !== "pubmed_search");
  await h.fire("before_agent_start");
  h.active = [...h.active, "codemode"];
  await h.fire("before_agent_start");
  assert.equal(h.tools.get("pubmed_search")!.exposure, "direct");
  assert.ok(!h.active.includes("pubmed_search"));
  h.active = h.active.filter(name => name !== "codemode");
  await h.fire("session_shutdown", "reload");
  h.load();
  await h.fire("session_start", "reload");
  assert.ok(!h.active.includes("pubmed_search"));
  assert.ok(h.active.includes("literature_search"));
  h.active = [...h.active, "pubmed_search", "codemode"];
  await h.fire("before_agent_start");
  assert.ok(h.active.includes("pubmed_search"));
  assert.equal(h.tools.get("pubmed_search")!.exposure, "direct");
});

test("last-minute changes are saved at shutdown without changing exposure or active tools", async () => {
  const h = harness();
  await h.fire("session_start");
  h.active = h.active.filter(name => name !== "zotero_search");
  const selected = h.active;
  const registrations = h.registrations;
  await h.fire("session_shutdown", "reload");
  const entries = h.branch.length;
  await h.fire("session_shutdown", "reload");
  assert.equal(h.branch.length, entries, "Shutdown persistence should be idempotent");
  assert.equal(h.registrations, registrations);
  assert.deepEqual(h.active, selected);
  h.load();
  await h.fire("session_start", "reload");
  assert.ok(!h.active.includes("zotero_search"));
});

test("settings modifiers disable callable tools, pin enabled tools, and honor Pi modifier ordering", async () => {
  const h = harness({ active: ["read", "codemode"], defaultTools: ["-pubmed_search", "pubmed_search", "+zotero_search"] });
  await h.fire("session_start");
  assert.equal(h.tools.get("pubmed_search")!.exposure, "direct");
  assert.ok(!h.active.includes("pubmed_search"));
  assert.ok(h.active.includes("zotero_search"));
  assert.equal(h.tools.get("zotero_search")!.exposure, "direct");
  h.active = h.active.filter(name => name !== "zotero_search");
  await h.fire("before_agent_start");
  await h.fire("before_agent_start");
  assert.ok(!h.active.includes("zotero_search"), "An unchanged +name must not repeatedly reactivate a tool");
  h.settings.defaultTools = ["+pubmed_search"];
  await h.fire("before_agent_start");
  assert.ok(h.active.includes("pubmed_search"));
});

test("CLI/SDK activation overrides a negative default and absent registry tools stay absent", async () => {
  const h = harness({ active: ["codemode", "pubmed_search"], defaultTools: ["-pubmed_search"], unavailable: ["zotero_search"] });
  await h.fire("session_start");
  assert.ok(h.active.includes("pubmed_search"));
  assert.equal(h.tools.has("zotero_search"), false);
  h.active = ["pubmed_search"];
  await h.fire("before_agent_start");
  assert.ok(!h.active.includes("zotero_search"));
});

test("resume reconstructs policies without requiring automatic tools in the initial active set", async () => {
  const h = harness();
  await h.fire("session_start");
  h.active = h.active.filter(name => name !== "pubmed_search");
  await h.fire("session_shutdown", "dispose");
  h.active = ["read"];
  h.load();
  await h.fire("session_start", "resume");
  assert.ok(h.active.includes("literature_search"));
  assert.ok(!h.active.includes("pubmed_search"));
  h.active = [...h.active, "codemode"];
  await h.fire("before_agent_start");
  assert.equal(h.tools.get("literature_search")!.exposure, "codemode");
  assert.equal(h.tools.get("pubmed_search")!.exposure, "direct");
});

test("tree changes use branch-local policy without mutating abandoned branch entries", async () => {
  const h = harness();
  await h.fire("session_start");
  const firstBranch = structuredClone(h.branch);
  h.active = h.active.filter(name => name !== "pubmed_search");
  await h.fire("before_agent_start");
  const otherBranch = structuredClone(h.branch);
  h.branch = structuredClone(firstBranch);
  await h.fire("session_tree");
  assert.ok(h.active.includes("pubmed_search"));
  h.branch = structuredClone(otherBranch);
  await h.fire("session_tree");
  assert.ok(!h.active.includes("pubmed_search"));
  const originalEntry = otherBranch.at(-1);
  const restoredEntry = h.branch.at(-1);
  assert.ok(originalEntry?.type === "custom" && restoredEntry?.type === "custom");
  assert.deepEqual(originalEntry.data, restoredEntry.data);
});
