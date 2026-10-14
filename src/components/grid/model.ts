// The fitting grid as the grid component draws it, built from the engine's catalog, an open fit and
// (optionally) the engine's evaluation of that fit. Pure: the fit page builds it on the server, the
// builder in the browser. Nothing here decides legality; issues, conduits and regalia groups are the
// evaluation's, copied onto the modules they name.
import type {
  CatalogHull,
  CatalogItem,
  ConduitLink,
  EvaluationIssue,
  OpenFit,
  OpenItem,
  OpenModifier,
  RegaliaGroup,
} from "#/lib/engine/types";
import { itemIcon } from "#/lib/art/item-icon";
import { catalogFacts, type CatalogFacts } from "#/lib/engine/item-facts";
import { applySlotOverrides, modifiedCells, occupiedCells, placeFootprint, type Cell, type Footprint, type PlacedPort } from "./geometry";

/** The game's tier palettes (--tier-<key>-surface-* tokens). */
export type TierKey = "standard" | "augmented" | "prototype" | "artifact" | "regalia" | "harmonic" | "heretical";

/** ModuleRarity to the palette its overlay wears; a harmonized item wears Harmonic. */
export function tierOf(rarity: string, isHarmonized = false): TierKey {
  if (isHarmonized) return "harmonic";
  switch (rarity) {
    case "Augmented":
      return "augmented";
    case "Prototype":
      return "prototype";
    case "Artifact":
      return "artifact";
    case "Regalia":
      return "regalia";
    case "Harmonic":
      return "harmonic";
    case "Heretical":
      return "heretical";
    default:
      return "standard";
  }
}

export type GridModule = {
  /** Index in the open fit's modules: what the engine's issues and links refer to. */
  index: number;
  def: string;
  /** The item as the fit stores it, for asking the engine about its roll. */
  item: OpenItem;
  /** False when the current catalog has no such item (removed by a patch): drawn as UNKNOWN ITEM. */
  known: boolean;
  name: string;
  category: string | null;
  slotType: string | null;
  moduleType: string | null;
  rarity: string;
  quality: string;
  tier: TierKey;
  anchor: Cell;
  rotation: number;
  /** Base shape cells. An unknown item has no known shape, so only its anchor cell (the bounds' top-left). */
  cells: Cell[];
  /** Cells its Tek Ciphers fill. */
  expansions: Cell[];
  ports: PlacedPort[];
  modifiers: OpenModifier[];
  ammo: string | null;
  /** The engine's issues naming this module. */
  issues: EvaluationIssue[];
  /** Conduit links the engine found for this module, or null when it reported none. */
  conduitConnections: number | null;
  regalia: { set: string; setName: string; fittedCount: number; pieces: number } | null;
  /** The image the game shows for this roll (art/item-icon.ts), or null for the no-art placeholder. */
  icon: string | null;
  /** The catalog's description: plain text. */
  description: string | null;
  /** The catalog's facts for the plainest roll; the engine's for this roll arrive in the browser. */
  facts: CatalogFacts;
  /** Each Tek Cipher's cell with the cipher's own image. */
  ciphers: { cell: Cell; name: string; icon: string | null }[];
};

export type GridModel = {
  hullDef: string;
  hullName: string;
  rows: number;
  cols: number;
  /** Row-major slot types with the fit's slot overrides applied. */
  slots: string[];
  /** Cells (row * cols + col) whose slot type the fit's overrides changed from the hull's layout, ascending. */
  modified: number[];
  modules: GridModule[];
  /** Issues about the fit as a whole (moduleIndex -1) or a module the fit doesn't have. */
  fitIssues: EvaluationIssue[];
};

export type GridEvaluation = {
  issues: readonly EvaluationIssue[];
  conduits?: readonly ConduitLink[];
  regaliaSets?: readonly RegaliaGroup[];
};

export type GridCatalog = {
  hull: CatalogHull;
  items: ReadonlyMap<string, CatalogItem>;
  /** Regalia set def to its name and piece count. */
  regaliaSets?: ReadonlyMap<string, { name: string; pieces: number }>;
  /** Artifact def to its name: an identified artifact shows the artifact's own icon. */
  artifacts?: ReadonlyMap<string, { name: string; path: string }>;
  /** Cipher def to its name, which finds its icon. */
  ciphers?: ReadonlyMap<string, { name: string; path: string }>;
};

