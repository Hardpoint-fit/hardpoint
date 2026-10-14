// Fitting-grid geometry: where a module's cells, ports and Tek Cipher cells land for a placement.
// Pure functions over plain data, shared by the read-only fit page and the builder's drag feedback.
// The rules mirror the game's own (Simulation/ModuleShapeMask.cs and BaseModuleDefPrototype.User.cs:
// GetRotatedLocation, RotateDirection, GetExpansionCell); the site uses them to draw and, with the
// catalog's cell rules (builder/placement.ts), to judge a drop before it happens. The engine re-checks
// every fit.

/** A cell as (row, col). In a shape it is in the 5x5 shape grid; on a hull it is a fitting-grid cell. */
export type Cell = { row: number; col: number };

export type Direction = "Up" | "Down" | "Left" | "Right";
export const DIRECTIONS: readonly Direction[] = ["Up", "Down", "Left", "Right"];

/** The shape grid every module footprint and port anchor is authored in. */
export const SHAPE_GRID = 5;

const OFFSET: Record<Direction, Cell> = {
  Up: { row: -1, col: 0 },
  Down: { row: 1, col: 0 },
  Left: { row: 0, col: -1 },
  Right: { row: 0, col: 1 },
};

// BaseModuleDefPrototype.DirectionRotationMap, indexed [rotation][Up, Down, Left, Right].
const DIRECTION_ROTATION: readonly (readonly Direction[])[] = [
  ["Up", "Down", "Left", "Right"],
  ["Right", "Left", "Up", "Down"],
  ["Down", "Up", "Right", "Left"],
  ["Left", "Right", "Down", "Up"],
];

export type Rotation = 0 | 1 | 2 | 3;

export function normalizeRotation(rotation: number): Rotation {
  return ((((Math.trunc(rotation) % 4) + 4) % 4) as Rotation);
}

export function isDirection(value: string): value is Direction {
  return (DIRECTIONS as readonly string[]).includes(value);
}

export function directionOffset(direction: Direction): Cell {
  return OFFSET[direction];
}

export function oppositeDirection(direction: Direction): Direction {
  return direction === "Up" ? "Down" : direction === "Down" ? "Up" : direction === "Left" ? "Right" : "Left";
}

/** A shape-grid cell turned clockwise `rotation` quarter turns (GetRotatedLocation with size 5). */
export function rotateShapeCell(cell: Cell, rotation: number): Cell {
  const last = SHAPE_GRID - 1;
  switch (normalizeRotation(rotation)) {
    case 0:
      return { row: cell.row, col: cell.col };
    case 1:
      return { row: cell.col, col: last - cell.row };
    case 2:
      return { row: last - cell.row, col: last - cell.col };
    case 3:
      return { row: last - cell.col, col: cell.row };
  }
}

export function rotateDirection(direction: Direction, rotation: number): Direction {
  return DIRECTION_ROTATION[normalizeRotation(rotation)]![DIRECTIONS.indexOf(direction)]!;
}

/** A footprint turned in the shape grid. `origin` is its bounds' top-left, which a placement anchors. */
export type RotatedShape = { origin: Cell; cells: Cell[] };

/** ModuleShapeMask.ResolveBase: the rotation-0 cells turned, with the origin taken from the turned bounds. */
export function rotateShape(cells: readonly Cell[], rotation: number): RotatedShape {
  const turned = cells.map((cell) => rotateShapeCell(cell, rotation));
  if (turned.length === 0) return { origin: { row: 0, col: 0 }, cells: [] };
  return {
    origin: { row: Math.min(...turned.map((c) => c.row)), col: Math.min(...turned.map((c) => c.col)) },
    cells: turned,
  };
}

/** Where an item sits: the grid cell its shape's origin is anchored to, and its quarter turns. */
export type Placement = { row: number; col: number; rotation: number };

/** A port as an open fit stores it: an anchor in rotation-0 shape coordinates and the way it opens. */
export type PortSpec = { row: number; col: number; direction: string; cipher: string | null };

export type PlacedPort = {
  /** The index of the port in the item's roll. */
  index: number;
  /** The grid cell the port sits on. */
  cell: Cell;
  /** The way it opens after the item's rotation. */
  direction: Direction;
  cipher: string | null;
  /** The grid cell a ciphered port fills (ModuleShapeMask.Resolve), or null for an empty port. */
  expansion: Cell | null;
};

export type Footprint = {
  /** The base shape's grid cells. */
  cells: Cell[];
  /** The cells Tek Ciphers in the ports fill, beyond the base shape. */
  expansions: Cell[];
  ports: PlacedPort[];
};

/**
 * The grid cells an item covers at a placement: its turned shape anchored at (row, col) (a cell covers
 * row + shapeRow - originRow), plus one cell per ciphered port in the direction it opens. As in the
 * game, an expansion cell that falls outside the 5x5 shape grid adds nothing, and a port whose
 * direction this site doesn't know is skipped.
 */
