// The inspector's options come from the catalog's rules: only choices the engine accepts are offered.
import assert from "node:assert/strict";
import test from "node:test";
import { defaultRoll } from "./roll-edits.ts";
import * as edits from "./roll-edits.ts";
import {
  FP_ONE,
  addableModifiers,
  ascendedOptions,
  canFracture,
  canInvert,
  canMirror,
  harmonicOptions,
  hereticalOptions,
  hullSubject,
  indexCatalog,
  invertValue,
  isGrantOnly,
  modifierCount,
  moduleSubject,
  poolOptions,
  portOptions,
  qualityOptions,
  rarityOptions,
  rolledValue,
  tierOptions,
  typeOverrideOptions,
  valueRange,
} from "./rules.ts";
import { SCARAB, itemNamed, richCatalog } from "./test-catalog.mjs";

const catalog = richCatalog();
const cat = indexCatalog(catalog);
const subject = (name) => moduleSubject(cat, itemNamed(catalog, name).def);

test("qualities are the item's, plus any an authored grant gives", () => {
  const armor = subject("ARMOR HARDENER");
  assert.deepEqual(qualityOptions(armor), armor.roll.qualities);
  const synthetic = { ...armor, roll: { ...armor.roll, qualities: ["Standard"], authored: [{ source: "x", quality: "Faction", rarity: "Augmented", isIdentified: true, pointRating: 1 }] } };
  assert.deepEqual(qualityOptions(synthetic), ["Standard", "Faction"]);
  assert.deepEqual(rarityOptions(cat, synthetic, { ...defaultRoll(synthetic), quality: "Faction" }), ["Augmented"], "a grant-only quality offers only its granted rarity");
  assert.equal(isGrantOnly(synthetic, { quality: "Faction", rarity: "Augmented" }), true);
  assert.deepEqual(modifierCount(cat, synthetic, { ...defaultRoll(synthetic), quality: "Faction", rarity: "Augmented" }), { min: 0, max: 0 }, "a granted roll is bare");
});

test("Faction-issue gear stays Normal with no ports, THOTH type or copy", () => {
  const tracer = subject("TRACER ROUNDS");
  const faction = { ...defaultRoll(tracer), quality: "Faction" };
  assert.deepEqual(rarityOptions(cat, tracer, faction), ["Normal"]);
  assert.equal(portOptions(tracer, faction).editable, false);
  assert.deepEqual(typeOverrideOptions(tracer, faction), []);
  assert.equal(canMirror(tracer, faction), false);
  assert.deepEqual(harmonicOptions(cat, subject("COOLANT RESERVOIR"), faction), []);
});

test("a rarity that needs a reference is offered only when the catalog has one for the item", () => {
  const tracer = subject("TRACER ROUNDS");
  const roll = defaultRoll(tracer);
  const offered = rarityOptions(cat, tracer, roll);
  assert.ok(offered.includes("Artifact") && offered.includes("Regalia"), "the linked artifact and regalia piece");
  assert.ok(!offered.includes("Harmonic"), "the recorded harmonic sets want Utility, TRACER ROUNDS is a Turret");
  assert.ok(!offered.includes("Heretical"), "the recorded specials are for drones");
  assert.ok(rarityOptions(cat, tracer, { ...roll, moduleTypeOverride: "Drone" }).includes("Heretical"), "a THOTH Drone type opens the drone specials");
  assert.ok(rarityOptions(cat, tracer, { ...roll, moduleTypeOverride: "Utility" }).includes("Harmonic"), "and a THOTH Utility type the Utility sets");
  const hull = hullSubject(cat, SCARAB);
  assert.ok(!rarityOptions(cat, hull, defaultRoll(hull)).includes("Artifact"), "no artifact of this hull in the catalog");
  assert.deepEqual(hereticalOptions(cat, hull, defaultRoll(hull)), []);
});

