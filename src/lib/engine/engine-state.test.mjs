import assert from "node:assert/strict";
import test from "node:test";
import { createEngineMonitor } from "./engine-state.ts";

function fakeHealth(answers) {
  const calls = [];
  return {
    calls,
    status: async () => {
      calls.push(1);
      const next = answers.shift();
      return next ? { ok: true, value: { build: next } } : { ok: false, error: { kind: "unavailable", message: "down" } };
    },
  };
}

test("an answer is held for the ttl, then checked again", async () => {
  let clock = 0;
  const engine = fakeHealth(["aaa", "bbb"]);
  const monitor = createEngineMonitor(engine, { ttlMs: 1000, now: () => clock });
  assert.deepEqual(await monitor.current(), { status: "up", buildSha: "aaa" });
  assert.deepEqual(await monitor.current(), { status: "up", buildSha: "aaa" });
  assert.equal(engine.calls.length, 1);
  clock = 1000;
  assert.deepEqual(await monitor.current(), { status: "up", buildSha: "bbb" });
  assert.equal(engine.calls.length, 2);
});

test("down keeps the build the engine last reported; never seen is null", async () => {
  let clock = 0;
  const engine = fakeHealth([null, "aaa", null]);
  const monitor = createEngineMonitor(engine, { ttlMs: 10, now: () => clock });
  assert.deepEqual(await monitor.current(), { status: "down", buildSha: null });
  clock = 10;
  assert.deepEqual(await monitor.current(), { status: "up", buildSha: "aaa" });
  clock = 20;
  assert.deepEqual(await monitor.current(), { status: "down", buildSha: "aaa" });
});

test("concurrent pages share one status check", async () => {
  const engine = fakeHealth(["aaa"]);
  const monitor = createEngineMonitor(engine);
  const [a, b] = await Promise.all([monitor.current(), monitor.current()]);
  assert.deepEqual(a, b);
  assert.equal(engine.calls.length, 1);
});
