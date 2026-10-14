// The drop verdict: bounds, the catalog's cell rules, matching hardpoints and overlap, with rotation,
// against the catalog's shapes and the engine's own verdicts.
import assert from "node:assert/strict";
import test from "node:test";
import { cellKey } from "../grid/geometry.ts";
import { FIXTURES } from "../../lib/engine/stub-engine.mjs";
import { cellsAt, dropPreview, firstOpenCell, fitsAnywhere, gridOf, hardpointTargets, nowhereReason, placementContext, placementVerdict, takenCells } from "./placement.ts";
import { indexCatalog } from "./rules.ts";
import { initialState, reduce } from "./state.ts";
import { SCARAB, SERAPH, itemNamed } from "./test-catalog.mjs";

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
  assert.equal(dropPreview(cat, empty, held(HEATSINK.def, { row: 4, col: 6 })).verdict.ok, true);
  assert.equal(dropPreview(cat, empty, held(HEATSINK.def, { row: 14, col: 14 })).verdict.ok, false, "runs off the grid");
  assert.equal(dropPreview(cat, empty, held(HEATSINK.def, { row: 11, col: 7 })).verdict.ok, false, "row 12 is disabled");
  assert.equal(dropPreview(cat, empty, held(HEATSINK.def, { row: 4, col: 6 }, 1)).verdict.ok, true);
  // With a conduit at (5,6): the unturned L covers it, turned twice it covers (4,6) (4,7) (5,7) instead.
  const withTurret = reduce(cat, reduce(cat, reduce(cat, { ...initialState(empty) }, { type: "pickUp", def: itemNamed(catalog, "PROPULSION CONDUIT").def }), { type: "hover", cell: { row: 5, col: 6 } }), { type: "drop" }).fit;
  assert.equal(withTurret.modules.length, 1);
  assert.equal(dropPreview(cat, withTurret, held(HEATSINK.def, { row: 4, col: 6 }, 0)).verdict.ok, false, "rotation 0 covers (5,6)");
  assert.equal(dropPreview(cat, withTurret, held(HEATSINK.def, { row: 4, col: 6 }, 2)).verdict.ok, true, "rotation 2 doesn't");
  assert.equal(dropPreview(cat, empty, held(HEATSINK.def, null)), null, "off the grid: no preview");
});

