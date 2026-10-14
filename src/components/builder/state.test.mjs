// The builder reducer: every edit action, on the recorded catalog (SCARAB, 14 items).
import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURES } from "../../lib/engine/stub-engine.mjs";
import { addableModifiers, indexCatalog, moduleSubject } from "./rules.ts";
import { EMPTY_META, initialState, newFit, reduce } from "./state.ts";

import { SCARAB, SERAPH, itemNamed, richCatalog } from "./test-catalog.mjs";

const catalog = richCatalog();
const cat = indexCatalog(catalog);
const item = (name) => itemNamed(catalog, name);
const TURRET = item("OMNI REPAIRER TURRET").def;
const HEATSINK = item("HEATSINK MAGAZINE").def;
const COOLANT = item("COOLANT RESERVOIR").def;
const TRACER = item("TRACER ROUNDS").def;
const CONDUIT = item("PROPULSION CONDUIT").def;

const run = (state, ...actions) => actions.reduce((current, action) => reduce(cat, current, action), state);
const started = () => run(initialState(), { type: "start", hull: SCARAB });
/** A fit with one module put down at (row, col) by the drag path: pick up, hover, drop. */
const withModule = (def, row, col, state = started()) => run(state, { type: "pickUp", def }, { type: "hover", cell: { row, col } }, { type: "drop" });

test("start makes a new fit on the hull with a default roll; reset goes back to the hull picker", () => {
  const state = started();
  assert.equal(state.fit.hull.def, SCARAB);
  assert.equal(state.fit.version, 1);
  assert.deepEqual(state.fit.modules, []);
  assert.equal(state.fit.hull.roll.quality, "Standard");
  assert.equal(state.fit.hull.roll.rarity, "Normal");
  assert.equal(state.fit.progression.affinityXp, 0);
  assert.equal(state.revision, 1);
  assert.equal(run(initialState(), { type: "start", hull: "999" }).fit, null, "an unknown hull starts nothing");
  const reset = run(state, { type: "reset" });
  assert.equal(reset.fit, null);
});

test("load replaces the fit and meta and clears the selection", () => {
  const meta = { title: "Brawler", description: "d", tags: ["pvp"] };
  const state = run(started(), { type: "select", target: "hull" }, { type: "load", fit: FIXTURES.fit, meta });
  assert.equal(state.fit, FIXTURES.fit);
  assert.deepEqual(state.meta, meta);
  assert.equal(state.selected, null);
});

test("pick up, hover and drop places a palette item with its default roll and first ammo, then selects it", () => {
  const state = withModule(TURRET, 3, 6);
  assert.equal(state.fit.modules.length, 1);
  const [module] = state.fit.modules;
  assert.deepEqual({ def: module.item.def, row: module.row, col: module.col, rotation: module.rotation }, { def: TURRET, row: 3, col: 6, rotation: 0 });
  assert.equal(module.item.roll.rarity, "Normal");
  assert.deepEqual(state.fit.ammo, [{ moduleIndex: 0, ammoType: "ArmorRepairCharge" }]);
  assert.equal(state.selected, 0);
  assert.equal(state.held, null);
});

test("a drop that doesn't fit (overlap, disabled cell, outside) changes nothing and keeps the item in hand", () => {
  const one = withModule(HEATSINK, 4, 6);
  const overlap = run(one, { type: "pickUp", def: TURRET }, { type: "hover", cell: { row: 5, col: 7 } }, { type: "drop" });
  assert.equal(overlap.fit, one.fit);
  assert.ok(overlap.held, "still held");
  const disabled = run(started(), { type: "pickUp", def: HEATSINK }, { type: "hover", cell: { row: 11, col: 7 } }, { type: "drop" });
  assert.equal(disabled.fit.modules.length, 0);
  const outside = run(started(), { type: "pickUp", def: HEATSINK }, { type: "hover", cell: { row: 14, col: 14 } }, { type: "drop" });
  assert.equal(outside.fit.modules.length, 0);
  assert.equal(run(outside, { type: "cancel" }).held, null, "cancel drops the held item");
  assert.equal(run(outside, { type: "cancel" }, { type: "cancel" }).selected, null, "a second cancel clears the selection");
});

