import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURES } from "../engine/stub-engine.mjs";
import { describeSource, formatNumber, formatStatValue, sourceNames, statLabel, statTone } from "./stat-format.ts";

test("stats read in the game's words", () => {
  assert.equal(statLabel("MaxSpeed"), "MAX VELOCITY");
  assert.equal(statLabel("MaxHull"), "HULL HP");
  assert.equal(statLabel("SomeStatNewerThanTheSite"), "SOME STAT NEWER THAN THE SITE");
});

test("numbers follow DisplayNumberText: one decimal below 100, whole above", () => {
  assert.equal(formatNumber(18.765), "18.8");
  assert.equal(formatNumber(1234.4), "1,234");
  assert.equal(formatNumber(-6), "-6");
});

test("a Multiply reads as a signed percent change, inverted where the game inverts it", () => {
  assert.equal(formatStatValue("MaxSpeed", "Multiply", 0.1876983642578125), "+18.8%");
  assert.equal(formatStatValue("Mass", "Multiply", -0.067), "-6.7%");
  assert.equal(formatStatValue("TurretCycleDuration", "Multiply", -0.1), "+10%");
  assert.equal(formatStatValue("ArmorResistKinetic", "DamageReduction", -0.04), "-4%");
  assert.equal(formatStatValue("CargoCapacity", "Add", -6), "-6");
});

test("tone follows whether higher is better for the stat", () => {
  assert.equal(statTone("MaxSpeed", 0.1), "Positive");
  assert.equal(statTone("Mass", -0.1), "Positive");
  assert.equal(statTone("Mass", 0.1), "Negative");
  assert.equal(statTone("Mass", 0), "Neutral");
});

test("sources are named from the catalog, with the stacking share they kept", () => {
  const names = sourceNames(FIXTURES.catalog);
  const mass = FIXTURES.evaluateValid.stats.find((line) => line.stat === "Mass");
  const coolant = describeSource(mass, mass.sources[0], names);
  assert.deepEqual(coolant, { name: "COOLANT RESERVOIR", kind: "MODULE", value: "+3%", tone: "Negative", stacking: null });
  const slip = describeSource(mass, mass.sources[1], names);
  assert.equal(slip.stacking, "x0.84");
  const set = FIXTURES.evaluateValid.stats.find((line) => line.stat === "TurretCritChance");
  assert.equal(describeSource(set, set.sources[0], names).name, "KASSIK'S SEVERANCE");
  assert.equal(describeSource(set, { ...set.sources[0], asset: "1" }, names).name, "UNKNOWN SOURCE");
});
