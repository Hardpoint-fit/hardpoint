import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { artKey, artKeys } from "./art-key.ts";

const { iconKeys } = createRequire(import.meta.url)("../../../../../../tools/ship-restore/lib/game-assets.js");

test("artKeys normalizes like the game-assets icon keys and strips EntityPrototype and Hull", () => {
  assert.deepEqual(artKeys("Coolant Reservoir"), ["coolantreservoir"]);
  assert.deepEqual(artKeys("Content/Modules/Scarab HullEntityPrototype"), [
    "contentmodulesscarabhull",
    "contentmodulesscarabhullentityprototype",
    "scarabhullentityprototype",
    "scarabhull",
    "scarab",
  ]);
  assert.equal(artKey("Content/Modules/Scarab HullEntityPrototype"), "contentmodulesscarabhull");
  assert.equal(artKey(null), "");
  assert.deepEqual(artKeys("x".repeat(501)), []);
});

test("every game-assets icon key is among the site's candidates, in the same order", () => {
  for (const path of ["Assets/Content/Modules/Turrets/Railgun Variants/Rail MK2EntityPrototype", "Scarab Hull", "Drux", "Foo/Bar ShipPrototype", "OMNI REPAIRER TURRET"]) {
    const site = artKeys(path);
    const game = iconKeys(path);
    assert.deepEqual(site.filter((key) => game.includes(key)), game, path);
  }
});

test("a prefab's own path key is the whole path without Assets/ or the prototype suffix", () => {
  assert.equal(artKey("Assets/Content/Modules/Coolant ReservoirEntityPrototype"), "contentmodulescoolantreservoir");
});
