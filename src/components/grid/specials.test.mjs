// A rolled item's special: what a regalia piece, an artifact, a harmonic set and a heretical special add, the
// linked count a set's bonuses read, the fit-wide set list, and the tooltip's rows for them. The catalog
// below is cut from the live API's records (KASSIK'S SEVERANCE and its pieces).
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { rollSpecial, setSummaries, specialLookups, specialName } from "./specials.ts";
import { SpecialDetails } from "./module-special.tsx";
import { shiftInto } from "../tip-placement.tsx";

const row = (label, value) => ({ label, value, unit: null, tone: "Positive", id: label, number: null });
const bonus = (pieces, lines, effects = []) => ({
  pieces,
  modifiers: lines.map(([label, value]) => ({ stat: label, operation: "Multiply", value: "65536", row: row(label, value) })),
  effects: effects.map((text) => ({ kind: "Triggered", rule: "1", text, chance: "65536", strength: null, displayText: text, chanceNumber: 1 })),
});
const line = (stat, scope) => ({ stat, operation: "Multiply", tier: 4, min: "70000", max: "72000", scope });

const catalog = {
  items: [
    { def: "flak", name: "FLAK CANNON", slotType: "Battery" },
    { def: "magazine", name: "HEATSINK MAGAZINE", slotType: "Core" },
    { def: "shredder", name: "DEFENSE SHREDDER", slotType: "Subsystem" },
    { def: "coupler", name: "INERTIA COUPLER", slotType: "Propulsion" },
  ],
  regaliaSets: [
    {
      def: "kassik",
      name: "KASSIK'S SEVERANCE",
      pieces: ["flayer", "veil", "stride", "fang"],
      // Out of order on purpose: tiers are listed by piece count.
      bonuses: [
        bonus(4, [["TRACKING SPEED", "+23%"]], ["ON CRITICAL HIT +50% MAX SPEED FOR 3S (10S COOLDOWN)"]),
        bonus(2, [["TURRET CRIT CHANCE", "+27%"]]),
        bonus(3, [["MAX VELOCITY", "+17%"], ["THRUST", "+10%"]]),
      ],
    },
  ],
  regalia: [
    { def: "fang", name: "KASSIK'S FANG", item: "flak", set: "kassik", modifiers: [line("TurretDamage", "Local")], scaledStat: null, linkedBonuses: [bonus(2, [["FIRE RATE", "+5%"]])] },
    { def: "veil", name: "KASSIK'S VEIL", item: "magazine", set: "kassik", modifiers: [line("MaxHeat", "ShipWide")], scaledStat: null, linkedBonuses: [] },
    { def: "flayer", name: "KASSIK'S FLAYER", item: "shredder", set: "kassik", modifiers: [], scaledStat: null, linkedBonuses: [] },
    { def: "stride", name: "KASSIK'S STRIDE", item: "coupler", set: "kassik", modifiers: [], scaledStat: null, linkedBonuses: [] },
  ],
  artifacts: [
    {
      def: "reckoning",
      name: "FLOB'S RECKONING",
      item: "flak",
      modifiers: [line("MaxHeat", "ShipWide"), line("TurretDamage", "Local")],
      targeting: "SelectedEnemy",
      ability: { name: "FLOB'S RECKONING", description: "GATHERS EVERY LANCE'S SHOT INTO ONE SHELL." },
    },
    { def: "oath", name: "OATH BRINGER", item: "flak", modifiers: [], targeting: "WorldAim", ability: null },
  ],
  harmonicSets: [{ def: "lodestar", name: "LODESTAR ASSAY", description: "A LUCKY SEAM.", moduleTypes: ["Utility"], ciphers: ["erg", "gone"], pointRating: 1500 }],
  hereticalSpecials: [
    { def: "vigil", name: "VIGIL", heresy: "Vigil", ascended: false, moduleTypes: ["Drone"] },
    { def: "vigil-up", name: "ASCENDED VIGIL", heresy: "Vigil", ascended: true, moduleTypes: ["Drone"] },
  ],
  ciphers: [{ def: "erg", name: "ERG", stat: "HeatDissipationRate", operation: "Multiply", value: "74056", pointRating: 1, art: null }],
};
const lookups = specialLookups(catalog);
const plain = { rarity: "Normal", artifact: null, regalia: null, harmonicSet: null, heretical: null, ascended: null };

test("a lone regalia piece counts one linked: its set bonuses are all listed in order, none reached", () => {
  const special = rollSpecial(lookups, { ...plain, rarity: "Regalia", regalia: "fang" });
  assert.equal(special.kind, "regalia");
  assert.equal(special.name, "KASSIK'S FANG");
  assert.equal(special.setName, "KASSIK'S SEVERANCE");
  assert.deepEqual([special.linked, special.size], [1, 4]);
  assert.deepEqual(special.bonuses.map((tier) => [tier.pieces, tier.active]), [[2, false], [3, false], [4, false]]);
  assert.deepEqual(special.bonuses[2].effects, ["ON CRITICAL HIT +50% MAX SPEED FOR 3S (10S COOLDOWN)"]);
  assert.deepEqual(special.own.map((tier) => [tier.pieces, tier.active, tier.lines[0].label]), [[2, false, "FIRE RATE"]]);
  assert.deepEqual(special.pieces.map((piece) => [piece.name, piece.slotType, piece.linked]), [
    ["KASSIK'S FLAYER", "Subsystem", false],
    ["KASSIK'S VEIL", "Core", false],
    ["KASSIK'S STRIDE", "Propulsion", false],
    ["KASSIK'S FANG", "Battery", true],
  ]);
});

