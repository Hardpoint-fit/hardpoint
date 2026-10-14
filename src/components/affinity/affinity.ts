// Affinity points as an open fit stores them (ShipProgression's fixed arrays, laid out as the game's
// AffinitySystem indexes them: the layout comes with the catalog's affinity tree, GET /v1/affinity) and the
// limits that tree sets. The engine validates progressions (ProgressionRules); the builder offers only what
// its rules allow. An older engine sends no layout (`affinity.layout` null): points can then be neither
// read nor edited, and the panels say so. Pure: no React.
import type { CatalogAffinity, CatalogAffinityType, OpenProgression, ProgressionLayout } from "#/lib/engine/types";

function typeIndex(layout: ProgressionLayout, moduleType: string): number | null {
  const value = layout.moduleTypes[moduleType];
  return value === undefined ? null : value;
}

export function allocationSlot(layout: ProgressionLayout, moduleType: string, option: number): number | null {
  const type = typeIndex(layout, moduleType);
  if (type === null || option < 0 || option >= layout.optionsPerType) return null;
  const slot = type * layout.optionsPerType + option;
  return slot < layout.allocationSlots ? slot : null;
}

export function thresholdSlot(layout: ProgressionLayout, moduleType: string, tier: number): number | null {
  const type = typeIndex(layout, moduleType);
  if (type === null || tier < 0 || tier >= layout.tiersPerType) return null;
  const slot = type * layout.tiersPerType + tier;
  return slot < layout.thresholdSlots ? slot : null;
}

export function pointsAt(layout: ProgressionLayout, progression: OpenProgression, moduleType: string, option: number): number {
  const slot = allocationSlot(layout, moduleType, option);
  return slot === null ? 0 : (progression.allocatedPoints[slot] ?? 0);
}

export function typePoints(layout: ProgressionLayout, progression: OpenProgression, moduleType: string): number {
  let total = 0;
  for (let option = 0; option < layout.optionsPerType; option++) total += pointsAt(layout, progression, moduleType, option);
  return total;
}

export function totalPoints(progression: OpenProgression): number {
  return progression.allocatedPoints.reduce((sum, points) => sum + points, 0);
}

/** SimulationConfig.GetLevelFromXP: the highest level whose XP the hull has reached. */
export function levelOf(affinity: CatalogAffinity, xp: number): number {
  let level = 1;
  for (let next = 2; next <= affinity.maxLevel; next++) if (xp >= (affinity.levelXp[next - 1] ?? Infinity)) level = next;
  return level;
}

/** AffinitySystem.GetEarnedPoints: one point per level. */
export const earnedPoints = levelOf;

export function selectionAt(layout: ProgressionLayout, progression: OpenProgression, moduleType: string, tier: number): number | null {
  const slot = thresholdSlot(layout, moduleType, tier);
  const value = slot === null ? undefined : progression.thresholdSelections[slot];
  return value === undefined || value === layout.selectionUnset ? null : value;
}

/** Trailing zeros and unset selections dropped, as the engine writes them. */
function trimmed(values: number[], empty: number): number[] {
  let end = values.length;
  while (end > 0 && values[end - 1] === empty) end--;
  return values.slice(0, end);
}

function written(values: readonly number[], slot: number, value: number, empty: number): number[] {
  const next = [...values];
  while (next.length <= slot) next.push(empty);
  next[slot] = value;
  return trimmed(next, empty);
}

/** The thresholds with a choice to make: more than one option (ProgressionRules.TryGetTier). */
export function choiceTiers(type: CatalogAffinityType) {
  return type.thresholds.filter((tier) => tier.choices.length > 1);
}

/** Clears threshold choices the type's points no longer reach. */
function settleThresholds(affinity: CatalogAffinity, layout: ProgressionLayout, progression: OpenProgression): OpenProgression {
  const unset = layout.selectionUnset;
  let selections = progression.thresholdSelections;
  for (const type of affinity.types) {
    const points = typePoints(layout, progression, type.moduleType);
    for (const tier of type.thresholds) {
      const slot = thresholdSlot(layout, type.moduleType, tier.tier);
      if (slot !== null && points < tier.requiredPoints && (selections[slot] ?? unset) !== unset) {
        selections = written(selections, slot, unset, unset);
      }
    }
  }
  return selections === progression.thresholdSelections ? progression : { ...progression, thresholdSelections: selections };
}

