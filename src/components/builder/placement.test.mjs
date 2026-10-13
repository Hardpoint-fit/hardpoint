// Drag feedback: bounds, disabled cells and overlap, with rotation, against the catalog's shapes and
// the engine's own verdicts.
import assert from "node:assert/strict";
import test from "node:test";
import { cellKey } from "../grid/geometry.ts";
import { FIXTURES } from "../../lib/engine/stub-engine.mjs";
import { cellsAt, dropPreview, firstOpenCell, gridOf, takenCells } from "./placement.ts";
import { indexCatalog } from "./rules.ts";
import { initialState, reduce } from "./state.ts";
import { SCARAB, itemNamed } from "./test-catalog.mjs";

const catalog = FIXTURES.catalog;
const cat = indexCatalog(catalog);
const HEATSINK = itemNamed(catalog, "HEATSINK MAGAZINE");
const empty = reduce(cat, initialState(), { type: "start", hull: SCARAB }).fit;
const held = (def, cursor, rotation = 0) => ({ source: { kind: "palette", def }, rotation, cursor, grab: { row: 0, col: 0 } });
const keys = (cells) => cells.map(cellKey).sort();

test("an L triomino turns clockwise about the shape grid and anchors at its turned bounds' top-left", () => {
  // Rotation 0: (2,2) (3,2) (3,3). Rotation 1 turns (r, c) to (c, 4 - r): (2,2) (2,1) (3,1), origin (2,1).
  const expected = [
    ["4,6", "5,6", "5,7"],
    ["4,6", "4,7", "5,6"],
    ["4,6", "4,7", "5,7"],
    ["4,7", "5,6", "5,7"],
  ];
  for (let rotation = 0; rotation < 4; rotation++) {
    assert.deepEqual(keys(cellsAt(cat, HEATSINK.def, { row: 4, col: 6, rotation })), expected[rotation], `rotation ${rotation}`);
  }
});

test("every catalog shape keeps its cell count at every rotation and fits on the open SCARAB core", () => {
  for (const item of catalog.items) {
    for (let rotation = 0; rotation < 4; rotation++) {
      const cells = cellsAt(cat, item.def, { row: 4, col: 6, rotation });
      assert.equal(cells.length, item.shape.cells.length, `${item.name} r${rotation}`);
      assert.equal(new Set(cells.map(cellKey)).size, cells.length);
    }
  }
});

test("the preview refuses cells outside the grid, disabled cells and other modules' cells", () => {
  assert.equal(dropPreview(cat, empty, held(HEATSINK.def, { row: 4, col: 6 })).fits, true);
  assert.equal(dropPreview(cat, empty, held(HEATSINK.def, { row: 14, col: 14 })).fits, false, "runs off the grid");
  assert.equal(dropPreview(cat, empty, held(HEATSINK.def, { row: 11, col: 7 })).fits, false, "row 12 is disabled");
  assert.equal(dropPreview(cat, empty, held(HEATSINK.def, { row: 4, col: 6 }, 1)).fits, true);
  // With a turret at (5,6): the unturned L covers it, turned twice it covers (4,6) (4,7) (5,7) instead.
  const withTurret = reduce(cat, reduce(cat, reduce(cat, { ...initialState(empty) }, { type: "pickUp", def: itemNamed(catalog, "OMNI REPAIRER TURRET").def }), { type: "hover", cell: { row: 5, col: 6 } }), { type: "drop" }).fit;
  assert.equal(withTurret.modules.length, 1);
  assert.equal(dropPreview(cat, withTurret, held(HEATSINK.def, { row: 4, col: 6 }, 0)).fits, false, "rotation 0 covers (5,6)");
  assert.equal(dropPreview(cat, withTurret, held(HEATSINK.def, { row: 4, col: 6 }, 2)).fits, true, "rotation 2 doesn't");
  assert.equal(dropPreview(cat, empty, held(HEATSINK.def, null)), null, "off the grid: no preview");
});

test("overlap feedback agrees with the engine's verdict for a turned module beside a cipher cell", () => {
  const fit = FIXTURES.fitShowcase;
  for (const verdict of FIXTURES.rotationOracle.cases) {
    const module = fit.modules[verdict.moduleIndex];
    const moving = { source: { kind: "module", index: verdict.moduleIndex }, rotation: verdict.rotation, cursor: { row: module.row, col: module.col }, grab: { row: 0, col: 0 } };
    const overlaps = verdict.issues.some((issue) => issue.kind === "Overlap");
    assert.equal(dropPreview(cat, fit, moving).fits, !overlaps, `rotation ${verdict.rotation}`);
  }
});

test("a module being moved doesn't block itself; cipher cells count as taken", () => {
  const fit = FIXTURES.fitShowcase;
  const all = takenCells(cat, fit);
  const without = takenCells(cat, fit, 3);
  assert.ok(all.size > without.size);
  const ciphered = fit.modules.findIndex((module) => module.item.roll.ports.some((port) => port.cipher !== null));
  assert.ok(ciphered >= 0);
  const cells = cellsAt(cat, fit.modules[ciphered].item.def, fit.modules[ciphered], fit.modules[ciphered].item.roll.ports);
  assert.equal(cells.length, itemNamed(catalog, "SURVEY SCANNER").shape.cells.length + 1, "the cipher fills one more cell");
});

test("slot overrides open cells the hull has disabled", () => {
  const grid = gridOf(cat, FIXTURES.fit);
  assert.equal(grid.slots[0], "Core", "fit.json overrides cell 0");
  assert.equal(dropPreview(cat, FIXTURES.fit, held(itemNamed(catalog, "PROPULSION CONDUIT").def, { row: 0, col: 0 })).fits, true);
  assert.deepEqual(firstOpenCell(grid), { row: 0, col: 0 });
});