test("a regalia piece in an evaluated group reaches the bonuses its linked count allows", () => {
  const special = rollSpecial(lookups, { ...plain, rarity: "Regalia", regalia: "veil" }, { linkedCount: 3, linkedPieces: ["fang", "veil", "stride"] });
  assert.deepEqual(special.bonuses.map((tier) => tier.active), [true, true, false]);
  assert.deepEqual(special.pieces.filter((piece) => piece.linked).map((piece) => piece.def), ["veil", "stride", "fang"]);
  assert.deepEqual(special.shipWide, ["MaxHeat"]);
});

test("an artifact names itself and keeps its ability and targeting; one with no ability has no targeting", () => {
  const special = rollSpecial(lookups, { ...plain, rarity: "Artifact", artifact: "reckoning" });
  assert.deepEqual(special, {
    kind: "artifact",
    name: "FLOB'S RECKONING",
    targeting: "SelectedEnemy",
    ability: { name: "FLOB'S RECKONING", description: "GATHERS EVERY LANCE'S SHOT INTO ONE SHELL." },
    shipWide: ["MaxHeat"],
  });
  assert.equal(rollSpecial(lookups, { ...plain, rarity: "Artifact", artifact: "oath" }).targeting, null);
});

test("a harmonic set lists the ciphers the catalog has; a heretical special names its ascended form", () => {
  const harmonic = rollSpecial(lookups, { ...plain, rarity: "Harmonic", harmonicSet: "lodestar" });
  assert.deepEqual(harmonic.ciphers.map((cipher) => cipher.name), ["ERG"]);
  const heretical = rollSpecial(lookups, { ...plain, rarity: "Heretical", heretical: "vigil", ascended: "vigil-up" });
  assert.deepEqual(heretical, { kind: "heretical", name: "VIGIL", heresy: "Vigil", ascended: "ASCENDED VIGIL" });
});

test("a plain roll, or one naming what the catalog lacks, has no special and keeps the module's name", () => {
  assert.equal(rollSpecial(lookups, plain), null);
  assert.equal(rollSpecial(lookups, { ...plain, rarity: "Regalia", regalia: "gone" }), null);
  assert.equal(specialName(null, "FLAK CANNON"), "FLAK CANNON");
  assert.equal(specialName(rollSpecial(lookups, { ...plain, rarity: "Regalia", regalia: "fang" }), "FLAK CANNON"), "KASSIK'S FANG");
  assert.equal(specialName(rollSpecial(lookups, { ...plain, rarity: "Heretical", heretical: "vigil" }), "DRONE BAY"), "DRONE BAY");
});

test("an older engine's catalog, with no bonuses, gives a set with none", () => {
  const old = specialLookups({ ...catalog, regaliaSets: catalog.regaliaSets.map(({ bonuses, ...set }) => set), regalia: catalog.regalia.map(({ linkedBonuses, ...piece }) => piece) });
  const special = rollSpecial(old, { ...plain, rarity: "Regalia", regalia: "fang" });
  assert.deepEqual([special.bonuses, special.own], [[], []]);
});

test("the set list has each set once, at its best linked group", () => {
  const lone = rollSpecial(lookups, { ...plain, rarity: "Regalia", regalia: "flayer" });
  const pair = { linkedCount: 2, linkedPieces: ["fang", "veil"] };
  const fang = rollSpecial(lookups, { ...plain, rarity: "Regalia", regalia: "fang" }, pair);
  const sets = setSummaries([null, lone, fang, rollSpecial(lookups, { ...plain, rarity: "Artifact", artifact: "oath" })]);
  assert.deepEqual(sets.map((set) => [set.name, set.linked, set.size]), [["KASSIK'S SEVERANCE", 2, 4]]);
  assert.deepEqual(sets[0].bonuses.map((tier) => tier.active), [true, false, false]);
});

test("the tooltip rows name the set and its linked count, every bonus with its piece count, and the effect", () => {
  const special = rollSpecial(lookups, { ...plain, rarity: "Regalia", regalia: "fang" }, { linkedCount: 2, linkedPieces: ["fang", "veil"] });
  const html = render(h(SpecialDetails, { special, words: new Map() }));
  for (const text of ["KASSIK&#x27;S SEVERANCE", "2/4 LINKED", "LINKED BONUS", "SET BONUSES", "TURRET CRIT CHANCE", "+27%", "ON CRITICAL HIT +50% MAX SPEED"]) assert.ok(html.includes(text), text);
  assert.equal(html.split("bonus-tier--on").length - 1, 2, "the piece's own bonus and the set's 2-piece bonus are reached");
});

test("a tooltip past an edge shifts back in, the top and left edges winning when it is too big", () => {
  assert.equal(shiftInto(100, 300, 900), 0);
  assert.equal(shiftInto(600, 1000, 900), -108);
  assert.equal(shiftInto(-20, 100, 900), 28);
  assert.equal(shiftInto(100, 1100, 900), -92);
});
