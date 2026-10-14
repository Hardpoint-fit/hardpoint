// RANDOMIZE ROLL against the stub engine: what the builder offers dice for, and each outcome of a roll.
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createEngineClient } from "../../lib/engine/client.ts";
import { PublicConfigProvider } from "../../lib/public-config.tsx";
import { FIXTURES, deadEngineUrl, startStubEngine } from "../../lib/engine/stub-engine.mjs";
import { Inspector } from "./inspector.tsx";
import { ROLL_MESSAGES, breachTiers, canRandomize, defaultBreachTier, randomize } from "./randomize.ts";
import { indexCatalog, moduleSubject } from "./rules.ts";
import { initialState, reduce } from "./state.ts";
import { richCatalog } from "./test-catalog.mjs";

const catalog = richCatalog();
const cat = indexCatalog(catalog);
const augmented = FIXTURES.fit.modules[0].item;
const normal = FIXTURES.fit.modules[1].item;
const highest = catalog.breachTiers.at(-1).index;

let stub;
let engine;
before(async () => {
  stub = await startStubEngine();
  engine = createEngineClient({ baseUrl: stub.url });
});
after(() => stub.close());
beforeEach(() => {
  stub.fail(null);
  stub.requests.length = 0;
});

test("the breach tiers come from the catalog, the highest by default; an older catalog has none", () => {
  assert.deepEqual(breachTiers(catalog), catalog.breachTiers);
  assert.equal(defaultBreachTier(catalog), highest);
  const { breachTiers: _, ...older } = catalog;
  assert.deepEqual(breachTiers(older), []);
  assert.equal(defaultBreachTier(older), null);
});

test("dice are offered for an Augmented or Prototype roll with a pool, and not for Normal or templated rolls", () => {
  const subject = moduleSubject(cat, augmented.def);
  assert.equal(canRandomize(cat, subject, augmented), true);
  assert.equal(canRandomize(cat, subject, { ...augmented, roll: { ...augmented.roll, rarity: "Prototype" } }), true);
  assert.equal(canRandomize(cat, subject, { ...augmented, roll: { ...augmented.roll, rarity: "Normal", modifiers: [] } }), false);
  const regalia = FIXTURES.fit.modules[11].item;
  assert.equal(canRandomize(cat, moduleSubject(cat, regalia.def), regalia), false);
  const { breachTiers: _, ...older } = catalog;
  assert.equal(canRandomize(indexCatalog(older), subject, augmented), false, "an engine without the roll route offers no dice");
});

test("a roll asks the engine at the chosen tier and comes back as a roll edit the reducer applies", async () => {
  const outcome = await randomize(engine, augmented, { breachTier: highest });
  assert.equal(outcome.ok, true);
  assert.deepEqual(stub.requests.at(-1).body, { item: augmented, breachTier: highest });
  assert.equal(outcome.breachTier, highest);
  assert.equal(typeof outcome.seed, "number");
  assert.deepEqual(outcome.edit, { kind: "rolled", def: augmented.def, sent: augmented.roll, rolled: { ...augmented.roll, modifiers: FIXTURES.roll.item.roll.modifiers } });

  const state = reduce(cat, initialState(FIXTURES.fit), { type: "roll", target: 0, edit: outcome.edit });
  assert.deepEqual(state.fit.modules[0].item.roll.modifiers, FIXTURES.roll.item.roll.modifiers);
  assert.equal(state.revision, 1);
});

test("a line's dice ask for that line alone", async () => {
  const rolled = FIXTURES.rollLineRequest.item;
  const outcome = await randomize(engine, rolled, { breachTier: 3, line: 0 });
  assert.equal(outcome.ok, true);
  assert.deepEqual(stub.requests.at(-1).body, { item: rolled, breachTier: 3, line: 0 });
  assert.deepEqual(outcome.edit.rolled.modifiers.slice(1), rolled.roll.modifiers.slice(1));
  assert.notDeepEqual(outcome.edit.rolled.modifiers[0], rolled.roll.modifiers[0]);
});

test("a refused, rate-limited, cancelled or unanswered roll says so and edits nothing", async () => {
  assert.deepEqual(await randomize(engine, normal, { breachTier: highest }), { ok: false, message: ROLL_MESSAGES.rejected });
  stub.fail(429);
  assert.deepEqual(await randomize(engine, augmented, { breachTier: highest }), { ok: false, message: ROLL_MESSAGES.rateLimited });
  stub.fail(500);
  assert.deepEqual(await randomize(engine, augmented, { breachTier: highest }), { ok: false, message: ROLL_MESSAGES.unavailable });
  stub.fail(null);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await randomize(engine, augmented, { breachTier: highest, signal: controller.signal }), { ok: false, message: null });
  const down = createEngineClient({ baseUrl: await deadEngineUrl() });
  assert.deepEqual(await randomize(down, augmented, { breachTier: highest }), { ok: false, message: ROLL_MESSAGES.unavailable });
});

test("the inspector shows RANDOMIZE ROLL, the breach tier at the highest, and a die per line, only where the engine can roll", () => {
  const render = (target, { roller } = { roller: engine }, fit = FIXTURES.fit) => renderToStaticMarkup(h(PublicConfigProvider, { config: { apiUrl: stub.url, authEnabled: false } }, h(Inspector, { cat, fit, target, dispatch: () => {}, roller })));
  const html = render(0);
  assert.match(html, />RANDOMIZE ROLL</);
  assert.match(html, /BREACH TIER/);
  assert.match(html, new RegExp(`<option value="${highest}" selected="">${catalog.breachTiers.at(-1).name.toUpperCase()}</option>`));
  assert.equal((html.match(/aria-label="Re-roll /g) ?? []).length, augmented.roll.modifiers.length);
  assert.doesNotMatch(render(1), /RANDOMIZE ROLL|Re-roll/, "a Normal module has no dice");
  assert.doesNotMatch(render(11), /RANDOMIZE ROLL|Re-roll/, "a regalia piece has no dice");
  assert.doesNotMatch(render(0, {}), /RANDOMIZE ROLL|Re-roll/, "no roller, no dice");
});