export const UNKNOWN_ITEM_NAME = "UNKNOWN ITEM";

export function buildGridModel(catalog: GridCatalog, fit: OpenFit, evaluation: GridEvaluation | null = null): GridModel {
  const { hull, items } = catalog;
  const issues = evaluation?.issues ?? [];
  const modules = fit.modules.map((module, index): GridModule => {
    const item = items.get(module.item.def);
    const roll = module.item.roll;
    const placement = { row: module.row, col: module.col, rotation: module.rotation };
    const footprint: Footprint = item
      ? placeFootprint(item.shape.cells, placement, roll.ports)
      : { cells: [{ row: module.row, col: module.col }], expansions: [], ports: [] };
    const conduit = evaluation?.conduits?.find((link) => link.moduleIndex === index);
    const group = evaluation?.regaliaSets?.find((set) => set.moduleIndices.includes(index));
    const setInfo = group ? catalog.regaliaSets?.get(group.set) : undefined;
    const artifactPath = roll.artifact ? (catalog.artifacts?.get(roll.artifact)?.path ?? null) : null;
    return {
      index,
      def: module.item.def,
      item: module.item,
      known: item !== undefined,
      name: item?.name ?? UNKNOWN_ITEM_NAME,
      category: item?.category ?? null,
      slotType: item?.slotType ?? null,
      moduleType: roll.moduleTypeOverride ?? item?.moduleType ?? null,
      rarity: roll.rarity,
      quality: roll.quality,
      tier: tierOf(roll.rarity, roll.isHarmonized),
      anchor: { row: module.row, col: module.col },
      rotation: module.rotation,
      cells: footprint.cells,
      expansions: footprint.expansions,
      ports: footprint.ports,
      modifiers: roll.modifiers,
      ammo: fit.ammo.find((ammo) => ammo.moduleIndex === index)?.ammoType ?? null,
      issues: issues.filter((issue) => issue.moduleIndex === index),
      conduitConnections: conduit ? conduit.connectionCount : null,
      regalia: group
        ? { set: group.set, setName: setInfo?.name ?? "REGALIA SET", fittedCount: group.fittedCount, pieces: setInfo?.pieces ?? group.fittedCount }
        : null,
      icon: item ? itemIcon({ path: item.path, category: item.category }, roll, artifactPath) : null,
      description: item?.description ?? null,
      facts: item ? catalogFacts(item) : { facts: [], rarity: roll.rarity },
      ciphers: footprint.ports.flatMap((port) => {
        if (!port.expansion || !port.cipher) return [];
        const cipher = catalog.ciphers?.get(port.cipher);
        return [{ cell: port.expansion, name: cipher?.name ?? "UNKNOWN CIPHER", icon: cipher ? itemIcon({ path: cipher.path, category: "Portable" }, { rarity: "Normal", isIdentified: true }) : null }];
      }),
    };
  });
  return {
    hullDef: hull.def,
    hullName: hull.name,
    rows: hull.rows,
    cols: hull.cols,
    slots: applySlotOverrides(hull.slots, fit.slotOverrides),
    modified: modifiedCells(hull.slots, fit.slotOverrides),
    modules,
    fitIssues: issues.filter((issue) => issue.moduleIndex < 0 || issue.moduleIndex >= fit.modules.length),
  };
}

/** Every cell a module fills, shape and ciphers. */
export function moduleCells(module: GridModule): Cell[] {
  return occupiedCells(module);
}

/** The catalog lookups the model needs, built once per catalog. */
export function catalogLookups(catalog: {
  items: readonly CatalogItem[];
  regaliaSets: readonly { def: string; name: string; pieces: readonly string[] }[];
  artifacts: readonly { def: string; name: string; path: string }[];
  ciphers: readonly { def: string; name: string; path: string }[];
}): Omit<GridCatalog, "hull"> & { items: Map<string, CatalogItem> } {
  return {
    items: new Map(catalog.items.map((item) => [item.def, item])),
    regaliaSets: new Map(catalog.regaliaSets.map((set) => [set.def, { name: set.name, pieces: set.pieces.length }])),
    artifacts: new Map(catalog.artifacts.map((artifact) => [artifact.def, artifact])),
    ciphers: new Map(catalog.ciphers.map((cipher) => [cipher.def, cipher])),
  };
}
