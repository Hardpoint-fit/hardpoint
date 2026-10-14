// Where a held item would land and whether the game would take it there, decided before the drop: inside
// the grid, on cells its slot type may cover, over a matching hardpoint when it needs one, and clear of
// the other modules. The cell rules are the engine catalog's `placement`, which the engine reads from the
// game's FittingSlotRules (and tests against its placement walk); this module only applies them to the
// grid's geometry. Rules a drop can't break with a fresh roll (battery families, unique regalia,
// artifacts and heretical specials) stay with the engine's evaluation. Pure: no React.
import { applySlotOverrides, cellKey, insideGrid, placeFootprint, type Cell } from "#/components/grid/geometry";
import type { OpenFit, OpenModule, OpenPort } from "#/lib/engine/types";
import { enumWords } from "./labels";
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

/** Which module (by index) fills each cell, but one's (the module being moved). */
export function cellOwners(cat: BuilderCatalog, fit: OpenFit, except: number | null = null): Map<string, number> {
  const owners = new Map<string, number>();
  fit.modules.forEach((module, index) => {
    if (index !== except) for (const cell of moduleCellsOf(cat, module)) if (!owners.has(cellKey(cell))) owners.set(cellKey(cell), index);
  });
  return owners;
}

/** Every cell the fit's modules fill, but one's (the module being moved). */
export function takenCells(cat: BuilderCatalog, fit: OpenFit, except: number | null = null): Set<string> {
  return new Set(cellOwners(cat, fit, except).keys());
}

/** The engine's issue kind each refusal stands for (StableLoadoutIssueKind). */
export type RefusalKind = "UnknownItem" | "OutOfBounds" | "SlotNotFittable" | "Overlap" | "MissingHardpoint";

export type Verdict =
  | { ok: true; cells: Cell[] }
  /** `reason` is the player-facing words; `offending` the footprint cells to blame (all of them for a missing hardpoint). */
  | { ok: false; kind: RefusalKind; reason: string; cells: Cell[]; offending: Cell[] };

/** What a verdict is asked about: an item (with its ports, for cipher cells) at an anchor and rotation. */
export type Candidate = {
  def: string;
  anchor: Cell;
  rotation: number;
  ports?: readonly OpenPort[];
  /** The fitted module being moved, which doesn't block itself. */
  moving?: number | null;
};

/** Words for a slot type's cell: hardpoints by their type, CORE SLOT for the rest. */
export function hardpointName(slotType: string): string {
  return slotType === "Core" ? "CORE SLOT" : `${enumWords(slotType)} HARDPOINT`;
}

/** Context a verdict reads, built once per fit (and per moved module) so anchor scans stay cheap. */
export type PlacementContext = { grid: GridShape; owners: Map<string, number> };

export function placementContext(cat: BuilderCatalog, fit: OpenFit, moving: number | null = null): PlacementContext | null {
  const grid = gridOf(cat, fit);
  return grid ? { grid, owners: cellOwners(cat, fit, moving) } : null;
}

/**
 * Whether the game would take the item here, judged as FittingPlacementRules walks a footprint: every cell
 * inside the grid, of a type the item's slot type may cover, not taken, and (for a battery, subsystem or
 * propulsion item) at least one cell of its own type. The first broken rule is the reason, in that order.
 */
export function placementVerdict(cat: BuilderCatalog, fit: OpenFit, candidate: Candidate, context?: PlacementContext | null): Verdict {
  const ctx = context ?? placementContext(cat, fit, candidate.moving ?? null);
  const item = cat.items.get(candidate.def);
  const cells = cellsAt(cat, candidate.def, { ...candidate.anchor, rotation: candidate.rotation }, candidate.ports ?? []);
  const refuse = (kind: RefusalKind, reason: string, offending: Cell[]): Verdict => ({ ok: false, kind, reason, cells, offending });
  if (!ctx || !item) return refuse("UnknownItem", "NOT IN THE CURRENT BUILD", cells);
  // Without the catalog's rules (an older engine) only bounds and overlap are checked here.
  const rule = cat.placement ? cat.placement.get(item.slotType) : { slotType: item.slotType, covers: null, hardpoint: null };
  if (!rule) return refuse("SlotNotFittable", `${enumWords(item.slotType)} ITEMS CAN'T BE FITTED`, cells);
  const { grid, owners } = ctx;

  const outside = cells.filter((cell) => !insideGrid(cell, grid) || grid.slots[cell.row * grid.cols + cell.col] === "None");
  if (outside.length > 0) return refuse(outside.some((cell) => !insideGrid(cell, grid)) ? "OutOfBounds" : "SlotNotFittable", "OUTSIDE THE GRID", outside);

  const slotOf = (cell: Cell) => grid.slots[cell.row * grid.cols + cell.col]!;
  const covers = rule.covers;
  const unfit = covers === null ? [] : cells.filter((cell) => !covers.includes(slotOf(cell)));
  if (unfit.length > 0) return refuse("SlotNotFittable", `NOTHING FITS ON ${enumWords(slotOf(unfit[0]!))} CELLS`, unfit);

  const overlapping = cells.filter((cell) => owners.has(cellKey(cell)));
  if (overlapping.length > 0) {
    const other = fit.modules[owners.get(cellKey(overlapping[0]!))!];
    const name = other ? (cat.items.get(other.item.def)?.name ?? "ANOTHER MODULE") : "ANOTHER MODULE";
    return refuse("Overlap", `OVERLAPS ${name}`, overlapping);
  }

  if (rule.hardpoint !== null && !cells.some((cell) => slotOf(cell) === rule.hardpoint)) {
    return refuse("MissingHardpoint", `NEEDS A ${hardpointName(rule.hardpoint)}`, cells);
  }
  return { ok: true, cells };
}

