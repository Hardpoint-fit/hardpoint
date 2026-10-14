// The fitting grid, read-only by default. It draws a GridModel (model.ts): the hull's typed cells,
// modules in their tier colours with one outline per footprint, port notches and Tek Cipher cells in
// the game's own geometry, conduit links, regalia welds and the engine's issue markers. It holds no
// state and uses no hooks, so it renders on the server for the fit page; the builder passes the
// optional handlers and drag state from a client component.
//
// Scale: every length here is worked out in the game's art space (48px cells, fitting-art.generated.json)
// and drawn through `u`, which multiplies it by `--fg-u`, the size of one art pixel. `--fg-u` follows from
// `--fg-cell`, the drawn cell size, which scale.ts derives from the space the grid has. Nothing else sizes
// the grid.
import type { CSSProperties, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import art from "./fitting-art.generated.json";
import { boundsOf, cellKey, ICON_INSET, iconBox, directionOffset, oppositeDirection, outerEdges, visibleBounds, type Bounds, type Cell, type Direction } from "./geometry";
import { moduleCells, type GridModel, type GridModule } from "./model";
import { ModuleTooltip } from "./module-tooltip";
import { cellSizeCss, SITE_GRID } from "./scale";
import { ItemIcon } from "#/components/item-text";
import "./fitting-grid.css";

type Rect = { x: number; y: number; width: number; height: number };
type PortArt = { body: Rect; bridge: Rect; borders: Rect[] };
const ART = art as {
  cellSize: number;
  slotInset: number;
  ports: Record<"FemaleOpen" | "MaleAttached" | "Expansion", PortArt[]>;
  hardpoints: Record<string, { viewBox: string; paths: string[] }>;
  colors: Record<string, string>;
};

const CELL = ART.cellSize;
const INSET = ART.slotInset;
const SLOT = CELL - 2 * INSET;
const DIRECTION_INDEX: Record<Direction, number> = { Up: 0, Down: 1, Left: 2, Right: 3 };

export type FittingGridProps = {
  model: GridModel;
  /** Draw only the hull's enabled cells with a one-cell margin (default), or the whole grid. */
  crop?: boolean;
  /** A module drawn as selected (its hover look, held). */
  selected?: number | null;
  /** Cells drawn with the game's orange highlight. */
  highlight?: readonly Cell[];
  /**
   * A drag preview: these cells drawn green (valid) or red (invalid), the `offending` ones (the cells to
   * blame) darker, and `reason` written beside the footprint.
   */
  drop?: { cells: readonly Cell[]; valid: boolean; offending?: readonly Cell[]; reason?: string | null } | null;
  /** A module's tooltip; defaults to ModuleTooltip. Return null for none. */
  tooltip?: (module: GridModule) => ReactNode;
  onModulePointerDown?: (module: GridModule, event: ReactPointerEvent<HTMLElement>) => void;
  onModuleContextMenu?: (module: GridModule, event: ReactMouseEvent<HTMLElement>) => void;
  onCellPointerDown?: (cell: Cell, event: ReactPointerEvent<HTMLElement>) => void;
  onCellPointerEnter?: (cell: Cell, event: ReactPointerEvent<HTMLElement>) => void;
  className?: string;
  /** Accessible name of the grid. */
  label?: string;
};

/** A whole number of cells, in art pixels. */
const px = (cells: number) => cells * CELL;
/** An art-space length (art pixels) as drawn: scaled by the grid's `--fg-u`. */
const u = (art: number) => `calc(var(--fg-u) * ${art})`;
/** An absolutely placed box, its art-space rectangle drawn at the grid's scale. */
const place = (left: number, top: number, width?: number, height?: number): CSSProperties => ({
  left: u(left),
  top: u(top),
  ...(width === undefined ? {} : { width: u(width) }),
  ...(height === undefined ? {} : { height: u(height) }),
});
/** The largest an art-space length is drawn (the grid's largest cell), in CSS pixels. */
const drawnAtMost = (art: number) => (art * SITE_GRID.max) / CELL;
/**
 * Whether a module with art also shows its name over the icon, as the game's overlay does: only on a
 * footprint at least two cells each way, where the name has room at a legible size. A smaller one shows
 * its icon, and its name in the tooltip and the accessible label.
 */
export function showsName(module: Pick<GridModule, "cells" | "known" | "icon">): boolean {
  if (!module.known || !module.icon) return true;
  const box = boundsOf(module.cells);
  return box !== null && box.cols >= 2 && box.rows >= 2;
}

/** The issue marker's and conduit count's height, in art pixels. */
const MARKER = 12;

/** Where a module's icon sits, in art pixels from its shape's bounds (geometry.ts iconBox at the game's cell). */
const iconBoxOf = (cells: readonly Cell[]) => iconBox(cells, CELL, INSET);

/** The part of the grid drawn: cropped bounds that also take in every module cell. */
export function gridBounds(model: GridModel, crop = true): Bounds {
  if (!crop) return { minRow: 0, minCol: 0, rows: model.rows, cols: model.cols };
  return visibleBounds(model.slots, model, model.modules.flatMap(moduleCells));
}

function HardpointIcon({ slot }: { slot: string }) {
  const icon = ART.hardpoints[slot];
  if (!icon) return null;
  return (
    <svg className="fg-cell__icon" viewBox={icon.viewBox} aria-hidden="true">
      {icon.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

function PortPaint({ geometry, at, body }: { geometry: PortArt; at: { x: number; y: number }; body: "fill" | "cut" }) {
  const fill = [geometry.body, geometry.bridge].filter((rect) => rect.width > 0 && rect.height > 0);
  return (
    <g transform={`translate(${at.x} ${at.y})`}>
      {fill.map((rect, i) => (
        <rect key={`f${i}`} className={body === "cut" ? "fg-module__art-cut" : "fg-module__art-fill"} {...rect} />
      ))}
      {geometry.borders.map((rect, i) => (
        <rect key={`b${i}`} className="fg-module__art-edge" {...rect} />
      ))}
    </g>
  );
}

function ModuleView({
  module,
  view,
  selected,
  tooltip,
  tipLeft,
  onPointerDown,
  onContextMenu,
}: {
  module: GridModule;
  view: Bounds;
  selected: boolean;
  tooltip: ReactNode;
  tipLeft: boolean;
  onPointerDown?: FittingGridProps["onModulePointerDown"];
  onContextMenu?: FittingGridProps["onModuleContextMenu"];
}) {
  const all = moduleCells(module);
  const box = boundsOf(all)!;
  const local = (cell: Cell) => ({ x: px(cell.col - box.minCol), y: px(cell.row - box.minRow) });
  const shapeEdges = outerEdges(module.cells);
  const classes = [
    "fg-module",
    "tip-anchor",
    `fg-module--${module.tier}`,
    module.known ? "" : "fg-module--unknown",
    module.known && !module.icon ? "fg-module--no-art" : "",
    module.conduitConnections !== null && module.conduitConnections > 0 ? "fg-module--linked" : "",
    module.issues.length > 0 ? "fg-module--issue" : "",
    selected ? "fg-module--selected" : "",
    tipLeft ? "fg-module--tip-left" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const labelBox = boundsOf(module.cells)!;
  const first = module.cells[0]!;
  const firstAt = local(first);
  const icon = module.icon ? iconBoxOf(module.cells) : null;
  const baseAt = { x: px(labelBox.minCol - box.minCol), y: px(labelBox.minRow - box.minRow) };
  return (
    <div
      className={classes}
      style={place(px(box.minCol - view.minCol), px(box.minRow - view.minRow), px(box.cols), px(box.rows))}
      tabIndex={0}
      role="img"
      aria-label={`${module.name}${module.issues.length ? `: ${module.issues.map((issue) => issue.message).join(" ")}` : ""}`}
      data-module={module.index}
      onPointerDown={onPointerDown ? (event) => onPointerDown(module, event) : undefined}
      onContextMenu={onContextMenu ? (event) => onContextMenu(module, event) : undefined}
    >
      {module.cells.map((cell) => {
        const edges = shapeEdges.get(cellKey(cell))!;
        const at = local(cell);
        const left = edges.left ? INSET : 0;
        const top = edges.top ? INSET : 0;
        const line = (edge: boolean) => (edge ? "var(--fg-line)" : 0);
        const style: CSSProperties = {
          ...place(at.x + left, at.y + top, CELL - left - (edges.right ? INSET : 0), CELL - top - (edges.bottom ? INSET : 0)),
          borderTopWidth: line(edges.top),
          borderRightWidth: line(edges.right),
          borderBottomWidth: line(edges.bottom),
          borderLeftWidth: line(edges.left),
        };
        return <div key={cellKey(cell)} className="fg-module__tile" style={style} />;
      })}
      {module.expansions.map((cell) => {
        const at = local(cell);
        return <div key={`x${cellKey(cell)}`} className="fg-module__tile" style={place(at.x + INSET, at.y + INSET, SLOT, SLOT)} />;
      })}
      {module.ports.length > 0 && (
        <svg className="fg-module__ports" style={place(0, 0, px(box.cols), px(box.rows))} viewBox={`0 0 ${px(box.cols)} ${px(box.rows)}`} aria-hidden="true">
          {module.ports.map((port) => {
            if (port.expansion) {
              const at = local(port.expansion);
              const geometry = ART.ports.Expansion[DIRECTION_INDEX[oppositeDirection(port.direction)]]!;
              return <PortPaint key={port.index} geometry={geometry} at={{ x: at.x + INSET, y: at.y + INSET }} body="fill" />;
            }
            const at = local(port.cell);
            const geometry = ART.ports.FemaleOpen[DIRECTION_INDEX[port.direction]]!;
            return <PortPaint key={port.index} geometry={geometry} at={{ x: at.x + INSET, y: at.y + INSET }} body="cut" />;
          })}
        </svg>
      )}
      {icon && (
        <span className="fg-module__icon" style={place(baseAt.x + icon.left, baseAt.y + icon.top, icon.size, icon.size)}>
          <ItemIcon src={module.icon} size={drawnAtMost(icon.size)} fill />
        </span>
      )}
      {module.ciphers.map((cipher) => {
        const at = local(cipher.cell);
        const size = SLOT - 2 * ICON_INSET;
        return (
          <span key={`c${cellKey(cipher.cell)}`} className="fg-module__icon" style={place(at.x + INSET + ICON_INSET, at.y + INSET + ICON_INSET, size, size)}>
            <ItemIcon src={cipher.icon} size={drawnAtMost(size)} mirrored fill />
          </span>
        );
      })}
      {showsName(module) && (
        <span
          className={`fg-module__label ${icon ? "fg-module__label--name" : ""}`}
          style={place(px(labelBox.minCol - box.minCol) + INSET, px(labelBox.minRow - box.minRow) + INSET, px(labelBox.cols) - 2 * INSET, px(labelBox.rows) - 2 * INSET)}
        >
          {module.name}
        </span>
      )}
      {module.issues.length > 0 && (
        <span className="fg-module__marker" style={place(firstAt.x + CELL - INSET - MARKER, firstAt.y + INSET, MARKER, MARKER)} aria-hidden="true">
          !
        </span>
      )}
      {module.conduitConnections !== null && module.conduitConnections > 0 && (
        <span className="fg-module__count" style={place(firstAt.x + INSET + 1, firstAt.y + CELL - INSET - MARKER, undefined, MARKER)} aria-hidden="true">
          x{module.conduitConnections}
        </span>
      )}
      {tooltip !== null && <div className="tip">{tooltip}</div>}
    </div>
  );
}

/**
 * Why the held item can't go here, under the footprint (above it when the footprint is in the grid's
 * lower half), clamped to the drawn grid so a footprint hanging off the edge still shows it.
 */
function DropReason({ cells, view, reason }: { cells: readonly Cell[]; view: Bounds; reason: string }) {
  const box = boundsOf(cells);
  if (!box) return null;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const centre = u(px(clamp(box.minCol + box.cols / 2 - view.minCol, 0, view.cols)));
  const below = box.minRow + box.rows / 2 - view.minRow < view.rows / 2;
  const style: CSSProperties = below
    ? { left: centre, top: u(px(clamp(box.minRow + box.rows - view.minRow, 0, view.rows)) + 4) }
    : { left: centre, bottom: u(px(clamp(view.minRow + view.rows - box.minRow, 0, view.rows)) + 4) };
  return (
    <span className="fg-drop-reason" style={style} role="status">
      {reason}
    </span>
  );
}

/** Bars across the gutter wherever cells of two modules of one regalia group touch. */
function regaliaWelds(model: GridModel, view: Bounds): { key: string; style: CSSProperties }[] {
  const owner = new Map<string, GridModule>();
  for (const module of model.modules) if (module.regalia) for (const cell of module.cells) owner.set(cellKey(cell), module);
  const welds: { key: string; style: CSSProperties }[] = [];
  for (const [key, module] of owner) {
    const [row, col] = key.split(",").map(Number) as [number, number];
    for (const direction of ["Right", "Down"] as const) {
      const offset = directionOffset(direction);
      const neighbour = owner.get(cellKey({ row: row + offset.row, col: col + offset.col }));
      if (!neighbour || neighbour === module || neighbour.regalia!.set !== module.regalia!.set) continue;
      const x = px(col - view.minCol);
      const y = px(row - view.minRow);
      const style: CSSProperties =
        direction === "Right"
          ? place(x + CELL - INSET - 1, y + CELL / 2 - 8, 2 * INSET + 2, 16)
          : place(x + CELL / 2 - 8, y + CELL - INSET - 1, 16, 2 * INSET + 2);
      welds.push({ key: `${key}${direction}`, style });
    }
  }
  return welds;
}

export function FittingGrid({
  model,
  crop = true,
  selected = null,
  highlight = [],
  drop = null,
  tooltip,
  onModulePointerDown,
  onModuleContextMenu,
  onCellPointerDown,
  onCellPointerEnter,
  className,
  label,
}: FittingGridProps) {
  const view = gridBounds(model, crop);
  const highlighted = new Set(highlight.map(cellKey));
  const dropCells = new Set((drop?.cells ?? []).map(cellKey));
  const blamed = new Set((drop?.offending ?? []).map(cellKey));
  const occupied = new Set(model.modules.flatMap(moduleCells).map(cellKey));
  const colors = ART.colors;
  const style = {
    // The one scale: scale.ts's cell size for this grid's span, evaluated by the browser (fitting-grid.css).
    "--fg-cell": cellSizeCss(view),
    "--fg-u": `calc(var(--fg-cell) / ${CELL})`,
    "--fg-inset": u(INSET),
    width: u(px(view.cols)),
    height: u(px(view.rows)),
    "--fg-conduit": colors.ConduitConnected,
    "--fg-invalid": colors.InvalidRed,
    "--fg-invalid-border": colors.InvalidRedBorder,
    "--fg-invalid-fill": colors.InvalidRedFill,
    "--fg-weld": colors.RegaliaWeldGreen,
    "--fg-hazard-base": colors.HazardTapeBase,
    "--fg-hazard-red": colors.HazardTapeRed,
  } as CSSProperties;

  const cells: ReactNode[] = [];
  for (let row = view.minRow; row < view.minRow + view.rows; row++) {
    for (let col = view.minCol; col < view.minCol + view.cols; col++) {
      const slot = model.slots[row * model.cols + col] ?? "None";
      const key = `${row},${col}`;
      const dropped = dropCells.has(key);
      if (slot === "None" && !dropped && !highlighted.has(key)) continue;
      const hardpoint = slot in ART.hardpoints;
      const cell = { row, col };
      const classes = [
        "fg-cell",
        hardpoint ? "fg-cell--hardpoint" : "",
        highlighted.has(key) ? "fg-cell--highlight" : "",
        dropped ? (drop!.valid ? "fg-cell--drop-valid" : "fg-cell--drop-invalid") : "",
        dropped && blamed.has(key) ? "fg-cell--drop-blame" : "",
      ]
        .filter(Boolean)
        .join(" ");
      cells.push(
        <div
          key={key}
          className={classes}
          style={place(px(col - view.minCol), px(row - view.minRow))}
          data-slot={slot}
          onPointerDown={onCellPointerDown ? (event) => onCellPointerDown(cell, event) : undefined}
          onPointerEnter={onCellPointerEnter ? (event) => onCellPointerEnter(cell, event) : undefined}
        >
          <div className="fg-cell__slot" />
          {hardpoint && !occupied.has(key) && <HardpointIcon slot={slot} />}
        </div>,
      );
    }
  }

  const renderTooltip = tooltip ?? ((module: GridModule) => <ModuleTooltip module={module} />);
  return (
    <div className={["fg", className].filter(Boolean).join(" ")} style={style} role="group" aria-label={label ?? `${model.hullName} fitting grid`}>
      {cells}
      {model.modules.map((module) => {
        const box = boundsOf(moduleCells(module))!;
        return (
          <ModuleView
            key={module.index}
            module={module}
            view={view}
            selected={selected === module.index}
            tooltip={renderTooltip(module)}
            tipLeft={box.minCol - view.minCol > view.cols / 2}
            onPointerDown={onModulePointerDown}
            onContextMenu={onModuleContextMenu}
          />
        );
      })}
      {regaliaWelds(model, view).map((weld) => (
        <span key={weld.key} className="fg-weld" style={weld.style} aria-hidden="true" />
      ))}
      {drop && !drop.valid && drop.reason && <DropReason cells={drop.cells} view={view} reason={drop.reason} />}
    </div>
  );
}