test("overlap feedback agrees with the engine's verdict for a turned module beside a cipher cell", () => {
  const fit = FIXTURES.fitShowcase;
  for (const verdict of FIXTURES.rotationOracle.cases) {
    const module = fit.modules[verdict.moduleIndex];
    const moving = { source: { kind: "module", index: verdict.moduleIndex }, rotation: verdict.rotation, cursor: { row: module.row, col: module.col }, grab: { row: 0, col: 0 } };
    const overlaps = verdict.issues.some((issue) => issue.kind === "Overlap");
    assert.equal(dropPreview(cat, fit, moving).verdict.ok, !overlaps, `rotation ${verdict.rotation}`);
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
  assert.equal(dropPreview(cat, FIXTURES.fit, held(itemNamed(catalog, "PROPULSION CONDUIT").def, { row: 0, col: 0 })).verdict.ok, true);
  assert.deepEqual(firstOpenCell(grid), { row: 0, col: 0 });
});

// ---- The verdict -----------------------------------------------------------------------------

const HARDENER = itemNamed(catalog, "ARMOR HARDENER");
const TURRET = itemNamed(catalog, "OMNI REPAIRER TURRET");
const SERAPH_FIT = reduce(cat, initialState(), { type: "start", hull: SERAPH }).fit;
const at = (def, row, col, rotation = 0, fit = empty, extra = {}) => placementVerdict(cat, fit, { def, anchor: { row, col }, rotation, ...extra });

test("the catalog carries the game's cell rules: battery, subsystem and propulsion items need their own hardpoint", () => {
  assert.equal(HARDENER.slotType, "Subsystem");
  assert.deepEqual(cat.placement.get("Subsystem"), { slotType: "Subsystem", covers: ["Battery", "Subsystem", "Core", "Propulsion", "Harpoon"], hardpoint: "Subsystem" });
  assert.equal(cat.placement.get("Core").hardpoint, null);
});

test("ARMOR HARDENER is refused off a subsystem hardpoint, with the reason, and taken over one", () => {
  // SCARAB's subsystem hardpoints are (7,6) (7,7) (8,5). Unturned, the 1x3 runs down a column.
  const shape = (rotation) => cellsAt(cat, HARDENER.def, { row: 0, col: 0, rotation }).map(cellKey).sort();
  assert.deepEqual(shape(0), ["0,0", "1,0", "2,0"]);
  const off = at(HARDENER.def, 4, 6);
  assert.equal(off.ok, false);
  assert.equal(off.kind, "MissingHardpoint");
  assert.equal(off.reason, "NEEDS A SUBSYSTEM HARDPOINT");
  assert.deepEqual(off.offending.map(cellKey), off.cells.map(cellKey), "the whole footprint is to blame");
  const on = at(HARDENER.def, 5, 6);
  assert.equal(on.ok, true, "(5,6) (6,6) (7,6) covers the hardpoint at (7,6)");
  assert.deepEqual(keys(on.cells), ["5,6", "6,6", "7,6"]);
});

test("rotation moves the footprint onto or off a hardpoint", () => {
  // At (6,6) the unturned 1x3 runs down to the hardpoint at (7,6); turned once it lies along row 6,
  // over (6,6) (6,7) (6,8), none of them a subsystem hardpoint.
  assert.equal(at(HARDENER.def, 6, 6, 0).ok, true);
  assert.deepEqual(keys(at(HARDENER.def, 6, 6, 1).cells), ["6,6", "6,7", "6,8"]);
  assert.equal(at(HARDENER.def, 6, 6, 1).reason, "NEEDS A SUBSYSTEM HARDPOINT");
  assert.equal(at(HARDENER.def, 7, 5, 1).ok, true, "along row 7 it covers both hardpoints there");
});

test("a battery item needs a battery hardpoint, a core item doesn't need one", () => {
  assert.equal(at(TURRET.def, 5, 8).ok, true, "(5,8) is a battery hardpoint");
  assert.equal(at(TURRET.def, 5, 6).reason, "NEEDS A BATTERY HARDPOINT");
  assert.equal(at(itemNamed(catalog, "TRACER ROUNDS").def, 4, 6).ok, true);
});

test("outside the grid and on cells that aren't part of the fitting reads OUTSIDE THE GRID", () => {
  const off = at(HARDENER.def, 13, 7);
  assert.equal(off.kind, "OutOfBounds");
  assert.equal(off.reason, "OUTSIDE THE GRID");
  assert.deepEqual(keys(off.offending), ["13,7", "14,7", "15,7"], "row 15 is past the grid, rows 13 and 14 aren't fitting cells");
  const none = at(HARDENER.def, 0, 0);
  assert.equal(none.kind, "SlotNotFittable");
  assert.equal(none.reason, "OUTSIDE THE GRID");
});

test("a cell type no module fits on is named", () => {
  const fit = { ...empty, slotOverrides: [{ cell: 4 * 15 + 6, slotType: "SafetyCargo" }] };
  const verdict = at(itemNamed(catalog, "TRACER ROUNDS").def, 4, 6, 0, fit);
  assert.equal(verdict.kind, "SlotNotFittable");
  assert.equal(verdict.reason, "NOTHING FITS ON SAFETY CARGO CELLS");
  assert.deepEqual(keys(verdict.offending), ["4,6"]);
});

test("overlap names the module in the way; a moved module doesn't block itself", () => {
  const one = withModuleAt(TURRET.def, 5, 8);
  const verdict = at(itemNamed(catalog, "TRACER ROUNDS").def, 4, 8, 0, one);
  assert.equal(verdict.kind, "Overlap");
  assert.equal(verdict.reason, "OVERLAPS OMNI REPAIRER TURRET");
  assert.deepEqual(keys(verdict.offending), ["5,8"]);
  assert.equal(at(TURRET.def, 5, 8, 0, one, { moving: 0 }).ok, true);
});

test("bounds come before cell types, cell types before overlap, overlap before the hardpoint", () => {
  const one = withModuleAt(TURRET.def, 5, 8);
  // From (4,8) down: (4,8) Core, (5,8) the turret, (6,8) Core; no subsystem hardpoint either.
  assert.equal(at(HARDENER.def, 4, 8, 0, one).kind, "Overlap");
  assert.equal(at(HARDENER.def, 13, 8, 0, one).kind, "OutOfBounds");
});

test("the held item's hardpoint targets are the empty cells of its type", () => {
  assert.deepEqual(keys(hardpointTargets(cat, empty, HARDENER.def)), ["7,6", "7,7", "8,5"]);
  assert.deepEqual(hardpointTargets(cat, empty, itemNamed(catalog, "TRACER ROUNDS").def), [], "a core item needs none");
  const one = withModuleAt(TURRET.def, 5, 8);
  assert.deepEqual(keys(hardpointTargets(cat, one, TURRET.def)), ["3,6", "3,8", "6,7"]);
  assert.deepEqual(keys(hardpointTargets(cat, one, TURRET.def, 0)), ["3,6", "3,8", "5,8", "6,7"], "the moved turret frees its own");
});

test("an item fits nowhere when its hardpoints are gone, and the palette says why", () => {
  assert.equal(fitsAnywhere(cat, empty, HARDENER.def), true);
  let full = empty;
  for (const [row, col] of [[3, 6], [3, 8], [5, 8], [6, 7]]) full = withModuleAt(TURRET.def, row, col, full);
  assert.equal(full.modules.length, 4);
  assert.equal(fitsAnywhere(cat, full, TURRET.def), false);
  assert.equal(nowhereReason(cat, full, TURRET.def), "EVERY BATTERY HARDPOINT IS TAKEN. REMOVE A MODULE TO FREE ONE");
  const noSubsystems = { ...SERAPH_FIT, slotOverrides: [{ cell: 4 * 15 + 7, slotType: "Core" }, { cell: 8 * 15 + 7, slotType: "Core" }] };
  assert.equal(fitsAnywhere(cat, noSubsystems, HARDENER.def), false);
  assert.equal(nowhereReason(cat, noSubsystems, HARDENER.def), "THIS HULL HAS NO SUBSYSTEM HARDPOINT", "nothing to remove: the hull can't take it");
  const crowded = withModuleAt(TURRET.def, 4, 6, noSubsystems);
  assert.equal(nowhereReason(cat, crowded, HARDENER.def), "THIS HULL HAS NO SUBSYSTEM HARDPOINT", "modules fitted, but removing one wouldn't help");
});

test("an item walled out by fitted modules says removing one frees room", () => {
  const conduit = itemNamed(catalog, "PROPULSION CONDUIT").def;
  const tracer = itemNamed(catalog, "TRACER ROUNDS").def;
  const hull = cat.hulls.get(SERAPH);
  const modules = hull.slots.flatMap((slot, index) =>
    slot === "None" ? [] : [{ item: { def: conduit, roll: SERAPH_FIT.hull.roll, patina: 0 }, row: Math.floor(index / hull.cols), col: index % hull.cols, rotation: 0 }],
  );
  const full = { ...SERAPH_FIT, modules };
  assert.equal(fitsAnywhere(cat, full, tracer), false);
  assert.equal(nowhereReason(cat, full, tracer), "NO ROOM LEFT ON THE GRID. REMOVE A MODULE TO FREE ONE");
  assert.equal(nowhereReason(cat, full, HARDENER.def), "EVERY SUBSYSTEM HARDPOINT IS TAKEN. REMOVE A MODULE TO FREE ONE");
});

test("a catalog without placement rules (an older engine) checks only bounds and overlap", () => {
  const old = structuredClone(catalog);
  delete old.placement;
  const bare = indexCatalog(old);
  assert.equal(bare.placement, null);
  assert.equal(placementVerdict(bare, empty, { def: HARDENER.def, anchor: { row: 4, col: 6 }, rotation: 0 }).ok, true, "the engine judges the hardpoint after the drop");
  assert.equal(placementVerdict(bare, empty, { def: HARDENER.def, anchor: { row: 13, col: 7 }, rotation: 0 }).ok, false, "still inside the grid");
  assert.deepEqual(hardpointTargets(bare, empty, HARDENER.def), []);
  assert.equal(fitsAnywhere(bare, empty, HARDENER.def), true);
});

test("the builder refuses exactly the drops the engine refuses (recorded engine verdicts)", () => {
  const oracle = FIXTURES.placementOracle;
  // The recording's extra hulls come from the engine's catalog for the same build.
  const wide = indexCatalog({ ...catalog, hulls: [...catalog.hulls, ...oracle.hulls] });
  const bases = { SCARAB: empty, SERAPH: SERAPH_FIT, "fit.json": FIXTURES.fit, ...oracle.bases };
  for (const hull of oracle.hulls) bases[hull.name] = reduce(wide, initialState(), { type: "start", hull: hull.def }).fit;
  let checked = 0;
  const seen = { ported: 0, moved: 0, hulls: new Set(), letters: new Set() };
  for (const recorded of oracle.cases) {
    const fit = bases[recorded.base];
    assert.ok(fit, recorded.base);
    seen.hulls.add(fit.hull.def);
    if (recorded.ports.some((port) => port.cipher !== null)) seen.ported++;
    if (recorded.moving !== null) seen.moved++;
    const context = placementContext(wide, fit, recorded.moving);
    let index = 0;
    for (let row = recorded.rows[0]; row <= recorded.rows[1]; row++) {
      for (let col = recorded.cols[0]; col <= recorded.cols[1]; col++) {
        const engine = recorded.verdicts[index++];
        seen.letters.add(engine);
        const verdict = placementVerdict(wide, fit, { def: recorded.item, anchor: { row, col }, rotation: recorded.rotation, ports: recorded.ports, moving: recorded.moving }, context);
        const where = `${recorded.base} ${recorded.name}${recorded.ports.length ? " ported" : ""}${recorded.moving !== null ? " moved" : ""} r${recorded.rotation} at (${row},${col}): engine ${engine}, builder ${verdict.ok ? "." : verdict.kind}`;
        assert.equal(verdict.ok, engine === ".", where);
        if (engine === "H") assert.equal(verdict.kind, "MissingHardpoint", where);
        checked++;
      }
    }
  }
  assert.ok(checked > 20000, `${checked} drops checked`);
  assert.ok(seen.hulls.size >= 5, "five hulls");
  assert.ok(seen.ported >= 40, "ported drops");
  assert.ok(seen.moved >= 12, "moved modules");
  for (const letter of [".", "S", "O", "H"]) assert.ok(seen.letters.has(letter), `the recording has ${letter} verdicts`);
});

function withModuleAt(def, row, col, fit = empty) {
  const placed = reduce(cat, reduce(cat, reduce(cat, initialState(fit), { type: "pickUp", def }), { type: "hover", cell: { row, col } }), { type: "drop" }).fit;
  assert.equal(placed.modules.length, fit.modules.length + 1, `placed at (${row},${col})`);
  return placed;
}
