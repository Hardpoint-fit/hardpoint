import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FIXTURES } from "../../lib/engine/stub-engine.mjs";
import {
  applySlotOverrides,
  iconArea,
  occupiedCells,
  outerEdges,
  overlappingItems,
  placeFootprint,
  rotateDirection,
  rotateShape,
  rotateShapeCell,
  visibleBounds,
} from "./geometry.ts";

const catalog = FIXTURES.catalog;
const items = new Map(catalog.items.map((item) => [item.def, item]));
const hull = catalog.hulls[0];
// The game's own rotation tables, exported from ModuleShapeMask for the UI prototype.
const unity = JSON.parse(
  readFileSync(new URL("../../../../../../src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/Panels/Fitting/UI/FittingPanel.fixture.json", import.meta.url), "utf8"),
);

const footprintOf = (module) => {
  const item = items.get(module.item.def);
  return placeFootprint(item.shape.cells, module, module.item.roll.ports);
};
const occupied = (fit) => fit.modules.map((module) => occupiedCells(footprintOf(module)));

test("a shape cell turns clockwise in the 5x5 grid and comes back after four turns", () => {
  assert.deepEqual(rotateShapeCell({ row: 0, col: 0 }, 1), { row: 0, col: 4 });
  assert.deepEqual(rotateShapeCell({ row: 0, col: 1 }, 1), { row: 1, col: 4 });
  assert.deepEqual(rotateShapeCell({ row: 1, col: 3 }, 2), { row: 3, col: 1 });
  assert.deepEqual(rotateShapeCell({ row: 1, col: 3 }, 3), { row: 1, col: 1 });
  assert.deepEqual(rotateShapeCell({ row: 1, col: 3 }, -1), rotateShapeCell({ row: 1, col: 3 }, 3));
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      let cell = { row, col };
      for (let turn = 0; turn < 4; turn++) cell = rotateShapeCell(cell, 1);
      assert.deepEqual(cell, { row, col });
      // The same table Unity exports for the prototype.
      for (let rotation = 0; rotation < 4; rotation++) {
        const [r, c] = unity.rotations.locations[rotation][row * 5 + col];
        assert.deepEqual(rotateShapeCell({ row, col }, rotation), { row: r, col: c });
      }
    }
  }
});

test("port directions turn with the item as the game's table says", () => {
  const order = ["Up", "Down", "Left", "Right"];
  for (let rotation = 0; rotation < 4; rotation++) {
    order.forEach((direction, index) => {
      assert.equal(rotateDirection(direction, rotation), order[unity.rotations.directions[rotation][index]]);
    });
  }
});

test("every catalog shape turns to the game's footprint and origin at each rotation", () => {
  const sizes = new Map(catalog.items.map((item) => [item.slotSize, item.shape]));
  assert.ok(sizes.size >= 4, "the fixture has several shapes");
  for (const [size, shape] of sizes) {
    for (let rotation = 0; rotation < 4; rotation++) {
      const turned = rotateShape(shape.cells, rotation);
      const [originRow, originCol] = unity.origins[size][rotation];
      assert.deepEqual(turned.origin, { row: originRow, col: originCol }, `${size} origin at ${rotation}`);
      const normalized = turned.cells.map((c) => [c.row - originRow, c.col - originCol]).sort();
      const expected = unity.footprints[unity.shapes[size][rotation]].map(([r, c]) => [r, c]).sort();
      assert.deepEqual(normalized, expected, `${size} footprint at ${rotation}`);
    }
    assert.deepEqual(rotateShape(shape.cells, 0).origin, { row: shape.originRow, col: shape.originCol });
  }
});