/** Sets the hull's level by its XP; points beyond the new level are taken back from the last slots. */
export function setLevel(affinity: CatalogAffinity, progression: OpenProgression, level: number): OpenProgression {
  const layout = affinity.layout;
  if (!layout || !Number.isFinite(level)) return progression;
  const clamped = Math.min(affinity.maxLevel, Math.max(1, Math.trunc(level)));
  const xp = affinity.levelXp[clamped - 1] ?? 0;
  if (xp === progression.affinityXp) return progression;
  let allocated = [...progression.allocatedPoints];
  let excess = totalPoints(progression) - clamped;
  for (let slot = allocated.length - 1; slot >= 0 && excess > 0; slot--) {
    const taken = Math.min(allocated[slot]!, excess);
    allocated[slot] = allocated[slot]! - taken;
    excess -= taken;
  }
  allocated = trimmed(allocated, 0);
  return settleThresholds(affinity, layout, { ...progression, affinityXp: xp, allocatedPoints: allocated });
}

/** Whether one more point can go to a bonus: points left, room in the type and in the bonus. */
export function canAllocate(affinity: CatalogAffinity, progression: OpenProgression, moduleType: string, option: number): boolean {
  const layout = affinity.layout;
  const type = affinity.types.find((each) => each.moduleType === moduleType);
  if (!layout || !type || !type.bonuses.some((bonus) => bonus.option === option) || allocationSlot(layout, moduleType, option) === null) return false;
  return (
    totalPoints(progression) < earnedPoints(affinity, progression.affinityXp) &&
    typePoints(layout, progression, moduleType) < affinity.maxPointsPerCategory &&
    pointsAt(layout, progression, moduleType, option) < affinity.maxPointsPerBonus
  );
}

/** Adds (+1) or takes back (-1) one point. */
export function allocate(affinity: CatalogAffinity, progression: OpenProgression, moduleType: string, option: number, delta: 1 | -1): OpenProgression {
  const layout = affinity.layout;
  const slot = layout ? allocationSlot(layout, moduleType, option) : null;
  if (!layout || slot === null) return progression;
  const current = pointsAt(layout, progression, moduleType, option);
  if (delta === 1 && !canAllocate(affinity, progression, moduleType, option)) return progression;
  if (delta === -1 && current === 0) return progression;
  return settleThresholds(affinity, layout, { ...progression, allocatedPoints: written(progression.allocatedPoints, slot, current + delta, 0) });
}

/** Picks (or clears with null) a threshold choice the type's points reach. */
export function selectThreshold(affinity: CatalogAffinity, progression: OpenProgression, moduleType: string, tier: number, choice: number | null): OpenProgression {
  const type = affinity.types.find((each) => each.moduleType === moduleType);
  const threshold = type && choiceTiers(type).find((each) => each.tier === tier);
  const layout = affinity.layout;
  const slot = layout ? thresholdSlot(layout, moduleType, tier) : null;
  if (!layout || !threshold || slot === null) return progression;
  if (choice !== null && (choice < 0 || choice >= threshold.choices.length || typePoints(layout, progression, moduleType) < threshold.requiredPoints)) return progression;
  const unset = layout.selectionUnset;
  return { ...progression, thresholdSelections: written(progression.thresholdSelections, slot, choice ?? unset, unset) };
}

// ---- Reading a stored fit's affinity (published fits, cards, share card, compare) -------------------------

const NO_TYPE = "None";

const isInts = (value: unknown): value is number[] => Array.isArray(value) && value.every((each) => Number.isInteger(each));

/**
 * The progression a stored fit holds, or null when the JSON has none that can be read. A published fit
 * was checked by the engine, but a stored one is read back without trusting its shape. Without a layout
 * (no catalog, or an engine that sends none) only the type and XP are read: the slot arrays come back empty.
 */
