import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createRequestGate, retryDelayMs } from "../src/request-gate.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("request gates serialize complete operations in FIFO order and recover after failure", async () => {
  const gate = createRequestGate();
  const started = deferred();
  const finish = deferred();
  const order: number[] = [];
  let active = 0;
  let maximum = 0;
  const first = gate.run(async () => { active++; maximum = Math.max(maximum, active); order.push(1); started.resolve(); await finish.promise; active--; return 1; });
  await started.promise;
  const second = gate.run(async () => { active++; maximum = Math.max(maximum, active); order.push(2); active--; throw new Error("provider failure"); });
  const third = gate.run(async () => { active++; maximum = Math.max(maximum, active); order.push(3); active--; return 3; });
  assert.deepEqual(order, [1]);
  const settled = Promise.allSettled([first, second, third]);
  finish.resolve();
  const result = await settled;
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(maximum, 1);
  assert.deepEqual(result.map(item => item.status), ["fulfilled", "rejected", "fulfilled"]);
});

test("queued cancellation rejects promptly, does not invoke the operation, and does not release another call's slot", async () => {
  const gate = createRequestGate();
  const finish = deferred();
  const started = deferred();
  const first = gate.run(async () => { started.resolve(); await finish.promise; });
  await started.promise;
  const controller = new AbortController();
  let invoked = false;
  const cancelled = gate.run(async () => { invoked = true; }, { signal: controller.signal });
  const rejection = assert.rejects(cancelled, /Request aborted/);
  let thirdStarted = false;
  const third = gate.run(async () => { thirdStarted = true; });
  controller.abort();
  await rejection;
  assert.equal(invoked, false);
  assert.equal(thirdStarted, false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  finish.resolve();
  await Promise.all([first, third]);
  assert.equal(thirdStarted, true);
});

test("spacing applies across different intervals and a new backoff extends the shared deadline", async () => {
  const gate = createRequestGate();
  let first = 0;
  await gate.run(async () => { first = Date.now(); }, { interval: 5 });
  let second = 0;
  await gate.run(async () => { second = Date.now(); gate.defer(20); }, { interval: 15 });
  let third = 0;
  await gate.run(async () => { third = Date.now(); }, { interval: 0 });
  assert.ok(second - first >= 15);
  assert.ok(third - second >= 20);
});

test("aborting during a shared backoff never sends a request and cleans timer listeners", async () => {
  const gate = createRequestGate();
  gate.defer(60_000);
  const controller = new AbortController();
  let invoked = false;
  const pending = gate.run(async () => { invoked = true; }, { signal: controller.signal });
  const rejection = assert.rejects(pending, /Request aborted/);
  // Let the resolved predecessor hand control to the abortable timer.
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort();
  await rejection;
  assert.equal(invoked, false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("pre-aborted and in-flight-cancelled calls cannot return success", async () => {
  const gate = createRequestGate();
  const pre = new AbortController();
  pre.abort();
  let invoked = false;
  await assert.rejects(gate.run(async () => { invoked = true; }, { signal: pre.signal }), /Request aborted/);
  assert.equal(invoked, false);
  const controller = new AbortController();
  await assert.rejects(gate.run(async () => { controller.abort(); return "not a success"; }, { signal: controller.signal }), /Request aborted/);
  assert.equal(await gate.run(async () => "next call"), "next call");
});

test("Retry-After parsing accepts seconds and HTTP-dates, ignores invalid/past values", () => {
  const now = Date.parse("2025-01-01T00:00:00Z");
  assert.equal(retryDelayMs("2", now), 2000);
  assert.equal(retryDelayMs("Wed, 01 Jan 2025 00:00:03 GMT", now), 3000);
  for (const value of [null, "", "garbage", "-1", "Tue, 31 Dec 2024 23:59:59 GMT"]) assert.equal(retryDelayMs(value, now), 0);
  const gate = createRequestGate();
  for (const value of [Number.NaN, Infinity, -1]) gate.defer(value);
});