test("a drop off a matching hardpoint changes nothing: ARMOR HARDENER stays in hand until it is over a subsystem hardpoint", () => {
  const HARDENER = item("ARMOR HARDENER").def;
  const held = run(started(), { type: "pickUp", def: HARDENER }, { type: "hover", cell: { row: 4, col: 6 } });
  const refused = run(held, { type: "drop" });
  assert.equal(refused.fit, held.fit, "the fit is the same object");
  assert.equal(refused.revision, held.revision);
  assert.ok(refused.held, "still held");
  const released = run(held, { type: "release" });
  assert.equal(released.fit, held.fit, "a released illegal drop goes back to the palette");
  assert.equal(released.held, null);
  // Over (5,6) (6,6) (7,6) it covers the subsystem hardpoint at (7,6).
  const placed = run(refused, { type: "hover", cell: { row: 5, col: 6 } }, { type: "drop" });
  assert.equal(placed.fit.modules.length, 1);
  assert.equal(placed.held, null);
  // Turning a fitted one in place where the turn would leave the hardpoint takes it in hand instead.
  const turned = run(placed, { type: "select", target: 0 }, { type: "pickUpModule", index: 0 }, { type: "rotate" }, { type: "hover", cell: { row: 6, col: 6 } }, { type: "drop" });
  assert.equal(turned.fit, placed.fit, "turned along row 6 it covers no subsystem hardpoint");
  assert.ok(turned.held);
});

test("release puts the item down where it fits and back where it came from otherwise", () => {
  const one = withModule(HEATSINK, 4, 6);
  const back = run(one, { type: "pickUpModule", index: 0 }, { type: "hover", cell: { row: 14, col: 14 } }, { type: "release" });
  assert.equal(back.held, null);
  assert.equal(back.fit, one.fit, "the module stays where it was");
  const moved = run(one, { type: "pickUpModule", index: 0 }, { type: "hover", cell: { row: 7, col: 8 } }, { type: "release" });
  assert.deepEqual([moved.fit.modules[0].row, moved.fit.modules[0].col], [7, 8]);
});

test("rotate turns the held item; R on a selected module turns it in place when it fits there", () => {
  const held = run(started(), { type: "pickUp", def: HEATSINK }, { type: "rotate" }, { type: "rotate" });
  assert.equal(held.held.rotation, 2);
  const placed = withModule(HEATSINK, 4, 6);
  const turned = run(placed, { type: "rotate" });
  assert.equal(turned.fit.modules[0].rotation, 1);
  assert.equal(turned.held, null);
  // At (10,6) the L fits only unturned (row 11 has one enabled cell): turning takes it in hand instead.
  const low = withModule(HEATSINK, 9, 7);
  assert.equal(low.fit.modules.length, 1);
  const lowTurned = run(low, { type: "rotate" }, { type: "rotate" });
  assert.ok(lowTurned.held || lowTurned.fit.modules[0].rotation !== 0);
});

test("a fitted module moves by the cell it was grabbed by, keeping its index", () => {
  const two = withModule(TURRET, 3, 8, withModule(HEATSINK, 4, 6));
  const moved = run(two, { type: "pickUpModule", index: 0, cell: { row: 5, col: 7 } }, { type: "hover", cell: { row: 7, col: 8 } }, { type: "drop" });
  assert.deepEqual([moved.fit.modules[0].row, moved.fit.modules[0].col], [6, 7]);
  assert.equal(moved.fit.modules[1].item.def, TURRET, "indices are unchanged");
  assert.equal(moved.selected, 0);
});

test("keyboard placement: the cursor starts on the first open cell and moves by whole cells", () => {
  const state = run(started(), { type: "pickUp", def: TURRET, cursor: null }, { type: "moveCursor", rows: 0, cols: 0 });
  assert.deepEqual(state.held.cursor, { row: 3, col: 6 });
  const placed = run(state, { type: "moveCursor", rows: 0, cols: 2 }, { type: "drop" });
  assert.deepEqual([placed.fit.modules[0].row, placed.fit.modules[0].col], [3, 8]);
  const clamped = run(started(), { type: "pickUp", def: TURRET, cursor: { row: 0, col: 0 } }, { type: "moveCursor", rows: -3, cols: -3 });
  assert.deepEqual(clamped.held.cursor, { row: 0, col: 0 });
});

