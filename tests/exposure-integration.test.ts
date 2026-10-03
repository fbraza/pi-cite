import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager,
  type BeforeAgentStartEvent, type ExtensionContext, type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import literatureToolsExtension from "../src/index.ts";
import { LITERATURE_TOOL_NAMES } from "../src/tool-metadata.ts";

type Options = Pick<CreateAgentSessionOptions, "tools" | "excludeTools" | "noTools" | "sessionManager"> & {
  codemode?: "on" | "only" | false;
  defaultTools?: string[];
};

async function withSession(options: Options, run: (fixture: {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  checkpoint: () => Promise<void>;
  recreate: () => Promise<void>;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-cite-exposure-"));
  const originalFetch = globalThis.fetch;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  globalThis.fetch = async input => { throw new Error(`Unexpected network request: ${String(input)}`); };
  try {
    const settingsManager = SettingsManager.inMemory({ defaultTools: options.defaultTools, compaction: { enabled: false }, retry: { enabled: false } });
    let context: ExtensionContext | undefined;
    const runtimeErrors: unknown[] = [];
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        literatureToolsExtension,
        ...(options.codemode === false ? [] : [createCodemodeExtension({ mode: options.codemode ?? "on", models: false })]),
        pi => { pi.on("session_start", (_event, ctx) => { context = ctx; }); },
      ],
    });
    const manager = options.sessionManager ?? SessionManager.inMemory(directory);
    const create = async (reason: "startup" | "resume") => {
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      session = (await createAgentSession({
        cwd: directory, agentDir: directory, resourceLoader, settingsManager, sessionManager: manager,
        tools: options.tools, excludeTools: options.excludeTools, noTools: options.noTools,
        sessionStartEvent: { type: "session_start", reason },
      })).session;
      await session.bindExtensions({ onError: error => { runtimeErrors.push(error); } });
    };
    await create("startup");
    const fixture = {
      get session() { assert.ok(session); return session; },
      checkpoint: async () => {
        assert.ok(context);
        // Exercise the actual registered lifecycle handler with a real bound
        // context, without prompting a model or accessing provider credentials.
        const event = { type: "before_agent_start", prompt: "test" } as BeforeAgentStartEvent;
        for (const extension of resourceLoader.getExtensions().extensions) {
          for (const handler of extension.handlers.get("before_agent_start") ?? []) await handler(event, context);
        }
      },
      recreate: async () => {
        session?.dispose();
        await create("resume");
      },
    };
    await run(fixture);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
}

function selectedLiterature(session: Awaited<ReturnType<typeof createAgentSession>>["session"]) {
  return session.getActiveToolNames().filter(name => LITERATURE_TOOL_NAMES.some(tool => tool === name));
}

test("real Pi startup defaults to direct when codemode is absent or registered inactive", async () => {
  for (const codemode of [false, "on"] as const) {
    await withSession({ codemode }, async ({ session, checkpoint }) => {
      assert.deepEqual(selectedLiterature(session), [...LITERATURE_TOOL_NAMES]);
      for (const name of LITERATURE_TOOL_NAMES) assert.equal(session.getAllTools().find(tool => tool.name === name)?.exposure, "direct");
      const before = session.sessionManager.getBranch().length;
      await checkpoint();
      assert.equal(session.sessionManager.getBranch().length, before);
    });
  }
});

test("real Pi codemode on/only groups default literature tools without declaring them directly", async () => {
  for (const codemode of ["on", "only"] as const) {
    await withSession({ codemode, defaultTools: ["+codemode"] }, async ({ session }) => {
      assert.deepEqual(selectedLiterature(session), []);
      const definition = session.agent.state.tools.find(tool => tool.name === "codemode");
      assert.ok(definition);
      assert.match(definition.description, /literature/);
      assert.match(definition.description, /Search literature and retrieve open-access evidence/);
      assert.doesNotMatch(definition.description, /Retrieve Europe PMC full text only when requested/, "Long namespace guidance stays discoverable rather than inline");
      for (const name of LITERATURE_TOOL_NAMES) {
        const tool = session.getAllTools().find(tool => tool.name === name)!;
        assert.equal(tool.exposure, "codemode");
        assert.equal(tool.namespace?.name, "literature");
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.openWorldHint, true);
      }
    });
  }
});

test("explicit direct tools respect Pi's codemode on/only request projection", async () => {
  for (const codemode of ["on", "only"] as const) {
    await withSession({ codemode, defaultTools: ["+codemode", "+pubmed_search"] }, async ({ session }) => {
      assert.ok(session.getActiveToolNames().includes("pubmed_search"));
      assert.equal(session.getAllTools().find(tool => tool.name === "pubmed_search")?.exposure, "direct");
      assert.ok(session.agent.transformContext);
      const projected = await session.agent.transformContext([{
        role: "system", content: "test", timestamp: Date.now(),
        toolsAdded: session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      }]);
      const system = projected.find(message => message.role === "system");
      assert.ok(system?.role === "system");
      assert.equal(system.toolsAdded?.some(tool => tool.name === "pubmed_search") ?? false, codemode === "on");
      assert.ok(system.toolsAdded?.some(tool => tool.name === "codemode"));
    });
  }
});