test("harmonic sets match the effective pool type and fit the item's port count", () => {
  const coolant = subject("COOLANT RESERVOIR");
  const sets = harmonicOptions(cat, coolant, defaultRoll(coolant));
  assert.ok(sets.length > 0);
  for (const set of sets) {
    assert.ok(set.moduleTypes.length === 0 || set.moduleTypes.includes("Utility"));
    assert.ok(set.ciphers.length <= coolant.portRules.maxPorts);
  }
  // A harmonic set lists the module types it takes; an item of another type matches none of them.
  const tracer = subject("TRACER ROUNDS");
  assert.deepEqual(harmonicOptions(cat, tracer, defaultRoll(tracer)), []);
});

test("modifier counts follow the rarity; templates hold their line count", () => {
  const tracer = subject("TRACER ROUNDS");
  const roll = defaultRoll(tracer);
  assert.deepEqual(modifierCount(cat, tracer, roll), { min: 0, max: 0 });
  assert.deepEqual(modifierCount(cat, tracer, { ...roll, rarity: "Augmented" }), { min: 1, max: 2 });
  assert.deepEqual(modifierCount(cat, tracer, { ...roll, rarity: "Prototype" }), { min: 2, max: 4 });
  const artifact = edits.setRarity(cat, tracer, roll, "Artifact");
  const lines = catalog.artifacts.find((a) => a.def === artifact.artifact).modifiers.length;
  assert.deepEqual(modifierCount(cat, tracer, artifact), { min: lines, max: lines });
  assert.deepEqual(addableModifiers(cat, tracer, artifact), [], "template lines can't be added to");
});

test("addable lines: unused stat and operation, room in the slot and the count, an allowed tier", () => {
  const tracer = subject("TRACER ROUNDS");
  let roll = edits.setRarity(cat, tracer, defaultRoll(tracer), "Prototype");
  const used = new Set(roll.modifiers.map((m) => `${m.stat}|${m.operation}`));
  for (const option of addableModifiers(cat, tracer, roll)) {
    assert.ok(!used.has(`${option.entry.stat}|${option.entry.operation}`));
    assert.ok(option.entry.tiers.some((t) => t.allowed));
  }
  while (addableModifiers(cat, tracer, roll).length) {
    const [option] = addableModifiers(cat, tracer, roll);
    roll = edits.addModifier(cat, tracer, roll, { stat: option.entry.stat, operation: option.entry.operation, slot: option.slot });
  }
  assert.ok(roll.modifiers.length <= 4);
  assert.ok(roll.modifiers.filter((m) => m.slot === 0).length <= 2 && roll.modifiers.filter((m) => m.slot === 1).length <= 2, "two prefixes and two suffixes at most");
});

test("a modifier group already taken is not offered again", () => {
  const tracer = subject("TRACER ROUNDS");
  const prefix = tracer.roll.modifierPool.prefix.map((entry) => ({ ...entry, group: 7 }));
  const grouped = { ...tracer, roll: { ...tracer.roll, modifierPool: { ...tracer.roll.modifierPool, prefix } } };
  let roll = { ...defaultRoll(grouped), rarity: "Prototype" };
  const [first] = addableModifiers(cat, grouped, roll).filter((o) => o.slot === 0);
  roll = edits.addModifier(cat, grouped, roll, { stat: first.entry.stat, operation: first.entry.operation, slot: 0 });
  assert.deepEqual(addableModifiers(cat, grouped, roll).filter((o) => o.slot === 0), [], "every other prefix shares group 7");
});

test("a THOTH type adds every adapter type's pool, filtered to the item", () => {
  const tracer = subject("TRACER ROUNDS");
  const own = poolOptions(cat, tracer, defaultRoll(tracer));
  const retyped = poolOptions(cat, tracer, { ...defaultRoll(tracer), moduleTypeOverride: "Shield" });
  assert.ok(retyped.length > own.length);
  assert.ok(retyped.some((o) => o.entry.pool === "Shield"));
  assert.deepEqual(typeOverrideOptions(tracer, defaultRoll(tracer)), tracer.roll.typeOverrides);
  assert.deepEqual(typeOverrideOptions(hullSubject(cat, SCARAB), defaultRoll(hullSubject(cat, SCARAB))), [], "hulls take no THOTH type");
});