export function readProgression(fit: unknown, layout: ProgressionLayout | null): OpenProgression | null {
  const progression = (fit as { progression?: unknown } | null)?.progression as Record<string, unknown> | null | undefined;
  if (!progression || typeof progression !== "object") return null;
  const { affinityType, affinityXp, allocatedPoints, thresholdSelections } = progression;
  if (typeof affinityType !== "string" || typeof affinityXp !== "number" || !Number.isFinite(affinityXp)) return null;
  if (!Array.isArray(allocatedPoints) || !Array.isArray(thresholdSelections)) return null;
  // Longer than the layout has slots is damaged or hostile: only the slots that exist are read.
  const points = allocatedPoints.slice(0, layout?.allocationSlots ?? 0);
  const selections = thresholdSelections.slice(0, layout?.thresholdSlots ?? 0);
  if (!isInts(points) || !isInts(selections)) return null;
  return { affinityType, affinityXp, allocatedPoints: points, thresholdSelections: selections };
}

/** Whether the hull has an affinity to show: a type, points spent, or XP beyond the first level. */
export function hasAffinity(affinity: CatalogAffinity, progression: OpenProgression): boolean {
  return progression.affinityType !== NO_TYPE || totalPoints(progression) > 0 || levelOf(affinity, progression.affinityXp) > 1;
}

/** A module type as the page words it: the catalog's name when it has one, else its enum name spaced. */
export function affinityTypeLabel(affinity: CatalogAffinity | null, moduleType: string): string {
  const found = affinity?.types.find((each) => each.moduleType === moduleType);
  return (found?.optionName || found?.name || moduleType.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).toUpperCase();
}

/** The module type holding the most allocated points; ties go to the one earlier in the layout's order. Null with no points. */
export function topPointsType(layout: ProgressionLayout, points: readonly number[]): string | null {
  const progression = { affinityType: NO_TYPE, affinityXp: 0, allocatedPoints: [...points], thresholdSelections: [] };
  let best: string | null = null;
  let bestPoints = 0;
  for (const [moduleType] of Object.entries(layout.moduleTypes).sort((x, y) => x[1] - y[1])) {
    const held = typePoints(layout, progression, moduleType);
    if (held > bestPoints) {
      best = moduleType;
      bestPoints = held;
    }
  }
  return best;
}

/**
 * The small tag on a card: "<TYPE> <LEVEL>" (just the type when no catalog turns XP into a level). The type
 * is the display focus when set (it never limits allocation), else the type with the most points (which
 * needs the catalog's layout to tell). Null when neither can be told: that reads as no affinity.
 */
export function affinityTag(affinity: CatalogAffinity | null, type: string | null, xp: number | null, points: readonly number[] | null): string | null {
  const layout = affinity?.layout ?? null;
  const shown = type && type !== NO_TYPE ? type : points && layout ? topPointsType(layout, points) : null;
  if (!shown) return null;
  const label = affinityTypeLabel(affinity, shown);
  return affinity && xp !== null ? `${label} ${levelOf(affinity, xp)}` : label;
}

export type AffinityCompareRow = { id: string; label: string; a: string; b: string; differs: boolean };

/**
 * Two fits' affinity side by side: the type and ship level, then the allocated points of every bonus either
 * has points in (left out without the catalog's layout). Empty when neither has an affinity. A side with no
 * readable progression reads "—".
 */
export function compareAffinity(affinity: CatalogAffinity, a: OpenProgression | null, b: OpenProgression | null): AffinityCompareRow[] {
  const shown = [a, b].filter((each): each is OpenProgression => each !== null && hasAffinity(affinity, each));
  if (shown.length === 0) return [];
  const MISSING = "—";
  const row = (id: string, label: string, text: (progression: OpenProgression) => string): AffinityCompareRow => {
    const left = a ? text(a) : MISSING;
    const right = b ? text(b) : MISSING;
    return { id, label, a: left, b: right, differs: left !== right };
  };
  const rows = [
    row("type", "AFFINITY TYPE", (each) => (each.affinityType === NO_TYPE ? "NONE" : affinityTypeLabel(affinity, each.affinityType))),
    row("level", "SHIP LEVEL", (each) => String(levelOf(affinity, each.affinityXp))),
  ];
  const layout = affinity.layout;
  for (const type of layout ? affinity.types : []) {
    for (const bonus of type.bonuses) {
      if (![a, b].some((each) => each !== null && pointsAt(layout!, each, type.moduleType, bonus.option) > 0)) continue;
      rows.push(row(`${type.moduleType}:${bonus.option}`, `${type.optionName || type.name} · ${bonus.name}`, (each) => String(pointsAt(layout!, each, type.moduleType, bonus.option))));
    }
  }
  return rows;
}
