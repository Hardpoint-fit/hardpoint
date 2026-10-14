import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURES } from "../../lib/engine/stub-engine.mjs";
import { cellSizeCss, cellSizeFor, GRID_CHROME_HEIGHT, siteGrid } from "./scale.ts";

const SITE_GRID = siteGrid(FIXTURES.catalog.gridStyle.cellSize);

test("the site grid runs from the game's own cell up to 88px", () => {
  assert.equal(SITE_GRID.min, 48);
  assert.equal(SITE_GRID.max, 88);
});

test("cellSizeFor fills the width, up to the largest cell", () => {
  // A 12x13 hull (the Scarab, cropped) in a laptop's fit panel with a tall window.
  assert.equal(cellSizeFor({ width: 640, height: 2000 }, { rows: 13, cols: 12 }, SITE_GRID), 53);
  // Room to spare: capped at 88.
  assert.equal(cellSizeFor({ width: 1600, height: 2000 }, { rows: 5, cols: 5 }, SITE_GRID), 88);
});

test("cellSizeFor lets the height shrink the cell, but not under the game's 48px", () => {
  assert.equal(cellSizeFor({ width: 900, height: 780 }, { rows: 13, cols: 12 }, SITE_GRID), 60);
  assert.equal(cellSizeFor({ width: 900, height: 300 }, { rows: 13, cols: 12 }, SITE_GRID), 48);
});

test("cellSizeFor never draws the grid wider than its panel: a phone goes under 48px", () => {
  assert.equal(cellSizeFor({ width: 311, height: 700 }, { rows: 13, cols: 12 }, SITE_GRID), 25);
  assert.ok(cellSizeFor({ width: 311, height: 700 }, { rows: 13, cols: 12 }, SITE_GRID) * 12 <= 311);
});

test("cellSizeFor takes another rule (the share card's fixed panel) and whole pixels only", () => {
  assert.equal(cellSizeFor({ width: 440, height: 440 }, { rows: 9, cols: 7 }, { min: 0, max: 88 }), 48);
  assert.equal(cellSizeFor({ width: 440, height: 440 }, { rows: 3, cols: 2 }, { min: 0, max: 88 }), 88);
  assert.ok(cellSizeFor({ width: 0, height: 0 }, { rows: 0, cols: 0 }, SITE_GRID) >= 1);
});

test("cellSizeCss writes the same rule for the browser to evaluate", () => {
  assert.equal(
    cellSizeCss({ rows: 13, cols: 12 }, SITE_GRID),
    `round(down, min(100cqw / 12, 88px, max(48px, (100svh - ${GRID_CHROME_HEIGHT}px) / 13)), 1px)`,
  );
});

/**
 * Evaluates `cellSizeCss`'s expression the way the browser does, for a container `width` wide in a
 * viewport whose height leaves `height` for the grid: CSS min/max are Math.min/max, round(down, x, 1px)
 * is Math.floor, lengths are pixels. Anything else in the expression fails the test.
 */
function evaluateCss(expression, { width, height }) {
  const js = expression
    .replace(/round\(down, (.*), 1px\)$/, "Math.floor($1)")
    .replaceAll("min(", "Math.min(")
    .replaceAll("max(", "Math.max(")
    .replaceAll("100cqw", String(width))
    .replaceAll("100svh", String(height + GRID_CHROME_HEIGHT))
    .replace(/(\d+(?:\.\d+)?)px/g, "$1");
  assert.match(js, /^[\d\s.+\-*/(),Mathflorinmax]+$/, `only arithmetic is left: ${js}`);
  return Function(`return ${js}`)();
}

test("the CSS rule and cellSizeFor agree on every size", () => {
  const spans = [
    { rows: 13, cols: 12 },
    { rows: 5, cols: 5 },
    { rows: 9, cols: 7 },
    { rows: 3, cols: 14 },
  ];
  const widths = [200, 311, 341, 576, 600, 635, 665, 830, 1200, 1600];
  const heights = [300, 500, 656, 788, 1000, 2000];
  for (const span of spans) {
    for (const width of widths) {
      for (const height of heights) {
        assert.equal(evaluateCss(cellSizeCss(span, SITE_GRID), { width, height }), cellSizeFor({ width, height }, span, SITE_GRID), JSON.stringify({ span, width, height }));
      }
    }
  }
  const card = { min: 0, max: 88 };
  assert.equal(evaluateCss(cellSizeCss({ rows: 9, cols: 7 }, card), { width: 440, height: 440 }), cellSizeFor({ width: 440, height: 440 }, { rows: 9, cols: 7 }, card));
});
