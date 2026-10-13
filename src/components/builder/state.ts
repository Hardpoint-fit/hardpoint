// The builder's state: the open fit being edited, its title, description and tags, and the UI state
// that edits act on (the selection and the item being placed). One pure reducer over it, with the
// catalog as context, so every edit is a tested function of (state, action). The open fit is the one
// owner of the loadout; everything drawn is derived from it.
import { cellKey, type Cell } from "#/components/grid/geometry";
import type { OpenFit, OpenItem, OpenModule, OpenRoll } from "#/lib/engine/types";
import { allocate, selectThreshold, setLevel } from "./affinity";
import { dropPreview, firstOpenCell, gridOf, type Held } from "./placement";
import * as edits from "./roll-edits";
import { ammoOptions, hullSubject, moduleSubject, patinaMax, type BuilderCatalog, type RollSubject, type Slot } from "./rules";

export type FitMeta = { title: string; description: string; tags: string[] };

/** What the inspector shows: the hull or a module by index. */
export type Target = "hull" | number;

export type BuilderState = {
  /** Null until a hull is picked or a fit is loaded. */
  fit: OpenFit | null;
  meta: FitMeta;
  selected: Target | null;
  held: Held | null;
  /** Counts changes to the fit, so effects (evaluation, autosave) can tell a new fit from a re-render. */
  revision: number;
};

export const EMPTY_META: FitMeta = { title: "", description: "", tags: [] };

export function initialState(fit: OpenFit | null = null, meta: FitMeta = EMPTY_META): BuilderState {
  return { fit, meta, selected: null, held: null, revision: 0 };
}

export type RollEdit =
  | { kind: "quality"; quality: string }
  | { kind: "rarity"; rarity: string }
  | { kind: "grant"; quality: string; rarity: string }
  | { kind: "artifact"; def: string }
  | { kind: "regalia"; def: string }
  | { kind: "heretical"; def: string }
  | { kind: "harmonicSet"; def: string }
  | { kind: "typeOverride"; type: string | null }
  | { kind: "addModifier"; stat: string; operation: string; slot: Slot }
  | { kind: "removeModifier"; index: number }
  | { kind: "modifierTier"; index: number; tier: number }
  /** `value` is the raw FP value before any inversion. */
  | { kind: "modifierValue"; index: number; value: number }
  | { kind: "fractured"; index: number; on: boolean }
  | { kind: "inverted"; index: number }
  | { kind: "scaledStrength"; value: number }
  | { kind: "port"; row: number; col: number; direction: string }
  | { kind: "cipher"; index: number; cipher: string | null }
  | { kind: "mirrored"; on: boolean };

export type BuilderAction =
  /** A new fit on this hull. */
  | { type: "start"; hull: string }
  /** An imported, copied or restored fit. */
  | { type: "load"; fit: OpenFit; meta?: FitMeta }
  /** Back to the hull picker. */
  | { type: "reset" }
  /** Another hull: modules and ammo stay (the engine says what no longer fits), the hull roll and slot overrides go. */
  | { type: "changeHull"; hull: string }
  | { type: "select"; target: Target | null }
  /** Takes a palette item in hand; `cursor` starts a keyboard placement there. */
  | { type: "pickUp"; def: string; cursor?: Cell | null }
  /** Takes a fitted module in hand, grabbed at `cell` (its anchor if absent). */
  | { type: "pickUpModule"; index: number; cell?: Cell }
  | { type: "hover"; cell: Cell | null }
  /** Moves the held item's cursor by whole cells (the keyboard). */
  | { type: "moveCursor"; rows: number; cols: number }
  /** Turns the held item, or the selected module in place (taking it in hand when the turn doesn't fit there). */
  | { type: "rotate" }
  /** Puts the held item down where the preview fits; refused (nothing changes) where it doesn't. */
  | { type: "drop" }
  /** The pointer let go: put the item down where it fits, otherwise back where it came from. */
  | { type: "release" }
  | { type: "cancel" }
  | { type: "remove"; index: number }
  | { type: "roll"; target: Target; edit: RollEdit }
  | { type: "patina"; target: Target; value: number }
  | { type: "ammo"; index: number; ammoType: string | null }
  | { type: "level"; level: number }
  | { type: "allocate"; moduleType: string; option: number; delta: 1 | -1 }
  | { type: "threshold"; moduleType: string; tier: number; choice: number | null }
  | { type: "meta"; patch: Partial<FitMeta> };

export function newFit(cat: BuilderCatalog, hullDef: string): OpenFit | null {
  const subject = hullSubject(cat, hullDef);
  if (!subject) return null;
  const affinity = cat.catalog.affinity;
  return {
    version: 1,
    hull: { def: hullDef, roll: edits.defaultRoll(subject), patina: 0 },
    progression: { affinityType: "None", affinityXp: affinity.levelXp[0] ?? 0, allocatedPoints: [], thresholdSelections: [] },
    modules: [],
    ammo: [],
    slotOverrides: [],
  };
}

