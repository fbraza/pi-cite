import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
// Drive genuine ProcessTerminal keyboard input and SIGWINCH, not a fake requestRender object.
const drivePty = `
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
def resize(columns):
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, columns, 0, 0))
resize(120)
child = subprocess.Popen([sys.argv[1], "--experimental-strip-types", sys.argv[2], sys.argv[3], sys.argv[4]], stdin=slave, stdout=slave, stderr=slave)
output = bytearray()
deadline = time.monotonic() + 15
def drain():
    if select.select([master], [], [], 0.02)[0]:
        try: output.extend(os.read(master, 65536))
        except OSError: pass
def wait_stage(count):
    while time.monotonic() < deadline:
        drain()
        try:
            with open(sys.argv[3]) as handle: report = json.load(handle)
            if report.get("failure"): raise RuntimeError(report["failure"])
            if len(report["stages"]) >= count: return
        except (FileNotFoundError, json.JSONDecodeError): pass
        if child.poll() is not None: raise RuntimeError(output.decode("utf8", "replace"))
    raise TimeoutError(output.decode("utf8", "replace"))
try:
    wait_stage(1)
    for count, key in enumerate([b"s", b"e", b"t"], 2):
        os.write(master, key)
        wait_stage(count)
    resize(32)
    os.kill(child.pid, signal.SIGWINCH)
    wait_stage(5)
    os.write(master, b"f")
    wait_stage(6)
    os.write(master, b"q")
    while child.poll() is None and time.monotonic() < deadline: drain()
    if child.poll() is None: raise TimeoutError("Terminal fixture did not stop")
    drain()
    if child.returncode != 0: raise RuntimeError(output.decode("utf8", "replace"))
    print(json.dumps({"output": output.decode("utf8", "replace")}))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
    os.close(slave)
`;

for (const mode of ["regular", "fullscreen"] as const) {
  test(`PTY ${mode}: keyboard expansion, artifact notice, resize, theme, failure, and terminal cleanup`, {
    timeout: 25_000, skip: process.platform === "win32" ? "POSIX PTY smoke; component tests remain portable" : false,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cite-pty-"));
    try {
      const path = join(directory, "report.json");
      const result = await exec("python3", ["-c", drivePty, process.execPath, join(process.cwd(), "tests/fixtures/tui-smoke.ts"), path, mode], {
        timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TMPDIR: directory, TMP: directory, TEMP: directory },
      });
      const report = JSON.parse(await readFile(path, "utf8")) as {
        stages: Array<{ key: string; columns: number; text: string; raw: string }>;
        rawBefore: boolean; rawAfter: boolean; failure?: string; progressUpdates: number; mode: string;
      };
      assert.equal(report.failure, undefined);
      assert.equal(report.mode, mode);
      assert.equal(report.rawBefore, false);
      assert.equal(report.rawAfter, false, "ProcessTerminal must restore raw mode on shutdown");
      assert.ok(report.progressUpdates >= 2);
      assert.deepEqual(report.stages.map(stage => stage.key), ["start", "s", "e", "t", "resize", "f"]);
      assert.match(report.stages[0].text, /Waiting for provider/);
      assert.doesNotMatch(report.stages[0].text, /✓/);
      assert.match(report.stages[1].text, /model preview truncated/);
      assert.match(report.stages[2].text, /complete JSON:/);
      assert.match(report.stages[2].text, /result\.json/);
      assert.match(report.stages[2].text, /Evidence 🧪界/);
      assert.equal(report.stages[3].columns, 120);
      assert.notEqual(report.stages[2].raw, report.stages[3].raw, "Theme invalidation must refresh ANSI colors at the same width");
      assert.equal(report.stages[4].columns, 32);
      assert.match(report.stages[5].text, /failed/);
      assert.match(report.stages[5].text, /HTTP 503/);
      assert.doesNotMatch(report.stages[5].text, /✓/);
      const output = (JSON.parse(result.stdout) as { output: string }).output;
      assert.match(output, /\u001b\[/, "The real TUI must produce ANSI terminal frames");
      assert.match(output, /HTTP 503/);
      if (mode === "fullscreen") {
        assert.ok(output.includes("\x1b[?1049h"));
        assert.ok(output.includes("\x1b[?1049l"), "Alternate screen must be restored");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
