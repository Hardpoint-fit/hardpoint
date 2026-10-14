import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURES } from "../engine/stub-engine.mjs";
import { moduleInfos, searchModules } from "./module-search.ts";

const catalog = FIXTURES.catalog;

test("module search matches every word of a name, case-insensitively, names starting with the first word first", () => {
  assert.deepEqual(searchModules(catalog, "survey").map((m) => m.name), ["SURVEY SCANNER"]);
  assert.ok(searchModules(catalog, "REPAIRER omni").every((m) => m.name === "OMNI REPAIRER TURRET"));
  const heat = searchModules(catalog, "heat").map((m) => m.name);
  assert.ok(heat.includes("HEATSINK MAGAZINE"));
  assert.equal(heat[0], "HEATSINK MAGAZINE");
});

test("module search offers nothing for blank text or a missing catalog, and caps the list", () => {
  assert.deepEqual(searchModules(catalog, "   "), []);
  assert.deepEqual(searchModules(null, "survey"), []);
  assert.ok(searchModules(catalog, "e", 3).length <= 3);
});

test("moduleInfos names known defs and keeps unknown ones removable", () => {
  const def = catalog.items[0].def;
  assert.deepEqual(moduleInfos(catalog, [def, "1"]), [{ def, name: catalog.items[0].name }, { def: "1", name: "UNKNOWN MODULE" }]);
  assert.deepEqual(moduleInfos(null, ["1"]), [{ def: "1", name: "UNKNOWN MODULE" }]);
});