test("remove takes the module out, drops its ammo and renumbers later ammo", () => {
  const two = withModule(TURRET, 3, 8, withModule(TURRET, 3, 6));
  assert.deepEqual(two.fit.ammo.map((ammo) => ammo.moduleIndex), [0, 1]);
  const removed = run(two, { type: "remove", index: 0 });
  assert.equal(removed.fit.modules.length, 1);
  assert.deepEqual(removed.fit.ammo, [{ moduleIndex: 0, ammoType: "ArmorRepairCharge" }]);
  assert.equal(removed.selected, null);
  assert.equal(run(removed, { type: "remove", index: 5 }), removed, "no such module: nothing changes");
});

test("select takes the hull or a module that exists", () => {
  const state = withModule(TURRET, 3, 6);
  assert.equal(run(state, { type: "select", target: "hull" }).selected, "hull");
  assert.equal(run(state, { type: "select", target: 4 }).selected, 0, "a missing module isn't selected");
  assert.equal(run(state, { type: "select", target: null }).selected, null);
});

test("changeHull keeps modules and ammo, resets the hull roll and drops slot overrides", () => {
  const loaded = run(initialState(), { type: "load", fit: FIXTURES.fit });
  const changed = run(loaded, { type: "changeHull", hull: SERAPH });
  assert.equal(changed.fit.hull.def, SERAPH);
  assert.equal(changed.fit.modules.length, FIXTURES.fit.modules.length);
  assert.deepEqual(changed.fit.ammo, FIXTURES.fit.ammo);
  assert.deepEqual(changed.fit.slotOverrides, []);
});

test("roll edits go through the rules: rarity fills its modifier count, an illegal edit changes nothing", () => {
  const state = withModule(COOLANT, 4, 6);
  const augmented = run(state, { type: "roll", target: 0, edit: { kind: "rarity", rarity: "Augmented" } });
  const roll = augmented.fit.modules[0].item.roll;
  assert.equal(roll.rarity, "Augmented");
  assert.equal(roll.modifiers.length, 1, "Augmented holds 1 to 2: filled to 1");
  assert.ok(augmented.revision > state.revision);
  const refused = run(state, { type: "roll", target: 0, edit: { kind: "rarity", rarity: "Artifact" } });
  assert.equal(refused, state, "COOLANT RESERVOIR has no artifact");
  const hull = run(state, { type: "roll", target: "hull", edit: { kind: "quality", quality: "Masterwork" } });
  assert.equal(hull.fit.hull.roll.quality, "Masterwork");
});

test("every roll edit kind reaches the roll", () => {
  let state = withModule(TRACER, 4, 6);
  const roll = () => state.fit.modules[0].item.roll;
  const edit = (e) => (state = run(state, { type: "roll", target: 0, edit: e }));
  edit({ kind: "rarity", rarity: "Prototype" });
  assert.equal(roll().modifiers.length, 2);
  const [next] = addableModifiers(cat, moduleSubject(cat, TRACER), roll());
  edit({ kind: "addModifier", stat: next.entry.stat, operation: next.entry.operation, slot: next.slot });
  assert.equal(roll().modifiers.length, 3);
  assert.equal(roll().modifiers[2].tier, Math.max(...next.entry.tiers.filter((t) => t.allowed).map((t) => t.tier)), "a new line takes its best allowed tier");
  edit({ kind: "modifierTier", index: 2, tier: 1 });
  assert.equal(roll().modifiers[2].tier, 1);
  edit({ kind: "modifierValue", index: 2, value: 0 });
  assert.equal(roll().modifiers[2].value, next.entry.tiers.find((t) => t.tier === 1).min, "clamped to the tier's minimum");
  edit({ kind: "fractured", index: 2, on: true });
  assert.equal(roll().modifiers[2].isFractured, true);
  edit({ kind: "removeModifier", index: 2 });
  assert.equal(roll().modifiers.length, 2);
  edit({ kind: "port", row: 2, col: 2, direction: "Up" });
  assert.equal(roll().ports.length, 1);
  edit({ kind: "cipher", index: 0, cipher: catalog.ciphers[0].def });
  assert.equal(roll().ports[0].cipher, catalog.ciphers[0].def);
  edit({ kind: "mirrored", on: true });
  assert.equal(roll().isMirrored, true);
  edit({ kind: "typeOverride", type: "Drone" });
  assert.equal(roll().moduleTypeOverride, "Drone", "the recorded catalog's heretical specials are for drones");
  edit({ kind: "rarity", rarity: "Heretical" });
  assert.equal(roll().rarity, "Heretical");
  assert.equal(roll().modifiers.filter((m) => m.isInverted).length, 1, "a Heretical item has exactly one inverted line");
  const other = roll().modifiers.findIndex((m) => !m.isInverted && !m.isFractured);
  edit({ kind: "inverted", index: other });
  assert.equal(roll().modifiers[other].isInverted, true);
  assert.equal(roll().modifiers.filter((m) => m.isInverted).length, 1);
});