test("tiers are the allowed ones; value ranges are raw FP, whole numbers for integer Add stats", () => {
  const tracer = subject("TRACER ROUNDS");
  const pool = structuredClone(tracer.roll.modifierPool);
  pool.prefix[0].tiers[3].allowed = false;
  const limited = { ...tracer, roll: { ...tracer.roll, modifierPool: pool } };
  const roll = edits.setRarity(cat, limited, defaultRoll(limited), "Augmented");
  const line = roll.modifiers[0];
  assert.equal(line.stat, pool.prefix[0].stat);
  assert.deepEqual(tierOptions(cat, limited, roll, line), [1, 2, 3], "tier 4 isn't allowed");
  const range = valueRange(cat, limited, roll, 0, 2);
  assert.deepEqual([range.min, range.max, range.step], [Number(pool.prefix[0].tiers[1].min), Number(pool.prefix[0].tiers[1].max), 1]);

  const integer = { stat: "CargoCapacity", operation: "Add", pool: "Turret", group: 0, augmentedOnly: false, onlyOnModule: null, tiers: [{ tier: 1, min: String(FP_ONE / 2), max: String(2.5 * FP_ONE), allowed: true }] };
  const withInteger = { ...tracer, roll: { ...tracer.roll, modifierPool: { prefix: [integer], suffix: [] } } };
  const intRoll = { ...defaultRoll(withInteger), rarity: "Augmented", modifiers: [{ stat: "CargoCapacity", operation: "Add", tier: 1, value: String(FP_ONE), slot: 0, isInverted: false, isFractured: false }] };
  assert.deepEqual(valueRange(cat, withInteger, intRoll, 0, 1), { min: FP_ONE, max: 2 * FP_ONE, step: FP_ONE });
  const set = edits.setModifierValue(cat, withInteger, intRoll, 0, 1.6 * FP_ONE);
  assert.equal(set.modifiers[0].value, String(2 * FP_ONE), "snapped to a whole number");
});

test("fracture: one line, never inverted or a template's; inversion: one Heretical line, never fractured", () => {
  const tracer = subject("TRACER ROUNDS");
  let roll = edits.setRarity(cat, tracer, defaultRoll(tracer), "Prototype");
  assert.ok(canFracture(roll, 0) && canFracture(roll, 1));
  roll = edits.setModifierFractured(roll, 0, true);
  assert.equal(canFracture(roll, 1), false, "one fractured line at most");
  assert.equal(canInvert(roll, 1), false, "only a Heretical item inverts");
  const drone = edits.setTypeOverride(cat, tracer, roll, "Drone");
  const heretical = edits.setRarity(cat, tracer, drone, "Heretical");
  assert.equal(heretical.rarity, "Heretical");
  const inverted = heretical.modifiers.findIndex((m) => m.isInverted);
  assert.ok(!heretical.modifiers[inverted].isFractured, "the fractured line isn't the inverted one");
  assert.equal(canInvert(heretical, heretical.modifiers.findIndex((m) => m.isFractured)), false);
  // The stored value of an inverted line is the brand's inversion of a value inside the tier's range.
  const line = heretical.modifiers[inverted];
  const range = valueRange(cat, tracer, heretical, inverted, line.tier);
  assert.ok(rolledValue(line) >= range.min && rolledValue(line) <= range.max);
  assert.equal(Number(line.value), invertValue(line.operation, rolledValue(line)));
  const artifact = edits.setRarity(cat, tracer, defaultRoll(tracer), "Artifact");
  assert.equal(canFracture(artifact, 0), false);
  assert.equal(canMirror(tracer, artifact), false, "YATA can't copy an artifact");
});