function withFit(state: BuilderState, fit: OpenFit): BuilderState {
  return fit === state.fit ? state : { ...state, fit, revision: state.revision + 1 };
}

function subjectFor(cat: BuilderCatalog, fit: OpenFit, target: Target): RollSubject | null {
  if (target === "hull") return hullSubject(cat, fit.hull.def);
  const module = fit.modules[target];
  return module ? moduleSubject(cat, module.item.def) : null;
}

function itemAt(fit: OpenFit, target: Target): OpenItem | null {
  return target === "hull" ? fit.hull : (fit.modules[target]?.item ?? null);
}

function withItem(fit: OpenFit, target: Target, item: OpenItem): OpenFit {
  if (target === "hull") return item === fit.hull ? fit : { ...fit, hull: item };
  const current = fit.modules[target];
  if (!current || current.item === item) return fit;
  return { ...fit, modules: fit.modules.map((module, index) => (index === target ? { ...module, item } : module)) };
}

function applyEdit(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, edit: RollEdit): OpenRoll {
  switch (edit.kind) {
    case "quality":
      return edits.setQuality(cat, subject, roll, edit.quality);
    case "rarity":
      return edits.setRarity(cat, subject, roll, edit.rarity);
    case "grant":
      return edits.applyGrant(subject, roll, edit.quality, edit.rarity);
    case "artifact":
      return edits.setArtifact(cat, subject, roll, edit.def);
    case "regalia":
      return edits.setRegalia(cat, subject, roll, edit.def);
    case "heretical":
      return edits.setHeretical(cat, subject, roll, edit.def);
    case "harmonicSet":
      return edits.setHarmonicSet(cat, subject, roll, edit.def);
    case "typeOverride":
      return edits.setTypeOverride(cat, subject, roll, edit.type);
    case "addModifier":
      return edits.addModifier(cat, subject, roll, edit);
    case "removeModifier":
      return edits.removeModifier(cat, subject, roll, edit.index);
    case "modifierTier":
      return edits.setModifierTier(cat, subject, roll, edit.index, edit.tier);
    case "modifierValue":
      return edits.setModifierValue(cat, subject, roll, edit.index, edit.value);
    case "fractured":
      return edits.setModifierFractured(roll, edit.index, edit.on);
    case "inverted":
      return edits.setModifierInverted(roll, edit.index);
    case "scaledStrength":
      return edits.setScaledStrength(cat, roll, edit.value);
    case "port":
      return edits.togglePort(cat, subject, roll, edit);
    case "cipher":
      return edits.setPortCipher(cat, roll, edit.index, edit.cipher);
    case "mirrored":
      return edits.setMirrored(subject, roll, edit.on);
  }
}

/** Patina belongs to an artifact; another roll keeps none. */
function settlePatina(cat: BuilderCatalog, item: OpenItem): OpenItem {
  const max = patinaMax(cat, item.roll);
  return item.patina > max ? { ...item, patina: max } : item;
}

function removeModule(fit: OpenFit, index: number): OpenFit {
  return {
    ...fit,
    modules: fit.modules.filter((_, each) => each !== index),
    ammo: fit.ammo.filter((ammo) => ammo.moduleIndex !== index).map((ammo) => (ammo.moduleIndex > index ? { ...ammo, moduleIndex: ammo.moduleIndex - 1 } : ammo)),
  };
}

function place(cat: BuilderCatalog, state: BuilderState, fit: OpenFit, held: Held): BuilderState {
  const preview = dropPreview(cat, fit, held);
  if (!preview?.fits) return state;
  const { anchor } = preview;
  if (held.source.kind === "module") {
    const index = held.source.index;
    const modules = fit.modules.map((module, each) => (each === index ? { ...module, row: anchor.row, col: anchor.col, rotation: held.rotation } : module));
    return { ...withFit(state, { ...fit, modules }), held: null, selected: index };
  }
  const subject = moduleSubject(cat, held.source.def);
  if (!subject) return state;
  const module: OpenModule = { item: { def: subject.def, roll: edits.defaultRoll(subject), patina: 0 }, row: anchor.row, col: anchor.col, rotation: held.rotation };
  const index = fit.modules.length;
  const payload = ammoOptions(cat.items.get(subject.def))[0];
  const next: OpenFit = {
    ...fit,
    modules: [...fit.modules, module],
    ammo: payload ? [...fit.ammo, { moduleIndex: index, ammoType: payload }] : fit.ammo,
  };
  return { ...withFit(state, next), held: null, selected: index };
}

