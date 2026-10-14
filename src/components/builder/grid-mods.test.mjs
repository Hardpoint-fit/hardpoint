// MODIFY GRID's pure side: writing results into overrides, wording the engine's answer, and asking again
// as the fit changes (fake timers, a scripted engine).
import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURES } from "../../lib/engine/stub-engine.mjs";
import { budgetNote, createGridModsFetcher, currentAnswer, kindOf, resultLabel, targetsOf, withCellSlot } from "./grid-mods.ts";

const consumable = (name) => FIXTURES.catalog.gridConsumables.find((entry) => entry.name === name);

test("withCellSlot sets, rewrites and drops a cell's override, keeping them listed by cell", () => {
  const layout = ["None", "Core", "Battery", "None"];
  const none = [];
  const added = withCellSlot(layout, none, 3, "Core");
  assert.deepEqual(added, [{ cell: 3, slotType: "Core" }]);
  const both = withCellSlot(layout, added, 1, "Subsystem");
  assert.deepEqual(both, [{ cell: 1, slotType: "Subsystem" }, { cell: 3, slotType: "Core" }]);
  assert.deepEqual(withCellSlot(layout, both, 3, "Propulsion"), [{ cell: 1, slotType: "Subsystem" }, { cell: 3, slotType: "Propulsion" }]);
  assert.deepEqual(withCellSlot(layout, both, 1, "Core"), [{ cell: 3, slotType: "Core" }], "back to the layout: no override");
  assert.equal(withCellSlot(layout, both, 3, "Core"), both, "no change: the same array");
  assert.equal(withCellSlot(layout, both, 4, "Core"), both, "off the grid");
  assert.equal(withCellSlot(layout, both, 1.5, "Core"), both);
});

test("the panel words each consumable's kind and what the caps leave", () => {
  const budget = { expansions: 1, maxExpansions: 2, convertersSpent: ["Battery"] };
  assert.equal(kindOf(consumable("BROKKR SLOT")), "extender");
  assert.equal(kindOf(consumable("SKULD OMEN")), "skuld");
  assert.equal(kindOf(consumable("ANDVARI COIL")), "converter");
  assert.equal(budgetNote(consumable("BROKKR SLOT"), budget), "1 OF 2 LEFT");
  assert.equal(budgetNote(consumable("BROKKR SLOT"), { ...budget, expansions: 2 }), "0 OF 2 LEFT");
  assert.equal(budgetNote(consumable("ANDVARI COIL"), budget), "SPENT");
  assert.equal(budgetNote(consumable("EITRI ARC"), budget), "1 OF 1 LEFT");
  assert.equal(budgetNote(consumable("SKULD OMEN"), budget), "NO LIMIT");
});

test("a SKULD outcome names what it does to the hardpoint, or which side gets the Core", () => {
  const cols = 15;
  const target = 97;
  assert.equal(resultLabel({ cell: target, slotType: "None" }, target, cols), "DESTROY THE HARDPOINT");
  assert.equal(resultLabel({ cell: target, slotType: "Subsystem" }, target, cols), "RETYPE TO SUBSYSTEM");
  assert.equal(resultLabel({ cell: target - cols, slotType: "Core" }, target, cols), "ADD A CORE SLOT ABOVE");
  assert.equal(resultLabel({ cell: target + 1, slotType: "Core" }, target, cols), "ADD A CORE SLOT TO THE RIGHT");
});

test("targetsOf reads one consumable's cells from the answer", () => {
  const skuld = targetsOf(FIXTURES.gridMods, consumable("SKULD OMEN").def);
  assert.deepEqual([...skuld.keys()], [97]);
  assert.equal(skuld.get(97).results.length, 3);
  assert.equal(targetsOf(null, consumable("SKULD OMEN").def).size, 0);
  assert.equal(targetsOf(FIXTURES.gridMods, "1").size, 0);
});

function fakeTimers() {
  const pending = new Map();
  let next = 0;
  return {
    timers: {
      setTimeout: (run) => {
        pending.set(++next, run);
        return next;
      },
      clearTimeout: (handle) => pending.delete(handle),
    },
    async flush() {
      const runs = [...pending.values()];
      pending.clear();
      for (const run of runs) await run();
    },
    get count() {
      return pending.size;
    },
  };
}

test("the fetcher asks once per settled fit, drops a superseded question and keeps answers to their fit", async () => {
  const clock = fakeTimers();
  const asked = [];
  const states = [];
  const fetcher = createGridModsFetcher({
    ask: async (fit, signal) => {
      asked.push({ fit, signal });
      return { ok: true, value: { ...FIXTURES.gridMods, buildSha: String(fit.modules.length) } };
    },
    onChange: (state) => states.push(state),
    timers: clock.timers,
  });
  const fit = FIXTURES.fit;
  const edited = { ...fit, modules: fit.modules.slice(1) };

  fetcher.request(fit);
  fetcher.request(edited); // within the delay: only the newest is asked
  assert.equal(clock.count, 1);
  await clock.flush();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].fit, edited);
  const ready = states.at(-1);
  assert.equal(ready.status, "ready");
  assert.equal(currentAnswer(ready, edited).buildSha, String(edited.modules.length));
  assert.equal(currentAnswer(ready, fit), null, "an answer is only its own fit's");

  // Asking again about the answered fit doesn't go to the engine.
  fetcher.request(edited);
  assert.equal(clock.count, 0);
  assert.equal(states.at(-1).status, "ready");

  // Closing MODIFY GRID stops asking.
  fetcher.request(fit);
  fetcher.request(null);
  assert.equal(clock.count, 0);
  assert.deepEqual(states.at(-1), { status: "idle" });
  fetcher.dispose();
});

test("an engine error is kept with the last answer; a cancelled question says nothing", async () => {
  const clock = fakeTimers();
  const states = [];
  let answer = { ok: false, error: { kind: "rejected", message: "version: expected 1" } };
  const fetcher = createGridModsFetcher({ ask: async () => answer, onChange: (state) => states.push(state), timers: clock.timers });
  fetcher.request(FIXTURES.fit);
  await clock.flush();
  assert.equal(states.at(-1).status, "error");
  assert.equal(states.at(-1).message, "version: expected 1");
  assert.equal(currentAnswer(states.at(-1), FIXTURES.fit), null);

  answer = { ok: false, error: { kind: "cancelled", message: "" } };
  const before = states.length;
  fetcher.request({ ...FIXTURES.fit, ammo: [] });
  await clock.flush();
  assert.equal(states.length, before + 1, "only the loading state");
  assert.equal(states.at(-1).status, "loading");
  fetcher.dispose();
});
