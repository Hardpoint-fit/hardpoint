// How big a fitting-grid cell is drawn: the one rule that turns the space a grid has into a cell size.
//
// The rule: a cell is as large as the grid's width allows (the grid never overflows its panel), no
// larger than `max`, and no larger than the height allows unless that would take it under `min`
// (a tall hull lets the page scroll rather than shrink below the game's 48px cell). Whole pixels only,
// so cell edges land on pixel boundaries.
//
// Two evaluators of that one rule, side by side so they can't drift:
// - `cellSizeFor` evaluates it in numbers. The share card uses it for its fixed 440px panel, and the
//   test pins the rule down.
// - `cellSizeCss` writes it as a CSS expression for the site's grid. The browser evaluates it against
//   the grid's container (`.fg-scroll`, a size container) and the viewport, so the server render and
//   the first paint already have the final size: no measuring, no jump on hydration. fitting-grid.tsx
//   sets it as the registered `--fg-cell` property and derives every other length from it; the builder's
//   hit-testing reads the drawn grid's rectangle, so it follows the same size.
export type ScaleRule = {
  /** The smallest cell the height may push the grid to (the width can push it lower: phones). */
  min: number;
  /** The largest cell. */
  max: number;
};

/** The largest cell the site draws. */
export const SITE_GRID_MAX = 88;

/** The site's grid: from the game's own cell (the grid style's `cellSize`, 48px) up to SITE_GRID_MAX. */
export function siteGrid(cellSize: number): ScaleRule {
  return { min: cellSize, max: SITE_GRID_MAX };
}

/**
 * Viewport height kept for what surrounds the grid (site header, panel header, the grid's padding), so
 * a grid sized by height fits the window without scrolling.
 */
export const GRID_CHROME_HEIGHT = 112;

export type GridSpan = { rows: number; cols: number };

export function cellSizeFor(available: { width: number; height: number }, span: GridSpan, rule: ScaleRule): number {
  const byWidth = available.width / Math.max(1, span.cols);
  const byHeight = Math.max(rule.min, available.height / Math.max(1, span.rows));
  return Math.max(1, Math.floor(Math.min(byWidth, rule.max, byHeight)));
}

/** `cellSizeFor` as CSS: the width is the grid container's (`100cqw`), the height the viewport's less the chrome. */
export function cellSizeCss(span: GridSpan, rule: ScaleRule): string {
  const cols = Math.max(1, span.cols);
  const rows = Math.max(1, span.rows);
  return `round(down, min(100cqw / ${cols}, ${rule.max}px, max(${rule.min}px, (100svh - ${GRID_CHROME_HEIGHT}px) / ${rows})), 1px)`;
}
