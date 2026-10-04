import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { sleep } from "../src/shared.ts";

test("sleep without a signal resolves only after its delay", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let completed = false;
  const pending = sleep(100).then(value => { completed = true; return value; });
  t.mock.timers.tick(99);
  await Promise.resolve();
  assert.equal(completed, false);
  t.mock.timers.tick(1);
  assert.equal(await pending, undefined);
  assert.equal(completed, true);
});

test("completed sleeps remove their abort listeners when reusing a signal, preserving other listeners", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const existingListener = () => {};
  controller.signal.addEventListener("abort", existingListener);
  for (let i = 0; i < 3; i++) {
    const pending = sleep(1, controller.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 2);
    t.mock.timers.tick(1);
    await pending;
    assert.deepEqual(getEventListeners(controller.signal, "abort"), [existingListener]);
  }
  controller.signal.removeEventListener("abort", existingListener);
});

test("aborting a pending sleep clears its timer and listener and preserves the rejection contract", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearTimeoutMock = t.mock.method(globalThis, "clearTimeout");
  const controller = new AbortController();
  const pending = sleep(60_000, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  const rejection = assert.rejects(pending, { name: "Error", message: "Request aborted" });
  controller.abort(new Error("custom abort reason"));
  await rejection;
  assert.equal(clearTimeoutMock.mock.callCount(), 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  t.mock.timers.runAll();
});

test("sleep rejects a pre-aborted signal without scheduling a timer or attaching a listener", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const setTimeoutMock = t.mock.method(globalThis, "setTimeout");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sleep(60_000, controller.signal), { name: "Error", message: "Request aborted" });
  assert.equal(setTimeoutMock.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("aborting after a completed sleep leaves no sleep listener attached", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const pending = sleep(1, controller.signal);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
