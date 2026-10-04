import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { LITERATURE_TOOL_NAMES } from "../src/tool-metadata.ts";

const exec = promisify(execFile);
const unpack = `
import os, sys, tarfile
with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive.getmembers():
        assert member.name.startswith("package/") and ".." not in member.name.split("/")
        if member.isdir(): continue
        assert member.isfile(), "The package should contain files, not links"
        path = os.path.join(sys.argv[2], member.name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with archive.extractfile(member) as source, open(path, "wb") as target:
            target.write(source.read())
`;

test("actual release tarball loads its extension and skill through Pi with host-supplied modules", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cite-package-"));
  const originalFetch = globalThis.fetch;
  let session: AgentSession | undefined;
  try {
    globalThis.fetch = async () => { throw new Error("Unexpected network access during package discovery"); };
    const packed = await exec(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--json", "--offline", "--ignore-scripts", "--pack-destination", directory], {
      cwd: process.cwd(), timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    const source = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(join(process.cwd(), "package-lock.json"), "utf8"));
    const packedData = JSON.parse(packed.stdout);
    // npm 12 keys results by package name; earlier npm releases return an array.
    const manifest = (Array.isArray(packedData) ? packedData[0] : packedData[source.name]) as { filename: string; version: string; files: Array<{ path: string }> };
    assert.equal(manifest.version, source.version);
    assert.equal(lock.version, source.version);
    assert.equal(lock.packages[""].version, source.version);
    assert.ok(manifest.files.every(file => !/^(tests\/|node_modules\/|PLAN\.md$|tsconfig\.json$)/.test(file.path)));
    await exec("python3", ["-c", unpack, join(directory, manifest.filename), directory], { timeout: 10_000 });
    const root = join(directory, "package");
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.equal(pkg.version, manifest.version);
    assert.deepEqual(pkg.peerDependencies, source.peerDependencies);
    assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
    assert.deepEqual(pkg.pi.skills, ["./skills"]);
    assert.equal(pkg.dependencies, undefined, "Host modules must not be bundled as runtime dependencies");
    assert.ok((await readFile(join(root, "skills/literature/references/codemode-workflows.md"), "utf8")).includes("Promise.allSettled"));
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [root],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.equal(resourceLoader.getSkills().skills.length, 1);
    assert.equal(resourceLoader.getSkills().skills[0].name, "literature");
    assert.deepEqual(resourceLoader.getSkills().diagnostics, []);
    session = (await createAgentSession({ cwd: directory, agentDir: directory, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(directory) })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "print", onError: error => { errors.push(error); } });
    assert.deepEqual(session.getActiveToolNames().filter(name => LITERATURE_TOOL_NAMES.some(tool => tool === name)), [...LITERATURE_TOOL_NAMES]);
    globalThis.fetch = async input => {
      assert.equal(new URL(String(input)).hostname, "eutils.ncbi.nlm.nih.gov");
      return Response.json({ esearchresult: { idlist: [], count: "0" } });
    };
    const tool = session.agent.state.tools.find(tool => tool.name === "pubmed_search");
    assert.ok(tool);
    const result = await tool.execute("package", { query: "archive", fetch_abstracts: false });
    assert.deepEqual(result.structuredContent, { count: 0, papers: [], query: "archive" });
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
