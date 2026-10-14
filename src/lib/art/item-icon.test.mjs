import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURES } from "../engine/stub-engine.mjs";
import { art2x, baseIcon, isEffectivelyIdentified, itemIcon, moduleIcon } from "./item-icon.ts";

const ALL = { base: "/art/base.webp", Augmented: "/art/aug.webp", Prototype: "/art/proto.webp", Artifact: "/art/arti.webp", Heretical: "/art/proto.webp" };
const BASE_ONLY = { base: "/art/base.webp" };
const DREADBANE = { base: "/art/dreadbane.webp" };
const RAIL = { art: ALL, category: "Module" };
const roll = (rarity, isIdentified = true) => ({ rarity, isIdentified });

test("GetIcon: each rarity picks its authored variant", () => {
  assert.equal(moduleIcon(ALL, "Normal"), "/art/base.webp");
  assert.equal(moduleIcon(ALL, "Augmented"), "/art/aug.webp");
  assert.equal(moduleIcon(ALL, "Prototype"), "/art/proto.webp");
  assert.equal(moduleIcon(ALL, "Heretical"), "/art/proto.webp", "a heretical item keeps its Prototype art");
  assert.equal(moduleIcon(ALL, "Artifact"), "/art/arti.webp");
  assert.equal(moduleIcon(ALL, "Regalia"), "/art/base.webp");
  assert.equal(moduleIcon(ALL, "Harmonic"), "/art/base.webp");
});

test("GetIcon: a variant the prefab doesn't author falls back to the base icon (Review Focus #1)", () => {
  for (const rarity of ["Augmented", "Prototype", "Heretical", "Artifact", "Normal"]) assert.equal(moduleIcon(BASE_ONLY, rarity), "/art/base.webp", rarity);
});

test("an identified artifact shows the artifact's own icon; an unidentified one keeps the module's look", () => {
  assert.equal(itemIcon(RAIL, roll("Artifact"), DREADBANE), "/art/dreadbane.webp");
  assert.equal(itemIcon(RAIL, roll("Artifact", false), DREADBANE), "/art/arti.webp");
  // An artifact that authors no icon (its catalog art is null) falls through to GetIcon(rarity).
  assert.equal(itemIcon(RAIL, roll("Artifact"), null), "/art/arti.webp");
});

test("identification follows IsEffectivelyIdentified", () => {
  assert.equal(isEffectivelyIdentified("Module", roll("Augmented", false)), false);
  assert.equal(isEffectivelyIdentified("Module", roll("Normal", false)), true, "Normal hides nothing");
  assert.equal(isEffectivelyIdentified("Portable", roll("Augmented", false)), true, "a category that can't be identified");
  assert.equal(isEffectivelyIdentified("Ship", roll("Prototype", false)), false);
  assert.equal(isEffectivelyIdentified(null, roll("Artifact", false)), true);
});

test("an item with no art has no icon, so the caller draws its placeholder", () => {
  assert.equal(itemIcon({ art: null, category: "Module" }, roll("Augmented")), null);
  assert.equal(itemIcon({ art: null, category: null }, roll("Normal")), null);
  assert.equal(baseIcon(BASE_ONLY), "/art/base.webp");
  assert.equal(baseIcon(null), null);
});

test("the 256px twin of an art URL has @2x before .webp", () => {
  assert.equal(art2x("/art/a.webp"), "/art/a@2x.webp");
  assert.equal(art2x("https://api.thecitadel.com/v1/art/x.y.webp"), "https://api.thecitadel.com/v1/art/x.y@2x.webp");
});

const URL_SHAPE = /^https:\/\/api\.example\.test\/v1\/art\/[0-9a-f]{32}\.[0-9a-f]{16}\.webp$/;

test("every fixture item, hull and cipher shows an API art URL, the tiers where the game authors them", () => {
  const { items, hulls, ciphers } = FIXTURES.catalog;
  for (const entry of [...items, ...hulls, ...ciphers]) {
    assert.match(baseIcon(entry.art), URL_SHAPE, entry.name);
    assert.match(itemIcon({ art: entry.art, category: "Module" }, roll("Augmented")), URL_SHAPE, entry.name);
  }
  const tiered = hulls.find((hull) => hull.art.Augmented);
  assert.ok(tiered, "the fixtures hold an item with tiered art");
  assert.equal(itemIcon({ art: tiered.art, category: "Ship" }, roll("Augmented")), tiered.art.Augmented);
  assert.notEqual(tiered.art.Augmented, tiered.art.base);
});

test("an artifact that authors an icon shows its own, each different; one that doesn't shows its item's", () => {
  const { artifacts, items } = FIXTURES.catalog;
  const own = artifacts.filter((artifact) => artifact.art);
  const without = artifacts.filter((artifact) => !artifact.art);
  assert.ok(own.length > 0 && without.length > 0, "the fixtures hold artifacts with and without an icon");
  for (const artifact of own) assert.equal(itemIcon(RAIL, roll("Artifact"), artifact.art), artifact.art.base, artifact.name);
  assert.equal(new Set(own.map((artifact) => itemIcon(RAIL, roll("Artifact"), artifact.art))).size, own.length, "each shows its own icon");
  const [artifact] = without;
  const item = items[0];
  assert.equal(itemIcon({ art: item.art, category: "Module" }, roll("Artifact"), artifact.art), moduleIcon(item.art, "Artifact"));
});
