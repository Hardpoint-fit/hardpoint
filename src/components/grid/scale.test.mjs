import assert from "node:assert/strict";
import test from "node:test";
import art from "./fitting-art.generated.json" with { type: "json" };
import { cellSizeCss, cellSizeFor, GRID_CHROME_HEIGHT, SITE_GRID } from "./scale.ts";

test("the site grid runs from the game's own cell up to 88px", () => {
  assert.equal(SITE_GRID.min, art.cellSize);
  assert.equal(SITE_GRID.max, 88);
});

test("cellSizeFor fills the width, up to the largest cell", () => {
  // A 12x13 hull (the Scarab, cropped) in a laptop's fit panel with a tall window.
  assert.equal(cellSizeFor({ width: 640, height: 2000 }, { rows: 13, cols: 12 }), 53);
  // Room to spare: capped at 88.
  assert.equal(cellSizeFor({ width: 1600, height: 2000 }, { rows: 5, cols: 5 }), 88);
});

test("cellSizeFor lets the height shrink the cell, but not under the game's 48px", () => {
  assert.equal(cellSizeFor({ width: 900, height: 780 }, { rows: 13, cols: 12 }), 60);
  assert.equal(cellSizeFor({ width: 900, height: 300 }, { rows: 13, cols: 12 }), 48);
});

test("cellSizeFor never draws the grid wider than its panel: a phone goes under 48px", () => {
  assert.equal(cellSizeFor({ width: 311, height: 700 }, { rows: 13, cols: 12 }), 25);
  assert.ok(cellSizeFor({ width: 311, height: 700 }, { rows: 13, cols: 12 }) * 12 <= 311);
});

test("cellSizeFor takes another rule (the share card's fixed panel) and whole pixels only", () => {
  assert.equal(cellSizeFor({ width: 440, height: 440 }, { rows: 9, cols: 7 }, { min: 0, max: 88 }), 48);
  assert.equal(cellSizeFor({ width: 440, height: 440 }, { rows: 3, cols: 2 }, { min: 0, max: 88 }), 88);
  assert.ok(cellSizeFor({ width: 0, height: 0 }, { rows: 0, cols: 0 }) >= 1);
});

test("cellSizeCss writes the same rule for the browser to evaluate", () => {
  assert.equal(
    cellSizeCss({ rows: 13, cols: 12 }),
    `round(down, min(100cqw / 12, 88px, max(48px, (100svh - ${GRID_CHROME_HEIGHT}px) / 13)), 1px)`,
  );
});
