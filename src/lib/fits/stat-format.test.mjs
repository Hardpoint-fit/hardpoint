import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURES } from "../engine/stub-engine.mjs";
import { describeSource, formatNumber, formatStatValue, sourceNames, statLabel, statTone, statWords } from "./stat-format.ts";

const words = statWords(FIXTURES.catalog.stats);

test("stats read in the game's words", () => {
  assert.equal(statLabel(words, "MaxSpeed"), "MAX VELOCITY");
  assert.equal(statLabel(words, "MaxHull"), "HULL HP");
  assert.equal(statLabel(words, "SomeStatNewerThanTheSite"), "SOME STAT NEWER THAN THE SITE");
});

test("a stat the catalog doesn't word still reads: its spaced name, higher is better, not whole", () => {
  const none = statWords([]);
  assert.equal(statLabel(none, "MaxSpeed"), "MAX SPEED");
  assert.equal(statTone(none, "Mass", 0.1), "Positive");
  assert.equal(formatStatValue(none, "CargoCapacity", "Add", -6.4), "-6.4");
});

test("numbers follow DisplayNumberText: one decimal below 100, whole above", () => {
  assert.equal(formatNumber(18.765), "18.8");
  assert.equal(formatNumber(1234.4), "1,234");
  assert.equal(formatNumber(-6), "-6");
});

test("a Multiply reads as a signed percent change, inverted where the game inverts it", () => {
  assert.equal(formatStatValue(words, "MaxSpeed", "Multiply", 0.1876983642578125), "+18.8%");
  assert.equal(formatStatValue(words, "Mass", "Multiply", -0.067), "-6.7%");
  assert.equal(formatStatValue(words, "TurretCycleDuration", "Multiply", -0.1), "+10%");
  assert.equal(formatStatValue(words, "ArmorResistKinetic", "DamageReduction", -0.04), "-4%");
  assert.equal(formatStatValue(words, "CargoCapacity", "Add", -6), "-6");
});

test("tone follows whether higher is better for the stat", () => {
  assert.equal(statTone(words, "MaxSpeed", 0.1), "Positive");
  assert.equal(statTone(words, "Mass", -0.1), "Positive");
  assert.equal(statTone(words, "Mass", 0.1), "Negative");
  assert.equal(statTone(words, "Mass", 0), "Neutral");
});

test("sources are named from the catalog, with the stacking share they kept", () => {
  const names = sourceNames(FIXTURES.catalog);
  const mass = FIXTURES.evaluateValid.stats.find((line) => line.stat === "Mass");
  const coolant = describeSource(words, mass, mass.sources[0], names);
  assert.deepEqual(coolant, { name: "COOLANT RESERVOIR", kind: "MODULE", value: "+3%", tone: "Negative", stacking: null });
  const slip = describeSource(words, mass, mass.sources[1], names);
  assert.equal(slip.stacking, "x0.84");
  const set = FIXTURES.evaluateValid.stats.find((line) => line.stat === "TurretCritChance");
  assert.equal(describeSource(words, set, set.sources[0], names).name, "KASSIK'S SEVERANCE");
  assert.equal(describeSource(words, set, { ...set.sources[0], asset: "1" }, names).name, "UNKNOWN SOURCE");
});

test("an affinity source is named for its type, from the catalog when it can be", () => {
  const speed = { stat: "MaxSpeed", operation: "Multiply" };
  const source = { kind: "AffinityClass", asset: null, affinityType: "Propulsion", raw: 0.02, ratio: 1, effective: 0.02, isStackingExempt: true };
  const named = describeSource(words, speed, source, sourceNames(FIXTURES.catalog));
  assert.deepEqual(named, { name: "AGILITY AFFINITY", kind: "AFFINITY", value: "+2%", tone: "Positive", stacking: null });
  assert.equal(describeSource(words, speed, source, new Map()).name, "PROPULSION AFFINITY");
  assert.equal(describeSource(words, speed, { ...source, kind: "AffinitySpecialization" }, new Map()).kind, "SPECIALIZATION");
});
