import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURES } from "./stub-engine.mjs";
import { catalogFacts, createFactsLoader, isPlainestRoll } from "./item-facts.ts";

const ROLLED = FIXTURES.itemFactsRequest.item;
const PLAIN = { ...ROLLED, roll: { ...ROLLED.roll, rarity: "Normal", modifiers: [] } };
const CATALOG = { facts: [{ label: "DEFAULT", value: "1", unit: null, tone: "Neutral" }], rarity: "Normal" };
const with_ = (value) => ({ ...ROLLED, roll: { ...ROLLED.roll, modifiers: [{ ...ROLLED.roll.modifiers[0], value: String(value) }] } });

function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (run, ms) => {
      pending.set(next, { at: now + ms, run });
      return next++;
    },
    clearTimeout: (handle) => pending.delete(handle),
    async advance(ms) {
      now += ms;
      for (const [handle, entry] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at > now) continue;
        pending.delete(handle);
        entry.run();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** A fetch whose answers the test hands out. */
function engine() {
  const calls = [];
  return {
    calls,
    fetchFacts: (item, signal) =>
      new Promise((resolve) => {
        calls.push({ item, signal, resolve });
        signal.addEventListener("abort", () => resolve({ ok: false, error: { kind: "cancelled", message: "" } }));
      }),
  };
}
test("the plainest roll is at the item's lowest rarity, as the engine's default roll is", () => {
  // An item whose lowest rarity isn't Normal: its catalog facts are read at that rarity.
  const harmonic = { ...PLAIN, roll: { ...PLAIN.roll, rarity: "Harmonic" } };
  assert.equal(isPlainestRoll(harmonic, "Harmonic"), true);
  assert.equal(isPlainestRoll(PLAIN, "Harmonic"), false);
  // The catalog lists rarities lowest first.
  for (const item of FIXTURES.catalog.items) assert.equal(catalogFacts(item).rarity, item.roll.rarities[0]);
  assert.deepEqual(catalogFacts({ facts: CATALOG.facts, roll: { rarities: ["Harmonic", "Heretical"] } }), { facts: CATALOG.facts, rarity: "Harmonic" });
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the plainest roll is the catalog's and is never asked about", async () => {
  assert.equal(isPlainestRoll(PLAIN, "Normal"), true);
  assert.equal(isPlainestRoll(ROLLED, "Normal"), false);
  assert.equal(isPlainestRoll({ ...PLAIN, roll: { ...PLAIN.roll, quality: "Superior" } }, "Normal"), false);
  assert.equal(isPlainestRoll({ ...PLAIN, patina: 3 }, "Normal"), false);
  const timers = fakeTimers();
  const fake = engine();
  const loader = createFactsLoader({ fetchFacts: fake.fetchFacts, timers });
  loader.request(PLAIN, CATALOG);
  await timers.advance(1000);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(loader.state(PLAIN, CATALOG), { status: "default", facts: CATALOG.facts });
});

test("a rolled item shows the catalog's facts while loading, then the engine's; edits are debounced", async () => {
  const timers = fakeTimers();
  const fake = engine();
  const loader = createFactsLoader({ fetchFacts: fake.fetchFacts, timers });
  let changes = 0;
  loader.subscribe(() => changes++);
  loader.request(with_(60000), CATALOG);
  await timers.advance(100);
  loader.request(with_(61000), CATALOG);
  await timers.advance(100);
  loader.request(ROLLED, CATALOG);
  assert.deepEqual(loader.state(ROLLED, CATALOG), { status: "loading", facts: CATALOG.facts });
  await timers.advance(249);
  assert.equal(fake.calls.length, 0, "still within the 250 ms");
  await timers.advance(1);
  assert.equal(fake.calls.length, 1, "one ask, the newest");
  assert.deepEqual(fake.calls[0].item, ROLLED);
  fake.calls[0].resolve({ ok: true, value: FIXTURES.itemFacts });
  await settle();
  assert.deepEqual(loader.state(ROLLED, CATALOG), { status: "ready", facts: FIXTURES.itemFacts.facts });
  assert.ok(changes > 0);
  // The older edits are still waiting: they go next, one at a time, newest first.
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1].item, with_(61000));
  loader.release(with_(60000));
  fake.calls[1].resolve({ ok: true, value: { facts: [] } });
  await settle();
  assert.equal(fake.calls.length, 2, "a released ask is never sent");
  // Known answers are not asked again.
  loader.request(ROLLED, CATALOG);
  await timers.advance(1000);
  assert.equal(fake.calls.length, 2);
});

test("a refusal is final; an outage isn't cached; a 429 waits for Retry-After", async () => {
  const timers = fakeTimers();
  const fake = engine();
  const loader = createFactsLoader({ fetchFacts: fake.fetchFacts, timers });
  loader.request(ROLLED, CATALOG);
  await timers.advance(250);
  fake.calls[0].resolve({ ok: false, error: { kind: "rateLimited", message: "", retryAfterMs: 3000 } });
  await settle();
  assert.equal(loader.state(ROLLED, CATALOG).status, "limited");
  loader.request(with_(60000), CATALOG);
  await timers.advance(2999);
  assert.equal(fake.calls.length, 1, "held until Retry-After");
  await timers.advance(1);
  assert.equal(fake.calls.length, 2);
  fake.calls[1].resolve({ ok: false, error: { kind: "unavailable", message: "" } });
  await settle();
  assert.equal(loader.state(with_(60000), CATALOG).status, "down");
  // The other ask still waits behind it and goes next.
  assert.equal(fake.calls.length, 3);
  fake.calls[2].resolve({ ok: false, error: { kind: "rejected", message: "rarity: Artifact can't roll on this item" } });
  await settle();
  assert.deepEqual(loader.state(ROLLED, CATALOG), { status: "refused", facts: CATALOG.facts });
  // The outage isn't remembered: asking again asks the engine.
  loader.request(with_(60000), CATALOG);
  assert.equal(loader.state(with_(60000), CATALOG).status, "loading");
  await timers.advance(250);
  assert.equal(fake.calls.length, 4);
});

test("dispose aborts the ask in flight and drops the rest", async () => {
  const timers = fakeTimers();
  const fake = engine();
  const loader = createFactsLoader({ fetchFacts: fake.fetchFacts, timers });
  loader.request(ROLLED, CATALOG);
  loader.request(with_(60000), CATALOG);
  await timers.advance(250);
  assert.equal(fake.calls.length, 1);
  loader.dispose();
  assert.equal(fake.calls[0].signal.aborted, true);
  await timers.advance(1000);
  assert.equal(fake.calls.length, 1);
});