test("artifact and regalia take their template; harmonic takes its set's ciphers; patina follows the artifact", () => {
  let state = withModule(TRACER, 4, 6);
  const roll = () => state.fit.modules[0].item.roll;
  const edit = (e) => (state = run(state, { type: "roll", target: 0, edit: e }));
  const artifact = catalog.artifacts.find((a) => a.item === TRACER);
  edit({ kind: "rarity", rarity: "Artifact" });
  assert.equal(roll().artifact, artifact.def);
  assert.deepEqual(roll().modifiers.map((m) => [m.stat, m.operation, m.tier, m.slot]), artifact.modifiers.map((l) => [l.stat, l.operation, l.tier, 0]));
  assert.equal(roll().scaledStat.rule, artifact.scaledStat.rule);
  edit({ kind: "scaledStrength", value: Number.MAX_SAFE_INTEGER });
  assert.equal(roll().scaledStat.strength, String(Math.max(Number(artifact.scaledStat.min), Number(artifact.scaledStat.max))), "clamped to the template's range");
  state = run(state, { type: "patina", target: 0, value: 2 });
  assert.equal(state.fit.modules[0].item.patina, 2);
  assert.equal(run(state, { type: "patina", target: 0, value: 3 }), state, "over the cap");
  edit({ kind: "rarity", rarity: "Regalia" });
  assert.equal(roll().regalia, catalog.regalia.find((r) => r.item === TRACER).def);
  assert.equal(roll().artifact, null);
  assert.equal(state.fit.modules[0].item.patina, 0, "patina goes with the artifact");

  let coolant = withModule(COOLANT, 4, 6);
  coolant = run(coolant, { type: "roll", target: 0, edit: { kind: "rarity", rarity: "Harmonic" } });
  const harmonic = coolant.fit.modules[0].item.roll;
  const set = catalog.harmonicSets.find((s) => s.def === harmonic.harmonicSet);
  assert.equal(harmonic.isHarmonized, true);
  assert.deepEqual(harmonic.ports.map((p) => p.cipher), set.ciphers);
  assert.deepEqual(harmonic.modifiers, []);
  const other = catalog.harmonicSets.find((s) => s.def !== set.def);
  coolant = run(coolant, { type: "roll", target: 0, edit: { kind: "harmonicSet", def: other.def } });
  assert.deepEqual(coolant.fit.modules[0].item.roll.ports.map((p) => p.cipher), other.ciphers, "ports follow the set's cipher count");
});

test("patina only goes up to the artifact's cap; a grant roll applies its quality and rarity bare", () => {
  const state = withModule(TURRET, 3, 6);
  assert.equal(run(state, { type: "patina", target: 0, value: 1 }), state, "no artifact, no patina");
  const armor = item("ARMOR HARDENER");
  const grant = armor.roll.authored[0];
  const placed = withModule(armor.def, 7, 6);
  const index = placed.fit.modules.length - 1;
  const granted = run(placed, { type: "roll", target: index, edit: { kind: "grant", quality: grant.quality, rarity: grant.rarity } });
  assert.equal(granted.fit.modules[index].item.roll.quality, grant.quality);
  assert.equal(granted.fit.modules[index].item.roll.modifiers.length, 0);
});

test("ammo is set from the turret's payloads, cleared with null, and refused otherwise", () => {
  const state = withModule(TURRET, 3, 6);
  const cleared = run(state, { type: "ammo", index: 0, ammoType: null });
  assert.deepEqual(cleared.fit.ammo, []);
  const set = run(cleared, { type: "ammo", index: 0, ammoType: "ArmorRepairCharge" });
  assert.deepEqual(set.fit.ammo, [{ moduleIndex: 0, ammoType: "ArmorRepairCharge" }]);
  assert.equal(run(set, { type: "ammo", index: 0, ammoType: "Nonsense" }), set);
  const conduit = withModule(CONDUIT, 7, 9);
  assert.equal(run(conduit, { type: "ammo", index: 0, ammoType: "ArmorRepairCharge" }), conduit, "no payloads");
});