test("real Pi CLI/SDK allowlists, exclusions, and no-tools remain authoritative", async () => {
  for (const options of [
    { tools: ["codemode"] },
    { tools: ["codemode", "pubmed_search"] },
    { tools: ["read", "pubmed_search"] },
    { noTools: "all" as const },
    { defaultTools: ["+codemode"], excludeTools: ["pubmed_search"] },
  ]) {
    await withSession(options, async ({ session, checkpoint }) => {
      await checkpoint();
      if (options.tools) assert.deepEqual(session.getActiveToolNames(), options.tools);
      if (options.noTools === "all") assert.deepEqual(session.getActiveToolNames(), []);
      if (options.excludeTools) assert.ok(!session.getAllTools().some(tool => tool.name === "pubmed_search"));
      if (options.tools?.includes("pubmed_search")) assert.equal(session.getAllTools().find(tool => tool.name === "pubmed_search")?.exposure, "direct");
    });
  }
});

test("negative settings remove a literature tool from codemode callability until explicitly reactivated", async () => {
  await withSession({ defaultTools: ["+codemode", "-pubmed_search"] }, async ({ session, checkpoint }) => {
    assert.ok(!session.getCallableToolNames().includes("pubmed_search"));
    assert.equal(session.getAllTools().find(tool => tool.name === "pubmed_search")?.exposure, "direct");
    session.setActiveToolsByName([...session.getActiveToolNames(), "pubmed_search"]);
    await checkpoint();
    assert.ok(session.getCallableToolNames().includes("pubmed_search"));
    assert.ok(session.getActiveToolNames().includes("pubmed_search"));
  });
});

test("real Pi activation changes take effect at the next boundary and preserve manual disables", async () => {
  await withSession({}, async ({ session, checkpoint }) => {
    const original = session.getActiveToolNames();
    session.setActiveToolsByName([...original.filter(name => name !== "pubmed_search"), "codemode"]);
    await checkpoint();
    assert.deepEqual(selectedLiterature(session), []);
    assert.equal(session.getAllTools().find(tool => tool.name === "pubmed_search")?.exposure, "direct");
    session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "codemode"));
    await checkpoint();
    assert.deepEqual(selectedLiterature(session), LITERATURE_TOOL_NAMES.filter(name => name !== "pubmed_search"));
    assert.deepEqual(session.getActiveToolNames().filter(name => !LITERATURE_TOOL_NAMES.some(tool => tool === name)), ["read", "bash", "edit", "write"]);
  });
});

test("real Pi reload and resume retain automatic defaults and last-minute manual exclusions", async () => {
  await withSession({}, async fixture => {
    fixture.session.setActiveToolsByName(fixture.session.getActiveToolNames().filter(name => name !== "zotero_search"));
    await fixture.session.reload();
    assert.ok(!fixture.session.getActiveToolNames().includes("zotero_search"));
    assert.ok(fixture.session.getActiveToolNames().includes("pubmed_search"));
    await fixture.checkpoint();
    await fixture.recreate();
    assert.ok(!fixture.session.getActiveToolNames().includes("zotero_search"));
    assert.ok(fixture.session.getActiveToolNames().includes("pubmed_search"));
    fixture.session.setActiveToolsByName([...fixture.session.getActiveToolNames(), "codemode"]);
    await fixture.checkpoint();
    assert.equal(fixture.session.getAllTools().find(tool => tool.name === "pubmed_search")?.exposure, "codemode");
  });
});

test("a CLI/SDK-named tool can be manually disabled across reload", async () => {
  await withSession({ tools: ["read", "codemode", "pubmed_search"] }, async ({ session, checkpoint }) => {
    session.setActiveToolsByName(["read", "codemode"]);
    await session.reload();
    assert.deepEqual(session.getActiveToolNames(), ["read", "codemode"]);
    await checkpoint();
    assert.deepEqual(session.getActiveToolNames(), ["read", "codemode"]);
  });
});

test("an unchanged +tool setting does not undo a manual disable on resume", async () => {
  await withSession({ defaultTools: ["+codemode", "+pubmed_search"] }, async fixture => {
    fixture.session.setActiveToolsByName(fixture.session.getActiveToolNames().filter(name => name !== "pubmed_search"));
    await fixture.checkpoint();
    await fixture.recreate();
    assert.ok(!fixture.session.getActiveToolNames().includes("pubmed_search"));
    assert.equal(fixture.session.getAllTools().find(tool => tool.name === "pubmed_search")?.exposure, "direct");
  });
});
