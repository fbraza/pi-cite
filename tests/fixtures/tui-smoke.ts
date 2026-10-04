import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen, TuiAltScreen, visibleWidth, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { createPubmedSearchTool } from "../../src/pubmed.ts";

// Spawned only by the PTY test. Provider HTTP is mocked; no model or credentials are used.
assert.ok(process.stdin.isTTY && process.stdout.isTTY);
const reportPath = process.argv[2];
const fullscreen = process.argv[3] === "fullscreen";
assert.ok(reportPath);
const terminal = new ProcessTerminal();
const ui = fullscreen ? new TuiAltScreen(terminal, false, dirname(reportPath), { mouse: false }) : new TuiMainScreen(terminal, false, dirname(reportPath));
const tool = createPubmedSearchTool();
initTheme("dark", false);
const component = new ToolExecutionComponent(tool.name, "pty", { query: "fixture" }, { showImages: false }, tool, ui, process.cwd());
const stages: Array<{ key: string; columns: number; raw: string; text: string }> = [];
let artifactPath: string | undefined;
let progressUpdates = 0;
let finished!: () => void;
const done = new Promise<void>(resolve => { finished = resolve; });
let failure: string | undefined;
const originalFetch = globalThis.fetch;
const rawBefore = Boolean(process.stdin.isRaw);
function report() {
  writeFileSync(reportPath, JSON.stringify({ stages, progressUpdates, artifactPath, rawBefore,
    rawAfter: Boolean(process.stdin.isRaw), failure, mode: ui.mode }));
}
function snapshot(key: string) {
  ui.renderNow(true);
  const lines = component.render(terminal.columns);
  assert.ok(lines.every(line => visibleWidth(line) <= terminal.columns));
  const raw = lines.join("\n");
  stages.push({ key, columns: terminal.columns, raw, text: stripTerminalSequences(raw) });
  report();
}
async function input(key: string) {
  try {
    if (key === "s") {
      const result = await tool.execute("pty", { query: "fixture" }, undefined, update => {
        progressUpdates++;
        component.updateResult({ ...update, isError: false }, true);
      });
      const details = result.details as { model_output?: { full_result_path: string } };
      artifactPath = details.model_output?.full_result_path;
      assert.ok(artifactPath);
      component.updateResult({ ...result, isError: false });
    } else if (key === "e") component.setExpanded(true);
    else if (key === "t") { initTheme("light", false); ui.invalidate(); }
    else if (key === "f") component.updateResult({ content: [{ type: "text", text: "HTTP 503: fixture failure" }], details: {}, isError: true });
    else if (key === "q") { finished(); return; }
    else return;
    snapshot(key);
  } catch (error) {
    failure = String(error);
    report();
    finished();
  }
}
const onResize = () => { if (terminal.columns === 32 && stages.at(-1)?.key !== "resize") snapshot("resize"); };
const interactive: Component = {
  render: width => component.render(width), invalidate: () => component.invalidate(), handleInput: key => { void input(key); },
};
try {
  delete process.env.NCBI_API_KEY;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "eutils.ncbi.nlm.nih.gov");
    if (url.pathname.endsWith("esearch.fcgi")) return Response.json({ esearchresult: { idlist: ["123"], count: "1" } });
    if (url.pathname.endsWith("efetch.fcgi")) return new Response(`<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article><ArticleTitle>Evidence 🧪界</ArticleTitle><Abstract><AbstractText>${"Complete evidence 🧪界. ".repeat(4000)}</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`);
    throw new Error("Unexpected network request");
  };
  component.markExecutionStarted();
  component.updateResult({ content: [{ type: "text", text: "Waiting for provider" }], details: {}, isError: false }, true);
  ui.addChild(interactive);
  ui.setFocus(interactive);
  process.stdout.on("resize", onResize);
  ui.start();
  assert.equal(process.stdin.isRaw, true, "ProcessTerminal must enter raw mode");
  snapshot("start");
  await done;
} finally {
  process.stdout.off("resize", onResize);
  ui.stop();
  globalThis.fetch = originalFetch;
  if (artifactPath) await rm(dirname(artifactPath), { recursive: true, force: true });
  report();
}
if (failure) throw new Error(failure);