test("affinity: level, points within the limits, and threshold choices that need the points", () => {
  const affinity = catalog.affinity;
  const turret = affinity.types.find((type) => type.moduleType === "Turret");
  let state = run(started(), { type: "level", level: 30 });
  assert.equal(state.fit.progression.affinityXp, affinity.levelXp[29]);
  for (let i = 0; i < 20; i++) state = run(state, { type: "allocate", moduleType: "Turret", option: 0, delta: 1 });
  const slot = 1 * 4 + 0; // ModuleType.Turret = 1, four options per type
  assert.equal(state.fit.progression.allocatedPoints[slot], affinity.maxPointsPerBonus, "a bonus stops at its cap");
  const tier = turret.thresholds.find((each) => each.choices.length > 1);
  const chosen = run(state, { type: "threshold", moduleType: "Turret", tier: tier.tier, choice: 1 });
  assert.equal(chosen.fit.progression.thresholdSelections[1 * 8 + tier.tier], 1);
  // Dropping to level 1 takes points back, and the threshold the points no longer reach is cleared.
  const low = run(chosen, { type: "level", level: 1 });
  assert.equal(low.fit.progression.allocatedPoints.reduce((a, b) => a + b, 0), 1);
  assert.equal(low.fit.progression.thresholdSelections[1 * 8 + tier.tier] ?? 255, 255);
  const back = run(low, { type: "allocate", moduleType: "Turret", option: 0, delta: -1 });
  assert.deepEqual(back.fit.progression.allocatedPoints, []);
  const none = run(started(), { type: "threshold", moduleType: "Turret", tier: tier.tier, choice: 0 });
  assert.deepEqual(none.fit.progression.thresholdSelections, [], "not enough points");
});

test("meta edits don't count as fit changes", () => {
  const state = started();
  const next = run(state, { type: "meta", patch: { title: "Scarab brawler", tags: ["pvp"] } });
  assert.deepEqual(next.meta, { ...EMPTY_META, title: "Scarab brawler", tags: ["pvp"] });
  assert.equal(next.revision, state.revision);
});

test("newFit refuses an unknown hull", () => {
  assert.equal(newFit(cat, "1"), null);
  assert.ok(newFit(cat, SCARAB));
});

// MODIFY GRID: the engine's grid-mods answer for fit.json (SCARAB) names the cells; the reducer writes them.
const gridOption = (name) => {
  const def = catalog.gridConsumables.find((entry) => entry.name === name).def;
  return FIXTURES.gridMods.consumables.find((option) => option.def === def);
};

test("modifyCell writes a grid consumable's result into the slot overrides, listed by cell", () => {
  const loaded = run(initialState(), { type: "load", fit: FIXTURES.fit });
  const extender = gridOption("BROKKR SLOT").targets.at(-1).results[0];
  const converter = gridOption("ANDVARI COIL").targets.find((target) => target.cell !== 0).results[0];
  const state = run(loaded, { type: "modifyCell", ...extender }, { type: "modifyCell", ...converter });
  const cells = state.fit.slotOverrides.map((entry) => entry.cell);
  assert.deepEqual(cells, [...cells].sort((a, b) => a - b));
  assert.deepEqual(state.fit.slotOverrides, [...FIXTURES.fit.slotOverrides, converter, extender].sort((a, b) => a.cell - b.cell));
  assert.equal(state.revision, loaded.revision + 2);
  // A converted cell that is already an override (cell 0's added Core) is rewritten, not listed twice.
  const onAdded = run(state, { type: "modifyCell", cell: 0, slotType: "Battery" });
  assert.deepEqual(onAdded.fit.slotOverrides.filter((entry) => entry.cell === 0), [{ cell: 0, slotType: "Battery" }]);
  // SKULD's destroyed hardpoint is an override to None.
  const skuld = gridOption("SKULD OMEN").targets[0];
  const destroyed = run(loaded, { type: "modifyCell", cell: skuld.cell, slotType: "None" });
  assert.ok(destroyed.fit.slotOverrides.some((entry) => entry.cell === skuld.cell && entry.slotType === "None"));
});

