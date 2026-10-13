// Where a held item would land and whether it fits: inside the grid, on enabled cells, clear of the
// other modules. Only drag feedback, from the grid's geometry module; slot types, hardpoints and every
// other placement rule are the engine's. Pure: no React.
import { applySlotOverrides, cellKey, placeFootprint, placementFeedback, type Cell } from "#/components/grid/geometry";
import type { OpenFit, OpenModule, OpenPort } from "#/lib/engine/types";
import type { BuilderCatalog } from "./rules";

export type GridShape = { rows: number; cols: number; slots: string[] };

/** The hull's grid with the fit's slot overrides, or null when the hull isn't in the catalog. */
export function gridOf(cat: BuilderCatalog, fit: OpenFit): GridShape | null {
  const hull = cat.hulls.get(fit.hull.def);
  return hull ? { rows: hull.rows, cols: hull.cols, slots: applySlotOverrides(hull.slots, fit.slotOverrides) } : null;
}

/** The cells an item covers at a placement, cipher cells included. An unknown item covers its anchor. */
export function cellsAt(cat: BuilderCatalog, def: string, placement: { row: number; col: number; rotation: number }, ports: readonly OpenPort[] = []): Cell[] {
  const item = cat.items.get(def);
  if (!item) return [{ row: placement.row, col: placement.col }];
  const footprint = placeFootprint(item.shape.cells, placement, ports);
  return [...footprint.cells, ...footprint.expansions];
}

export function moduleCellsOf(cat: BuilderCatalog, module: OpenModule): Cell[] {
  return cellsAt(cat, module.item.def, module, module.item.roll.ports);
}

/** Every cell the fit's modules fill, but one's (the module being moved). */
export function takenCells(cat: BuilderCatalog, fit: OpenFit, except: number | null = null): Set<string> {
  const taken = new Set<string>();
  fit.modules.forEach((module, index) => {
    if (index !== except) for (const cell of moduleCellsOf(cat, module)) taken.add(cellKey(cell));
  });
  return taken;
}

/** What is being placed: a palette item or a fitted module, turned, held at a cursor cell. */
export type Held = {
  source: { kind: "palette"; def: string } | { kind: "module"; index: number };
  rotation: number;
  /** The grid cell under the pointer or keyboard cursor; null while off the grid. */
  cursor: Cell | null;
  /** The cursor's offset from the anchor, so a module moves by the cell it was grabbed by. */
  grab: Cell;
};

export function heldDef(fit: OpenFit, held: Held): string | null {
  return held.source.kind === "palette" ? held.source.def : (fit.modules[held.source.index]?.item.def ?? null);
}

export function heldPorts(fit: OpenFit, held: Held): readonly OpenPort[] {
  return held.source.kind === "module" ? (fit.modules[held.source.index]?.item.roll.ports ?? []) : [];
}

export type DropPreview = { anchor: Cell; cells: Cell[]; fits: boolean };

/** Where the held item would go and whether it fits; null while the cursor is off the grid. */
export function dropPreview(cat: BuilderCatalog, fit: OpenFit, held: Held): DropPreview | null {
  const grid = gridOf(cat, fit);
  const def = heldDef(fit, held);
  if (!grid || !held.cursor || def === null) return null;
  const anchor = { row: held.cursor.row - held.grab.row, col: held.cursor.col - held.grab.col };
  const cells = cellsAt(cat, def, { ...anchor, rotation: held.rotation }, heldPorts(fit, held));
  const except = held.source.kind === "module" ? held.source.index : null;
  return { anchor, cells, fits: placementFeedback(cells, grid, takenCells(cat, fit, except)).fits };
}

/** The first enabled cell, row by row: where a keyboard placement starts. */
export function firstOpenCell(grid: GridShape): Cell | null {
  const index = grid.slots.findIndex((slot) => slot !== "None");
  return index < 0 ? null : { row: Math.floor(index / grid.cols), col: index % grid.cols };
}