test("an ascended brand adds its heresy's form beside the special and inverts a second line", () => {
  const tracer = subject("TRACER ROUNDS");
  let roll = edits.setTypeOverride(cat, tracer, edits.setRarity(cat, tracer, defaultRoll(tracer), "Prototype"), "Drone");
  roll = edits.setRarity(cat, tracer, roll, "Heretical");
  while (roll.modifiers.length < 3) {
    const [line] = addableModifiers(cat, tracer, roll);
    roll = edits.addModifier(cat, tracer, roll, { stat: line.entry.stat, operation: line.entry.operation, slot: line.slot });
  }
  const names = (specials) => specials.map((special) => special.name);
  assert.deepEqual(names(hereticalOptions(cat, tracer, roll)), ["VIGIL"], "a brand gives a standard special");
  assert.deepEqual(names(ascendedOptions(cat, tracer, roll)), ["UNTIRING"], "its heresy's ascended form can sit beside it");
  const inverted = (each) => each.modifiers.flatMap((modifier, index) => (modifier.isInverted ? [index] : []));
  assert.equal(inverted(roll).length, 1);

  const ascended = edits.setAscended(cat, tracer, roll, ascendedOptions(cat, tracer, roll)[0].def);
  assert.equal(ascended.heretical, roll.heretical);
  assert.equal(inverted(ascended).length, 2, "an ascended brand inverts a second line");
  const third = ascended.modifiers.findIndex((modifier, index) => !modifier.isInverted && canInvert(ascended, index));
  const moved = edits.setModifierInverted(ascended, third);
  assert.equal(inverted(moved).length, 2);
  assert.ok(inverted(moved).includes(third), "inverting a third line keeps two");
  assert.equal(inverted(edits.setAscended(cat, tracer, ascended, null)).length, 1, "clearing the form leaves one");
  assert.equal(edits.setRarity(cat, tracer, ascended, "Prototype").ascended, null, "another rarity has no form");

  // An item branded before forms sat beside a special holds its form as the special.
  const older = { ...roll, heretical: ascended.ascended };
  assert.deepEqual(names(hereticalOptions(cat, tracer, older)), ["VIGIL", "UNTIRING"]);
  assert.deepEqual(ascendedOptions(cat, tracer, older), []);
});

test("ports: up to the catalog's count at its candidate cells; ciphers only from the catalog", () => {
  const tracer = subject("TRACER ROUNDS");
  let roll = defaultRoll(tracer);
  const { max, candidates } = portOptions(tracer, roll);
  for (const candidate of candidates) roll = edits.togglePort(cat, tracer, roll, candidate);
  assert.equal(roll.ports.length, max);
  assert.equal(edits.togglePort(cat, tracer, roll, { row: 0, col: 0, direction: "Up" }), roll, "not a candidate");
  roll = edits.togglePort(cat, tracer, roll, candidates[0]);
  assert.equal(roll.ports.length, max - 1);
  assert.equal(edits.setPortCipher(cat, roll, 0, "123"), roll, "not a Tek Cipher in the catalog");
  assert.equal(edits.setPortCipher(cat, roll, 0, catalog.ciphers[0].def).ports[0].cipher, catalog.ciphers[0].def);
  const hull = hullSubject(cat, SCARAB);
  assert.equal(portOptions(hull, defaultRoll(hull)).editable, false, "hulls have no ports");
});

test("clearing the THOTH type drops lines only the other pools held", () => {
  const tracer = subject("TRACER ROUNDS");
  let roll = edits.setTypeOverride(cat, tracer, edits.setRarity(cat, tracer, defaultRoll(tracer), "Augmented"), "Shield");
  const shieldLine = addableModifiers(cat, tracer, roll).find((o) => o.entry.pool === "Shield");
  roll = edits.addModifier(cat, tracer, roll, { stat: shieldLine.entry.stat, operation: shieldLine.entry.operation, slot: shieldLine.slot });
  assert.ok(roll.modifiers.some((m) => m.stat === shieldLine.entry.stat));
  const cleared = edits.setTypeOverride(cat, tracer, roll, null);
  assert.ok(!cleared.modifiers.some((m) => m.stat === shieldLine.entry.stat && m.operation === shieldLine.entry.operation && !tracer.roll.modifierPool.prefix.concat(tracer.roll.modifierPool.suffix).some((e) => e.stat === m.stat)));
  assert.ok(cleared.modifiers.length >= 1, "refilled to the rarity's minimum");
});