test("modifyCell ignores a cell off the grid and a result the cell already has", () => {
  const loaded = run(initialState(), { type: "load", fit: FIXTURES.fit });
  assert.equal(run(loaded, { type: "modifyCell", cell: 15 * 15, slotType: "Core" }), loaded);
  assert.equal(run(loaded, { type: "modifyCell", cell: -1, slotType: "Core" }), loaded);
  assert.equal(run(loaded, { type: "modifyCell", cell: 0, slotType: "Core" }), loaded, "cell 0 is already an added Core");
  assert.equal(run(initialState(), { type: "modifyCell", cell: 0, slotType: "Core" }).fit, null);
});

test("revertCell puts a modified cell back as the hull has it, and leaves an unmodified one alone", () => {
  const loaded = run(initialState(), { type: "load", fit: FIXTURES.fit });
  const reverted = run(loaded, { type: "revertCell", cell: 0 });
  assert.deepEqual(reverted.fit.slotOverrides, []);
  assert.equal(reverted.revision, loaded.revision + 1);
  assert.equal(run(reverted, { type: "revertCell", cell: 0 }), reverted);
  const unmodified = gridOption("ANDVARI COIL").targets.find((target) => target.cell !== 0).cell;
  assert.equal(run(loaded, { type: "revertCell", cell: unmodified }), loaded);
  // Setting a cell to its layout type is the same as reverting it.
  const converted = run(loaded, { type: "modifyCell", cell: unmodified, slotType: "Battery" });
  assert.deepEqual(run(converted, { type: "modifyCell", cell: unmodified, slotType: "Core" }).fit.slotOverrides, FIXTURES.fit.slotOverrides);
  assert.deepEqual(run(converted, { type: "revertCell", cell: unmodified }).fit.slotOverrides, FIXTURES.fit.slotOverrides);
});

// ---- RANDOMIZE ROLL: the engine's roll arrives as a "rolled" roll edit -------------------------------

const loaded = () => run(initialState(), { type: "load", fit: FIXTURES.fit });
const rolledEdit = (state, rolled, target = 0) => {
  const item = state.fit.modules[target].item;
  return { type: "roll", target, edit: { kind: "rolled", def: item.def, sent: item.roll, rolled } };
};

test("a rolled edit takes the engine's modifiers and nothing else, as one fit change", () => {
  const state = loaded();
  const next = run(state, rolledEdit(state, FIXTURES.roll.item.roll));
  assert.deepEqual(next.fit.modules[0].item.roll, { ...state.fit.modules[0].item.roll, modifiers: FIXTURES.roll.item.roll.modifiers });
  assert.equal(next.revision, state.revision + 1, "the engine evaluates the fit again");
  assert.equal(next.fit.modules[1], state.fit.modules[1], "the other modules are untouched");
  // Only the modifiers: a quality the answer carries is not taken.
  const forged = run(state, rolledEdit(state, { ...FIXTURES.roll.item.roll, quality: "Masterwork" }));
  assert.equal(forged.fit.modules[0].item.roll.quality, state.fit.modules[0].item.roll.quality);
  // The line re-roll's answer, on the rolled item, changes line 0 alone.
  const line = run(next, rolledEdit(next, FIXTURES.rollLine.item.roll));
  assert.deepEqual(line.fit.modules[0].item.roll.modifiers, FIXTURES.rollLine.item.roll.modifiers);
  assert.deepEqual(line.fit.modules[0].item.roll.modifiers.slice(1), next.fit.modules[0].item.roll.modifiers.slice(1));
});

test("a rolled edit for a roll that has changed since, another item, or a rarity the game doesn't roll changes nothing", () => {
  const state = loaded();
  const stale = rolledEdit(state, FIXTURES.roll.item.roll);
  const edited = run(state, { type: "roll", target: 0, edit: { kind: "quality", quality: "Masterwork" } });
  assert.notEqual(edited.fit, state.fit);
  assert.equal(run(edited, stale).fit, edited.fit, "an answer to an older roll is dropped");
  const otherItem = { ...stale, edit: { ...stale.edit, def: FIXTURES.fit.modules[1].item.def } };
  assert.equal(run(state, otherItem).fit, state.fit);
  const normal = state.fit.modules[1].item;
  const onNormal = { type: "roll", target: 1, edit: { kind: "rolled", def: normal.def, sent: normal.roll, rolled: { ...normal.roll, modifiers: FIXTURES.roll.item.roll.modifiers } } };
  assert.equal(run(state, onNormal).fit, state.fit);
  const sameLines = run(state, rolledEdit(state, state.fit.modules[0].item.roll));
  assert.equal(sameLines, state, "the same lines are no change");
});
