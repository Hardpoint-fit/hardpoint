import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { artManifest } from "./art-manifest.ts";
import { baseIcon, isEffectivelyIdentified, itemIcon, moduleIcon } from "./item-icon.ts";

const ALL = { base: "/art/base.webp", Augmented: "/art/aug.webp", Prototype: "/art/proto.webp", Artifact: "/art/arti.webp", Heretical: "/art/proto.webp" };
const BASE_ONLY = { base: "/art/base.webp" };
const manifest = {
  modules: { contentmodulesrail: ALL, plain: BASE_ONLY },
  artifacts: { configartifactsdreadbane: "/art/dreadbane.webp", dreadbane: "/art/dreadbane.webp" },
  shipClasses: {},
};
const RAIL = { path: "Content/Modules/RailEntityPrototype", category: "Module" };
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
  const bane = "Config/Artifacts/DREAD_BANE";
  assert.equal(itemIcon(RAIL, roll("Artifact"), bane, manifest), "/art/dreadbane.webp");
  assert.equal(itemIcon(RAIL, roll("Artifact", false), bane, manifest), "/art/arti.webp");
  // An artifact that authors no icon falls through to GetIcon(rarity).
  assert.equal(itemIcon(RAIL, roll("Artifact"), "Config/Artifacts/OATH", manifest), "/art/arti.webp");
});

test("identification follows IsEffectivelyIdentified", () => {
  assert.equal(isEffectivelyIdentified("Module", roll("Augmented", false)), false);
  assert.equal(isEffectivelyIdentified("Module", roll("Normal", false)), true, "Normal hides nothing");
  assert.equal(isEffectivelyIdentified("Portable", roll("Augmented", false)), true, "a category that can't be identified");
  assert.equal(isEffectivelyIdentified("Ship", roll("Prototype", false)), false);
  assert.equal(isEffectivelyIdentified(null, roll("Artifact", false)), true);
});

test("an item with no art has no icon, so the caller draws its placeholder", () => {
  assert.equal(itemIcon({ path: "Content/Nowhere/GhostEntityPrototype", category: "Module" }, roll("Augmented"), null, manifest), null);
  assert.equal(itemIcon({ path: null, category: null }, roll("Normal"), null, manifest), null);
  assert.equal(baseIcon("Plain", manifest), "/art/base.webp");
  assert.equal(baseIcon(null, manifest), null);
});

test("real catalog paths from the engine find their art in the generated manifest", () => {
  const catalog = JSON.parse(readFileSync(new URL("../engine/__fixtures__/catalog.json", import.meta.url), "utf8"));
  const paths = [...catalog.items, ...catalog.hulls].map((entry) => entry.path);
  assert.ok(paths.every((path) => typeof path === "string" && path.endsWith("EntityPrototype")), "the fixture carries real Identifier.Path values");
  const missing = paths.filter((path) => !baseIcon(path));
  assert.deepEqual(missing, []);
  // The NPC and player OMNI REPAIRER TURRET share a file name; each finds an image.
  const omni = catalog.items.filter((item) => item.name === "OMNI REPAIRER TURRET");
  assert.equal(omni.length, 2);
  for (const item of omni) assert.match(itemIcon(item, roll("Augmented")), /^\/art\/[0-9a-f]{32}\.webp$/);
  const scarab = catalog.hulls.find((hull) => hull.name === "SCARAB");
  assert.match(itemIcon({ path: scarab.path, category: "Ship" }, roll("Normal")), /^\/art\//);
});

// Whether the Unity tree authors an icon for an asset: its icon field names an image.
const ASSETS = new URL("../../../../../../src/Citadel.Unity/Assets/", import.meta.url);
const authorsIcon = (file, indent) => new RegExp(`\\n${indent}icon: \\{[^}\\n]*guid: [0-9a-f]{32}`).test(readFileSync(new URL(file, ASSETS), "utf8"));

test("every fixture artifact and cipher that authors art finds its own icon by its catalog path", () => {
  const catalog = JSON.parse(readFileSync(new URL("../engine/__fixtures__/catalog.json", import.meta.url), "utf8"));
  const artifacts = catalog.artifacts.filter((artifact) => authorsIcon(`${artifact.path}.asset`, "  "));
  const ciphers = catalog.ciphers.filter((cipher) => authorsIcon(`${cipher.path.replace(/EntityPrototype$/, "")}.prefab`, "    "));
  assert.ok(artifacts.length > 0 && ciphers.length > 0, "the fixture holds an artifact and a cipher with art");
  for (const artifact of artifacts) assert.match(itemIcon(RAIL, roll("Artifact"), artifact.path) ?? "", /^\/art\//, artifact.name);
  for (const cipher of ciphers) assert.match(itemIcon({ path: cipher.path, category: "Portable" }, roll("Normal")) ?? "", /^\/art\//, cipher.name);
  // Dreadnought's Bane: its display name ("DREADNOUGHTS BANE") is not its asset's name (DREAD_BANE).
  const bane = catalog.artifacts.find((artifact) => artifact.name === "DREADNOUGHTS BANE");
  assert.ok(artifacts.includes(bane));
  const own = itemIcon(RAIL, roll("Artifact"), bane.path);
  assert.equal(own, artManifest.artifacts.dreadbane);
  assert.notEqual(own, itemIcon(RAIL, roll("Artifact"), bane.name), "a display name does not find the asset");
  const distinct = new Set(artifacts.map((artifact) => itemIcon(RAIL, roll("Artifact"), artifact.path)));
  assert.equal(distinct.size, artifacts.length, "each artifact shows its own icon");
});