export function reduce(cat: BuilderCatalog, state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case "start": {
      const fit = newFit(cat, action.hull);
      return fit ? { ...withFit(state, fit), selected: null, held: null } : state;
    }
    case "load":
      return { ...withFit(state, action.fit), meta: action.meta ?? state.meta, selected: null, held: null };
    case "reset":
      return { ...state, fit: null, selected: null, held: null, revision: state.revision + 1 };
    case "meta":
      return { ...state, meta: { ...state.meta, ...action.patch } };
  }

  const fit = state.fit;
  if (!fit) return state;

  switch (action.type) {
    case "changeHull": {
      const subject = hullSubject(cat, action.hull);
      if (!subject || action.hull === fit.hull.def) return state;
      return { ...withFit(state, { ...fit, hull: { def: action.hull, roll: edits.defaultRoll(subject), patina: 0 }, slotOverrides: [] }), held: null, selected: null };
    }
    case "select": {
      const target = action.target;
      if (target !== null && target !== "hull" && !fit.modules[target]) return state;
      return { ...state, selected: target };
    }
    case "pickUp": {
      if (!cat.items.has(action.def)) return state;
      return { ...state, selected: null, held: { source: { kind: "palette", def: action.def }, rotation: 0, cursor: action.cursor ?? null, grab: { row: 0, col: 0 } } };
    }
    case "pickUpModule": {
      const module = fit.modules[action.index];
      if (!module) return state;
      const cell = action.cell ?? { row: module.row, col: module.col };
      return {
        ...state,
        selected: action.index,
        held: { source: { kind: "module", index: action.index }, rotation: module.rotation, cursor: cell, grab: { row: cell.row - module.row, col: cell.col - module.col } },
      };
    }
    case "hover": {
      if (!state.held) return state;
      const same = action.cell === state.held.cursor || (action.cell && state.held.cursor && cellKey(action.cell) === cellKey(state.held.cursor));
      return same ? state : { ...state, held: { ...state.held, cursor: action.cell } };
    }
    case "moveCursor": {
      const grid = gridOf(cat, fit);
      if (!state.held || !grid) return state;
      const from = state.held.cursor ?? firstOpenCell(grid) ?? { row: 0, col: 0 };
      const cursor = {
        row: Math.min(grid.rows - 1, Math.max(0, from.row + action.rows)),
        col: Math.min(grid.cols - 1, Math.max(0, from.col + action.cols)),
      };
      return { ...state, held: { ...state.held, cursor } };
    }
    case "rotate": {
      if (state.held) return { ...state, held: { ...state.held, rotation: (state.held.rotation + 1) % 4, grab: { row: 0, col: 0 } } };
      if (typeof state.selected !== "number") return state;
      const index = state.selected;
      const module = fit.modules[index];
      if (!module) return state;
      const held: Held = { source: { kind: "module", index }, rotation: (module.rotation + 1) % 4, cursor: { row: module.row, col: module.col }, grab: { row: 0, col: 0 } };
      const turned = place(cat, { ...state, held }, fit, held);
      return turned.held === null && turned.fit !== fit ? turned : { ...state, held };
    }
    case "drop":
      return state.held ? place(cat, state, fit, state.held) : state;
    case "release": {
      if (!state.held) return state;
      const placed = place(cat, state, fit, state.held);
      return placed.held === null ? placed : { ...state, held: null };
    }
    case "cancel":
      return state.held ? { ...state, held: null } : { ...state, selected: null };
    case "remove": {
      if (!fit.modules[action.index]) return state;
      return { ...withFit(state, removeModule(fit, action.index)), selected: null, held: null };
    }
    case "roll": {
      const subject = subjectFor(cat, fit, action.target);
      const item = itemAt(fit, action.target);
      if (!subject || !item) return state;
      const roll = applyEdit(cat, subject, item.roll, action.edit);
      if (roll === item.roll) return state;
      return withFit(state, withItem(fit, action.target, settlePatina(cat, { ...item, roll })));
    }
    case "patina": {
      const item = itemAt(fit, action.target);
      if (!item) return state;
      const value = Math.trunc(action.value);
      if (!Number.isFinite(value) || value < 0 || value > patinaMax(cat, item.roll) || value === item.patina) return state;
      return withFit(state, withItem(fit, action.target, { ...item, patina: value }));
    }
    case "ammo": {
      const module = fit.modules[action.index];
      if (!module) return state;
      const current = fit.ammo.find((ammo) => ammo.moduleIndex === action.index)?.ammoType ?? null;
      if (current === action.ammoType) return state;
      if (action.ammoType !== null && !ammoOptions(cat.items.get(module.item.def)).includes(action.ammoType)) return state;
      const others = fit.ammo.filter((ammo) => ammo.moduleIndex !== action.index);
      const ammo = action.ammoType === null ? others : [...others, { moduleIndex: action.index, ammoType: action.ammoType }].sort((a, b) => a.moduleIndex - b.moduleIndex);
      return withFit(state, { ...fit, ammo });
    }
    case "level":
      return progression(state, fit, setLevel(cat.catalog.affinity, fit.progression, action.level));
    case "allocate":
      return progression(state, fit, allocate(cat.catalog.affinity, fit.progression, action.moduleType, action.option, action.delta));
    case "threshold":
      return progression(state, fit, selectThreshold(cat.catalog.affinity, fit.progression, action.moduleType, action.tier, action.choice));
  }
}

function progression(state: BuilderState, fit: OpenFit, next: OpenFit["progression"]): BuilderState {
  return next === fit.progression ? state : withFit(state, { ...fit, progression: next });
}
