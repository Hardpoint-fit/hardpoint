// Live evaluation: 150 ms debounce, stale requests aborted and their answers dropped, and an engine
// that is down reported without blocking edits (Review Focus #4).
import assert from "node:assert/strict";
import test from "node:test";
import { createEngineClient } from "../../lib/engine/client.ts";
import { FIXTURES, deadEngineUrl, startStubEngine } from "../../lib/engine/stub-engine.mjs";
import { EVALUATION_DELAY_MS, RETRY_MS, createLiveEvaluator, fitKey } from "./live-evaluation.ts";
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

test("changes while a request is in flight queue; only the newest is sent, when the answer arrives", async () => {
  const { timers, calls, evaluator, states } = harness();
  evaluator.request(fit(1));
  timers.tick(EVALUATION_DELAY_MS);
  assert.equal(evaluator.current().status, "checking");
  evaluator.request(fit(2));
  evaluator.request(fit(3));
  timers.tick(EVALUATION_DELAY_MS * 4);
  assert.equal(calls.length, 1, "no second request while one is out");
  assert.equal(calls[0].signal.aborted, false, "the request in flight isn't cancelled");
  calls[0].resolve(ok({ ...FIXTURES.evaluateValid, rating: 1 }));
  await settle();
  assert.equal(calls.length, 2, "the newest change goes as soon as the answer arrives");
  assert.equal(calls[1].fit.progression.affinityXp, 3, "fit 2 was skipped");
  assert.equal(evaluator.current().status, "checking");
  assert.equal(evaluator.current().result.key, fitKey(fit(1)), "the older answer is kept, keyed to its fit");
  calls[1].resolve(ok());
  await settle();
  assert.equal(evaluator.current().status, "ready");
  assert.equal(evaluator.current().result.key, fitKey(fit(3)));
  assert.ok(states.every((state) => state.status !== "down"));
});

test("a 429 pauses checks, says so, and retries the newest fit after Retry-After (else 5 s)", async () => {
  const { timers, calls, evaluator } = harness();
  evaluator.request(fit(1));
  timers.tick(EVALUATION_DELAY_MS);
  calls[0].resolve({ ok: false, error: { kind: "rateLimited", message: "Too many requests.", retryAfterMs: 2000 } });
  await settle();
  assert.deepEqual([evaluator.current().status, evaluator.current().outage], ["paused", "limited"]);
  evaluator.request(fit(2));
  timers.tick(EVALUATION_DELAY_MS);
  assert.equal(calls.length, 1, "an edit doesn't jump the pause");
  timers.tick(2000 - EVALUATION_DELAY_MS - 1);
  assert.equal(calls.length, 1);
  timers.tick(1);
  assert.equal(calls.length, 2, "retried after Retry-After");
  assert.equal(calls[1].fit.progression.affinityXp, 2, "with the newest fit");
  assert.equal(evaluator.current().outage, "limited", "still shown as paused while the retry runs");
  calls[1].resolve({ ok: false, error: { kind: "rateLimited", message: "Too many requests." } });
  await settle();
  timers.tick(RETRY_MS - 1);
  assert.equal(calls.length, 2);
  timers.tick(1);
  assert.equal(calls.length, 3, "no Retry-After: 5 s");
  calls[2].resolve(ok());
  await settle();
  assert.deepEqual([evaluator.current().status, evaluator.current().outage], ["ready", null]);
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

test("an engine that is down is reported, keeps the last answer, and is retried every 5 s", async () => {
  let up = false;
  const { timers, calls, evaluator } = harness(async () => (up ? ok() : { ok: false, error: { kind: "unavailable", message: "The game data API can't be reached." } }));
  evaluator.request(fit(1));
  timers.tick(EVALUATION_DELAY_MS);
  await settle();
  assert.equal(evaluator.current().status, "down");
  assert.equal(evaluator.current().message, "The game data API can't be reached.");
  assert.equal(evaluator.current().outage, "down");
  timers.tick(RETRY_MS);
  await settle();
  assert.equal(calls.length, 2, "retried on its own");
  up = true;
  evaluator.request(fit(2));
  assert.equal(evaluator.current().outage, "down", "still down while the retry waits");
  timers.tick(RETRY_MS);
  await settle();
  assert.equal(calls[2].fit.progression.affinityXp, 2);
  assert.deepEqual([evaluator.current().status, evaluator.current().outage], ["ready", null]);
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

test("a fit too large for the engine is final: not sent again until it changes", async () => {
  const { timers, calls, evaluator } = harness(async (sent) =>
    sent.progression.affinityXp === 1 ? { ok: false, error: { kind: "tooLarge", message: "That fit is too large for the engine." } } : ok(),
  );
  evaluator.request(fit(1));
  timers.tick(EVALUATION_DELAY_MS);
  await settle();
  assert.equal(evaluator.current().status, "tooLarge");
  assert.equal(timers.size, 0, "no retry is scheduled");
  timers.tick(60_000);
  evaluator.request(fit(1));
  timers.tick(60_000);
  await settle();
  assert.equal(calls.length, 1, "the same fit isn't sent again");
  evaluator.request(fit(2));
  timers.tick(EVALUATION_DELAY_MS);
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(evaluator.current().status, "ready");
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
