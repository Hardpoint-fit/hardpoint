// Live evaluation: 150 ms debounce, stale requests aborted and their answers dropped, and an engine
// that is down reported without blocking edits (Review Focus #4).
import assert from "node:assert/strict";
import test from "node:test";
import { createEngineClient } from "../../lib/engine/client.ts";
import { FIXTURES, deadEngineUrl, startStubEngine } from "../../lib/engine/stub-engine.mjs";
import { EVALUATION_DELAY_MS, createLiveEvaluator, fitKey } from "./live-evaluation.ts";
import { indexCatalog } from "./rules.ts";
import { initialState, reduce } from "./state.ts";
import { SCARAB } from "./test-catalog.mjs";

/** Manual timers: `tick(ms)` runs what is due. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (run, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    tick(ms) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) {
          pending.delete(id);
          timer.run();
        }
      }
    },
    get size() {
      return pending.size;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const fit = (n) => ({ ...FIXTURES.fit, progression: { ...FIXTURES.fit.progression, affinityXp: n } });

function harness(answer) {
  const timers = fakeTimers();
  const calls = [];
  const states = [];
  const evaluator = createLiveEvaluator({
    timers,
    onChange: (state) => states.push(state),
    evaluate: (sent, signal) => {
      const call = { fit: sent, signal, resolve: null };
      calls.push(call);
      return answer ? answer(sent, signal) : new Promise((resolve) => (call.resolve = resolve));
    },
  });
  return { timers, calls, states, evaluator };
}

const ok = (response = FIXTURES.evaluateValid) => ({ ok: true, value: response });

test("changes within 150 ms make one request, for the last fit", async () => {
  const { timers, calls, evaluator } = harness(async () => ok());
  evaluator.request(fit(1));
  timers.tick(100);
  evaluator.request(fit(2));
  timers.tick(100);
  evaluator.request(fit(3));
  assert.equal(evaluator.current().status, "waiting");
  timers.tick(EVALUATION_DELAY_MS - 1);
  assert.equal(calls.length, 0);
  timers.tick(1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fit.progression.affinityXp, 3);
  await settle();
  assert.equal(evaluator.current().status, "ready");
  assert.equal(evaluator.current().result.key, fitKey(fit(3)));
});

test("a newer change aborts the request in flight and its late answer is dropped", async () => {
  const { timers, calls, evaluator } = harness();
  evaluator.request(fit(1));
  timers.tick(EVALUATION_DELAY_MS);
  assert.equal(evaluator.current().status, "checking");
  evaluator.request(fit(2));
  assert.equal(calls[0].signal.aborted, true, "the stale request is cancelled");
  calls[0].resolve(ok({ ...FIXTURES.evaluateValid, rating: 1 }));
  await settle();
  assert.notEqual(evaluator.current().status, "ready", "the old fit's answer is not shown");
  timers.tick(EVALUATION_DELAY_MS);
  calls[1].resolve(ok());
  await settle();
  assert.equal(evaluator.current().result.key, fitKey(fit(2)));
  assert.equal(evaluator.current().result.response.rating, FIXTURES.evaluateValid.rating);
});

test("asking again for the fit already answered doesn't call the engine", async () => {
  const { timers, calls, evaluator } = harness(async () => ok());
  evaluator.request(fit(1));
  timers.tick(EVALUATION_DELAY_MS);
  await settle();
  evaluator.request(fit(1));
  assert.equal(evaluator.current().status, "ready");
  assert.equal(timers.size, 0);
  assert.equal(calls.length, 1);
});

test("an engine that is down is reported, keeps the last answer, and recovers", async () => {
  let up = false;
  const { timers, evaluator } = harness(async () => (up ? ok() : { ok: false, error: { kind: "unavailable", message: "The loadout engine can't be reached." } }));
  evaluator.request(fit(1));
  timers.tick(EVALUATION_DELAY_MS);
  await settle();
  assert.equal(evaluator.current().status, "down");
  assert.equal(evaluator.current().message, "The loadout engine can't be reached.");
  assert.equal(evaluator.current().engineDown, true);
  up = true;
  evaluator.request(fit(2));
  assert.equal(evaluator.current().engineDown, true, "still down while the retry waits");
  timers.tick(EVALUATION_DELAY_MS);
  await settle();
  assert.equal(evaluator.current().status, "ready");
  assert.equal(evaluator.current().engineDown, false);
});

test("a fit the engine can't read is 'rejected' with its message; dispose stops everything", async () => {
  const { timers, evaluator, states } = harness(async () => ({ ok: false, error: { kind: "rejected", message: "Fit has no hull." } }));
  evaluator.request(fit(1));
  timers.tick(EVALUATION_DELAY_MS);
  await settle();
  assert.deepEqual([evaluator.current().status, evaluator.current().message], ["rejected", "Fit has no hull."]);
  evaluator.request(fit(2));
  evaluator.dispose();
  const seen = states.length;
  timers.tick(EVALUATION_DELAY_MS);
  await settle();
  assert.equal(states.length, seen);
  evaluator.request(null);
});

test("with a real client: a dead engine reads as down while the reducer keeps editing (Review Focus #4)", async () => {
  const cat = indexCatalog(FIXTURES.catalog);
  const client = createEngineClient({ baseUrl: await deadEngineUrl() });
  const evaluator = createLiveEvaluator({ onChange() {}, delayMs: 0, evaluate: (sent, signal) => client.evaluate(sent, { signal }) });
  let state = reduce(cat, initialState(), { type: "start", hull: SCARAB });
  evaluator.request(state.fit);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(evaluator.current().status, "down");
  state = reduce(cat, reduce(cat, reduce(cat, state, { type: "pickUp", def: FIXTURES.catalog.items[2].def }), { type: "hover", cell: { row: 3, col: 6 } }), { type: "drop" });
  assert.equal(state.fit.modules.length, 1, "editing still works");
  evaluator.dispose();
});

test("with the stub engine: the request is aborted on the wire, and the answer arrives", async () => {
  const stub = await startStubEngine();
  try {
    const client = createEngineClient({ baseUrl: stub.url });
    const controller = new AbortController();
    const pending = client.evaluate(FIXTURES.fit, { signal: controller.signal });
    controller.abort();
    assert.deepEqual((await pending).error?.kind, "cancelled");
    const evaluator = createLiveEvaluator({ onChange() {}, delayMs: 0, evaluate: (sent, signal) => client.evaluate(sent, { signal }) });
    evaluator.request(FIXTURES.fit);
    for (let i = 0; i < 50 && evaluator.current().status !== "ready"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(evaluator.current().result.response.valid, true);
    evaluator.dispose();
  } finally {
    await stub.close();
  }
});
