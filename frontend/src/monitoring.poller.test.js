import assert from "node:assert/strict";
import test from "node:test";
import { createMonitoringPoller } from "./monitoring.poller.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(sources) {
  const updates = [];
  const errors = [];
  const timers = new Map();
  let nextId = 0;
  const poller = createMonitoringPoller({
    sources,
    onData: (key, value) => updates.push({ key, value }),
    onError: (error) => errors.push(error),
    schedule: (callback, delay) => {
      timers.set(++nextId, { callback, delay });
      return nextId;
    },
    unschedule: (id) => timers.delete(id),
  });
  return { poller, updates, errors, timers };
}
const source = (fetch, intervalMs = 2000) => ({ fetch, intervalMs, label: "Metrics" });

test("live worker counts continue updating while history hangs and timings fail", async () => {
  const history = deferred();
  let running = 1;
  const f = fixture({
    overview: source(async () => ({ running })),
    history: source(() => history.promise, 5000),
    jobs: source(async () => { throw new Error("Timing endpoint unavailable"); }, 5000),
  });
  try {
    await flush();
    assert.deepEqual(f.updates, [{ key: "overview", value: { running: 1 } }]);
    assert.match(f.errors.at(-1), /Timing endpoint unavailable/);
    running = 0;
    const [timerId, timer] = [...f.timers].find(([, timer]) => timer.delay === 2000);
    f.timers.delete(timerId);
    timer.callback();
    await flush();
    assert.deepEqual(f.updates.at(-1), { key: "overview", value: { running: 0 } });
    assert.match(f.errors.at(-1), /Timing endpoint unavailable/);
  } finally { f.poller.stop(); }
});

test("manual refresh cannot overlap a pending request or roll back newer state", async () => {
  const pending = deferred();
  let calls = 0;
  const f = fixture({ overview: source(() => ++calls === 1 ? pending.promise : Promise.resolve("finished")) });
  try {
    f.poller.refresh();
    f.poller.refresh();
    assert.equal(calls, 1);
    pending.resolve("running");
    await flush();
    f.poller.refresh();
    await flush();
    assert.equal(calls, 2);
    assert.deepEqual(f.updates.map(({ value }) => value), ["running", "finished"]);
  } finally { f.poller.stop(); }
});

test("a timed-out request retries and ignores its late result", async () => {
  const pending = deferred();
  let calls = 0;
  let firstSignal;
  const f = fixture({ overview: source((signal) => {
    if (++calls === 1) { firstSignal = signal; return pending.promise; }
    return Promise.resolve("fresh");
  }) });
  try {
    [...f.timers.values()].find((timer) => timer.delay === 10_000).callback();
    await flush();
    assert.equal(firstSignal.aborted, true);
    assert.match(f.errors.at(-1), /Request timed out/);
    f.poller.refresh();
    await flush();
    pending.resolve("stale");
    await flush();
    assert.deepEqual(f.updates, [{ key: "overview", value: "fresh" }]);
    assert.equal(f.errors.at(-1), null);
  } finally { f.poller.stop(); }
});

test("unmount aborts requests and prevents old callbacks and timers after remount", async () => {
  const pending = deferred();
  let signal;
  const old = fixture({ overview: source((nextSignal) => {
    signal = nextSignal;
    return pending.promise;
  }) });
  old.poller.stop();
  assert.equal(signal.aborted, true);
  assert.equal(old.timers.size, 0);
  const fresh = fixture({ overview: source(async () => "new session") });
  try {
    pending.resolve("old session");
    old.poller.refresh();
    await flush();
    assert.deepEqual(old.updates, []);
    assert.deepEqual(old.errors, []);
    assert.equal(old.timers.size, 0);
    assert.deepEqual(fresh.updates, [{ key: "overview", value: "new session" }]);
  } finally { fresh.poller.stop(); }
});
