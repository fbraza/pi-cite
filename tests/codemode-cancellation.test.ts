import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import literatureToolsExtension from "../src/index.ts";

// Abort only after the actual nested HTTP operation starts, not after a guessed VM startup delay.
test("real codemode propagates cancellation, preserves partial output, and releases the provider lane", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cite-cancellation-"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.NCBI_API_KEY;
  const abortCode = 'text("before cancellation"); await tools.pubmed_search({ query: "wait" });';
  const recoveryCode = 'return await tools.pubmed_search({ query: "recovered", fetch_abstracts: false });';
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  let session: AgentSession | undefined;
  const ends: ToolExecutionEndEvent[] = [];
  const controller = new AbortController();
  let requests = 0;
  try {
    process.env.NCBI_API_KEY = "test-key";
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, "eutils.ncbi.nlm.nih.gov");
      requests++;
      if (url.searchParams.get("term") !== "wait")
        return Response.json({ esearchresult: { idlist: [], count: "0" } });
      const signal = options?.signal;
      assert.ok(signal, "The nested provider must receive a cancellation signal");
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new Error("Fixture HTTP aborted"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        started();
      });
    };
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"], retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [literatureToolsExtension, createCodemodeExtension({ models: false }), pi => {
        pi.on("tool_execution_end", event => { ends.push(event); });
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const manager = SessionManager.inMemory(directory);
    manager.appendMessage({
      role: "assistant", content: [
        { type: "toolCall", id: "abort", name: "codemode", arguments: { code: abortCode } },
        { type: "toolCall", id: "recover", name: "codemode", arguments: { code: recoveryCode } },
      ], api: "openai-completions", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    session = (await createAgentSession({ cwd: directory, agentDir: directory, settingsManager, resourceLoader, sessionManager: manager })).session;
    const runtimeErrors: unknown[] = [];
    await session.bindExtensions({ mode: "print", onError: error => { runtimeErrors.push(error); } });
    const codemode = session.agent.state.tools.find(tool => tool.name === "codemode");
    assert.ok(codemode);
    const pending = codemode.execute("abort", { code: abortCode }, controller.signal);
    await Promise.race([requestStarted, pending.then(result => { throw new Error(`Script ended before HTTP started: ${JSON.stringify(result.content)}`); })]);
    controller.abort();
    const aborted = await pending;
    assert.equal(aborted.isError, true);
    assert.match(aborted.content.filter(block => block.type === "text").map(block => block.text).join("\n"), /before cancellation/);
    const calls = (aborted.details as { calls: Array<{ status: string }> }).calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, "cancelled");
    assert.ok(ends.some(event => event.parentToolCallId === "abort" && event.isError));
    const recovered = await codemode.execute("recover", { code: recoveryCode });
    assert.equal(recovered.isError, undefined, JSON.stringify(recovered.content));
    assert.equal(requests, 2, "Cancellation must release the shared lane without retrying the aborted request");
    assert.ok(ends.some(event => event.parentToolCallId === "recover" && !event.isError));
    assert.deepEqual(runtimeErrors, []);
    assert.equal(session.messages.length, 1);
  } finally {
    controller.abort();
    session?.dispose();
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NCBI_API_KEY; else process.env.NCBI_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});