export function placeFootprint(shape: readonly Cell[], placement: Placement, ports: readonly PortSpec[] = []): Footprint {
  const { origin, cells } = rotateShape(shape, placement.rotation);
  const toGrid = (cell: Cell): Cell => ({ row: placement.row + cell.row - origin.row, col: placement.col + cell.col - origin.col });
  const placed: PlacedPort[] = [];
  const expansions: Cell[] = [];
  ports.forEach((port, index) => {
    if (!isDirection(port.direction)) return;
    const anchor = rotateShapeCell(port, placement.rotation);
    const direction = rotateDirection(port.direction, placement.rotation);
    let expansion: Cell | null = null;
    if (port.cipher !== null) {
      const offset = OFFSET[direction];
      const shapeCell = { row: anchor.row + offset.row, col: anchor.col + offset.col };
      const inside = shapeCell.row >= 0 && shapeCell.row < SHAPE_GRID && shapeCell.col >= 0 && shapeCell.col < SHAPE_GRID;
      const covered = cells.some((c) => c.row === shapeCell.row && c.col === shapeCell.col);
      if (inside && !covered) {
        expansion = toGrid(shapeCell);
        if (!expansions.some((c) => sameCell(c, expansion!))) expansions.push(expansion);
      }
    }
    placed.push({ index, cell: toGrid(anchor), direction, cipher: port.cipher, expansion });
  });
  return { cells: cells.map(toGrid), expansions, ports: placed };
}

/** Every cell a footprint fills: its shape plus its cipher cells. */
export function occupiedCells(footprint: Footprint): Cell[] {
  return [...footprint.cells, ...footprint.expansions];
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.row === b.row && a.col === b.col;
}

export const cellKey = (cell: Cell): string => `${cell.row},${cell.col}`;

export type GridSize = { rows: number; cols: number };

export function insideGrid(cell: Cell, grid: GridSize): boolean {
  return cell.row >= 0 && cell.row < grid.rows && cell.col >= 0 && cell.col < grid.cols;
}

/** Which item fills each cell; several owners on one key is an overlap. */
export function occupancy(footprints: readonly (readonly Cell[])[]): Map<string, number[]> {
  const owners = new Map<string, number[]>();
  footprints.forEach((cells, index) => {
    for (const cell of cells) {
      const key = cellKey(cell);
      const list = owners.get(key);
      if (!list) owners.set(key, [index]);
      else if (!list.includes(index)) list.push(index);
    }
  });
  return owners;
}

/** The items (by index) that share a cell with another item. */
export function overlappingItems(footprints: readonly (readonly Cell[])[]): Set<number> {
  const overlapping = new Set<number>();
  for (const owners of occupancy(footprints).values()) if (owners.length > 1) for (const owner of owners) overlapping.add(owner);
  return overlapping;
}

/** For each cell, which of its sides face outside the set: where an outline is drawn. */
export type Edges = { top: boolean; right: boolean; bottom: boolean; left: boolean };

export function outerEdges(cells: readonly Cell[]): Map<string, Edges> {
  const keys = new Set(cells.map(cellKey));
  const has = (row: number, col: number) => keys.has(`${row},${col}`);
  return new Map(
    cells.map((cell) => [
      cellKey(cell),
      {
        top: !has(cell.row - 1, cell.col),
        right: !has(cell.row, cell.col + 1),
        bottom: !has(cell.row + 1, cell.col),
        left: !has(cell.row, cell.col - 1),
      },
    ]),
  );
}

export type Bounds = { minRow: number; minCol: number; rows: number; cols: number };

export function boundsOf(cells: readonly Cell[]): Bounds | null {
  if (cells.length === 0) return null;
  const minRow = Math.min(...cells.map((c) => c.row));
  const minCol = Math.min(...cells.map((c) => c.col));
  return {
    minRow,
    minCol,
    rows: Math.max(...cells.map((c) => c.row)) - minRow + 1,
    cols: Math.max(...cells.map((c) => c.col)) - minCol + 1,
  };
}

/**
 * The part of a hull's grid worth drawing: every enabled cell and every `extra` cell (items that
 * stick out), with a one-cell margin, clamped to the grid (the prototype's fittingVisibleBounds).
 */
export function visibleBounds(slots: readonly string[], grid: GridSize, extra: readonly Cell[] = []): Bounds {
  const cells: Cell[] = [...extra.filter((cell) => insideGrid(cell, grid))];
  slots.forEach((slot, index) => {
    if (slot !== "None") cells.push({ row: Math.floor(index / grid.cols), col: index % grid.cols });
  });
  const bounds = boundsOf(cells);
  if (!bounds) return { minRow: 0, minCol: 0, rows: grid.rows, cols: grid.cols };
  const minRow = Math.max(0, bounds.minRow - 1);
  const minCol = Math.max(0, bounds.minCol - 1);
  const maxRow = Math.min(grid.rows - 1, bounds.minRow + bounds.rows);
  const maxCol = Math.min(grid.cols - 1, bounds.minCol + bounds.cols);
  return { minRow, minCol, rows: maxRow - minRow + 1, cols: maxCol - minCol + 1 };
}

/** A hull's slots with an open fit's slot overrides applied (`cell` is row * cols + col). */
export function applySlotOverrides(slots: readonly string[], overrides: readonly { cell: number; slotType: string }[]): string[] {
  const result = [...slots];
  for (const { cell, slotType } of overrides) if (cell >= 0 && cell < result.length) result[cell] = slotType;
  return result;
}