test("a placement anchors the shape's origin, and a ciphered port fills the cell it opens onto", () => {
  const scanner = FIXTURES.fitShowcase.modules[3];
  const placed = footprintOf(scanner);
  assert.deepEqual(placed.cells, [{ row: 4, col: 7 }, { row: 5, col: 7 }]);
  assert.deepEqual(placed.expansions, [{ row: 6, col: 7 }]);
  assert.equal(placed.ports[0].direction, "Down");
  assert.deepEqual(placed.ports[0].cell, { row: 5, col: 7 });

  // Turned a quarter, the Down port opens Left from the cell the anchor turned to.
  const turned = placeFootprint(items.get(scanner.item.def).shape.cells, { row: 4, col: 7, rotation: 1 }, scanner.item.roll.ports);
  assert.deepEqual(turned.cells, [{ row: 4, col: 8 }, { row: 4, col: 7 }]);
  assert.equal(turned.ports[0].direction, "Left");
  assert.deepEqual(turned.expansions, [{ row: 4, col: 6 }]);

  // An empty port fills nothing.
  const empty = placeFootprint(items.get(scanner.item.def).shape.cells, scanner, [{ row: 3, col: 2, direction: "Down", cipher: null }]);
  assert.deepEqual(empty.expansions, []);
  assert.equal(empty.ports[0].expansion, null);
});

test("overlaps agree with the engine's verdict for each rotation of a module next to a cipher cell", () => {
  const { cases } = FIXTURES.rotationOracle;
  assert.equal(cases.length, 4);
  for (const { moduleIndex, rotation, valid, issues } of cases) {
    const fit = structuredClone(FIXTURES.fitShowcase);
    fit.modules[moduleIndex].rotation = rotation;
    const overlapping = overlappingItems(occupied(fit));
    const engineOverlap = issues.some((issue) => issue.kind === "Overlap" && issue.moduleIndex === moduleIndex);
    assert.equal(overlapping.has(moduleIndex), engineOverlap, `rotation ${rotation}`);
    assert.equal(overlapping.size === 0, valid, `rotation ${rotation}`);
  }
});

test("the engine's overlapping fit overlaps here too", () => {
  const fit = FIXTURES.fit;
  const overlapping = { ...fit, modules: [fit.modules[0], fit.modules[0]] };
  assert.deepEqual([...overlappingItems(occupied(overlapping))].sort(), [0, 1]);
  assert.equal(overlappingItems(occupied(fit)).size, 0);
});

test("outer edges outline an L", () => {
  const edges = outerEdges([
    { row: 0, col: 0 },
    { row: 1, col: 0 },
    { row: 1, col: 1 },
  ]);
  assert.deepEqual(edges.get("0,0"), { top: true, right: true, bottom: false, left: true });
  assert.deepEqual(edges.get("1,0"), { top: false, right: false, bottom: true, left: true });
  assert.deepEqual(edges.get("1,1"), { top: true, right: true, bottom: true, left: false });
});

test("the visible part of a hull is its enabled cells with a one-cell margin", () => {
  const bounds = visibleBounds(hull.slots, hull);
  // SCARAB's enabled cells span rows 3-11 and columns 4-10.
  assert.deepEqual(bounds, { minRow: 2, minCol: 3, rows: 11, cols: 9 });
  assert.deepEqual(visibleBounds(Array(4).fill("None"), { rows: 2, cols: 2 }), { minRow: 0, minCol: 0, rows: 2, cols: 2 });
});

test("slot overrides replace a hull cell's slot type", () => {
  const slots = applySlotOverrides(["None", "Core"], [{ cell: 0, slotType: "Core" }, { cell: 9, slotType: "Core" }]);
  assert.deepEqual(slots, ["Core", "Core"]);
});

test("a module's icon centres on a rectangle's bounds and on the elbow of an L or a T", () => {
  const rect = [{ row: 2, col: 3 }, { row: 2, col: 4 }, { row: 3, col: 3 }, { row: 3, col: 4 }];
  assert.deepEqual(iconArea(rect), { minRow: 2, minCol: 3, rows: 2, cols: 2 });
  const ell = [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 1, col: 1 }];
  assert.deepEqual(iconArea(ell), { minRow: 1, minCol: 0, rows: 1, cols: 1 });
  const tee = [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 1, col: 1 }];
  assert.deepEqual(iconArea(tee), { minRow: 0, minCol: 1, rows: 1, cols: 1 });
  assert.equal(iconArea([]), null);
});