/** The hardpoint an item needs under it, or null when any fittable cell will do. */
export function requiredHardpoint(cat: BuilderCatalog, def: string): string | null {
  const item = cat.items.get(def);
  return item ? (cat.placement?.get(item.slotType)?.hardpoint ?? null) : null;
}

/**
 * The empty cells of the hardpoint type a held item needs: the game's drag highlight (FitCellHighlight),
 * drawn so the player sees where it can go before trying. Empty for an item that needs none.
 */
export function hardpointTargets(cat: BuilderCatalog, fit: OpenFit, def: string, moving: number | null = null): Cell[] {
  const hardpoint = requiredHardpoint(cat, def);
  const ctx = placementContext(cat, fit, moving);
  if (hardpoint === null || !ctx) return [];
  const cells: Cell[] = [];
  ctx.grid.slots.forEach((slot, index) => {
    const cell = { row: Math.floor(index / ctx.grid.cols), col: index % ctx.grid.cols };
    if (slot === hardpoint && !ctx.owners.has(cellKey(cell))) cells.push(cell);
  });
  return cells;
}

/** Whether the item fits anywhere on the fit as it stands, at any rotation (the palette's check). */
export function fitsAnywhere(cat: BuilderCatalog, fit: OpenFit, def: string, context?: PlacementContext | null): boolean {
  const ctx = context ?? placementContext(cat, fit);
  if (!ctx) return false;
  const hardpoint = requiredHardpoint(cat, def);
  if (hardpoint !== null && !ctx.grid.slots.some((slot, index) => slot === hardpoint && !ctx.owners.has(cellKey({ row: Math.floor(index / ctx.grid.cols), col: index % ctx.grid.cols }))))
    return false;
  for (let rotation = 0; rotation < 4; rotation++)
    for (let row = 0; row < ctx.grid.rows; row++)
      for (let col = 0; col < ctx.grid.cols; col++) if (placementVerdict(cat, fit, { def, anchor: { row, col }, rotation }, ctx).ok) return true;
  return false;
}

/**
 * Why an item fits nowhere on this fit. When it would fit on the bare hull only the fitted modules are in
 * the way, and removing one frees room; otherwise the hull itself can't take it.
 */
export function nowhereReason(cat: BuilderCatalog, fit: OpenFit, def: string): string {
  const hardpoint = requiredHardpoint(cat, def);
  const grid = gridOf(cat, fit);
  if (fit.modules.length > 0 && fitsAnywhere(cat, { ...fit, modules: [] }, def)) {
    return hardpoint !== null && hardpointTargets(cat, fit, def).length === 0
      ? `EVERY ${hardpointName(hardpoint)} IS TAKEN. REMOVE A MODULE TO FREE ONE`
      : "NO ROOM LEFT ON THE GRID. REMOVE A MODULE TO FREE ONE";
  }
  if (hardpoint !== null && grid && !grid.slots.includes(hardpoint)) return `THIS HULL HAS NO ${hardpointName(hardpoint)}`;
  return "IT DOESN'T FIT ON THIS HULL";
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

export const heldModule = (held: Held): number | null => (held.source.kind === "module" ? held.source.index : null);

export type DropPreview = { anchor: Cell; verdict: Verdict };

/** Where the held item would go and the verdict there; null while the cursor is off the grid. */
export function dropPreview(cat: BuilderCatalog, fit: OpenFit, held: Held): DropPreview | null {
  const def = heldDef(fit, held);
  if (!held.cursor || def === null || !gridOf(cat, fit)) return null;
  const anchor = { row: held.cursor.row - held.grab.row, col: held.cursor.col - held.grab.col };
  return { anchor, verdict: placementVerdict(cat, fit, { def, anchor, rotation: held.rotation, ports: heldPorts(fit, held), moving: heldModule(held) }) };
}

/** The first enabled cell, row by row: where a keyboard placement starts. */
export function firstOpenCell(grid: GridShape): Cell | null {
  const index = grid.slots.findIndex((slot) => slot !== "None");
  return index < 0 ? null : { row: Math.floor(index / grid.cols), col: index % grid.cols };
}
