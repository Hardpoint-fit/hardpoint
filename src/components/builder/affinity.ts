// Affinity points as an open fit stores them (ShipProgression's fixed arrays, laid out as the game's
// AffinitySystem indexes them; the layout is generated from the Unity source) and the limits the
// catalog's affinity tree sets. The engine validates progressions (ProgressionRules); the builder
// offers only what its rules allow. Pure: no React.
import type { CatalogAffinity, CatalogAffinityType, OpenProgression } from "#/lib/engine/types";
import layout from "#/lib/engine/progression-layout.generated.json";

const LAYOUT = layout as {
  moduleTypes: Record<string, number>;
  optionsPerType: number;
  tiersPerType: number;
  allocationSlots: number;
  thresholdSlots: number;
  selectionUnset: number;
};

export const SELECTION_UNSET = LAYOUT.selectionUnset;

function typeIndex(moduleType: string): number | null {
  const value = LAYOUT.moduleTypes[moduleType];
  return value === undefined ? null : value;
}

export function allocationSlot(moduleType: string, option: number): number | null {
  const type = typeIndex(moduleType);
  if (type === null || option < 0 || option >= LAYOUT.optionsPerType) return null;
  const slot = type * LAYOUT.optionsPerType + option;
  return slot < LAYOUT.allocationSlots ? slot : null;
}

export function thresholdSlot(moduleType: string, tier: number): number | null {
  const type = typeIndex(moduleType);
  if (type === null || tier < 0 || tier >= LAYOUT.tiersPerType) return null;
  const slot = type * LAYOUT.tiersPerType + tier;
  return slot < LAYOUT.thresholdSlots ? slot : null;
}

export function pointsAt(progression: OpenProgression, moduleType: string, option: number): number {
  const slot = allocationSlot(moduleType, option);
  return slot === null ? 0 : (progression.allocatedPoints[slot] ?? 0);
}

export function typePoints(progression: OpenProgression, moduleType: string): number {
  let total = 0;
  for (let option = 0; option < LAYOUT.optionsPerType; option++) total += pointsAt(progression, moduleType, option);
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

export function selectionAt(progression: OpenProgression, moduleType: string, tier: number): number | null {
  const slot = thresholdSlot(moduleType, tier);
  const value = slot === null ? undefined : progression.thresholdSelections[slot];
  return value === undefined || value === SELECTION_UNSET ? null : value;
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
function settleThresholds(affinity: CatalogAffinity, progression: OpenProgression): OpenProgression {
  let selections = progression.thresholdSelections;
  for (const type of affinity.types) {
    const points = typePoints(progression, type.moduleType);
    for (const tier of type.thresholds) {
      const slot = thresholdSlot(type.moduleType, tier.tier);
      if (slot !== null && points < tier.requiredPoints && (selections[slot] ?? SELECTION_UNSET) !== SELECTION_UNSET) {
        selections = written(selections, slot, SELECTION_UNSET, SELECTION_UNSET);
      }
    }
  }
  return selections === progression.thresholdSelections ? progression : { ...progression, thresholdSelections: selections };
}

/** Sets the hull's level by its XP; points beyond the new level are taken back from the last slots. */
export function setLevel(affinity: CatalogAffinity, progression: OpenProgression, level: number): OpenProgression {
  if (!Number.isFinite(level)) return progression;
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
  return settleThresholds(affinity, { ...progression, affinityXp: xp, allocatedPoints: allocated });
}

/** Whether one more point can go to a bonus: points left, room in the type and in the bonus. */
export function canAllocate(affinity: CatalogAffinity, progression: OpenProgression, moduleType: string, option: number): boolean {
  const type = affinity.types.find((each) => each.moduleType === moduleType);
  if (!type || !type.bonuses.some((bonus) => bonus.option === option) || allocationSlot(moduleType, option) === null) return false;
  return (
    totalPoints(progression) < earnedPoints(affinity, progression.affinityXp) &&
    typePoints(progression, moduleType) < affinity.maxPointsPerCategory &&
    pointsAt(progression, moduleType, option) < affinity.maxPointsPerBonus
  );
}

/** Adds (+1) or takes back (-1) one point. */
export function allocate(affinity: CatalogAffinity, progression: OpenProgression, moduleType: string, option: number, delta: 1 | -1): OpenProgression {
  const slot = allocationSlot(moduleType, option);
  if (slot === null) return progression;
  const current = pointsAt(progression, moduleType, option);
  if (delta === 1 && !canAllocate(affinity, progression, moduleType, option)) return progression;
  if (delta === -1 && current === 0) return progression;
  return settleThresholds(affinity, { ...progression, allocatedPoints: written(progression.allocatedPoints, slot, current + delta, 0) });
}

/** Picks (or clears with null) a threshold choice the type's points reach. */
export function selectThreshold(affinity: CatalogAffinity, progression: OpenProgression, moduleType: string, tier: number, choice: number | null): OpenProgression {
  const type = affinity.types.find((each) => each.moduleType === moduleType);
  const threshold = type && choiceTiers(type).find((each) => each.tier === tier);
  const slot = thresholdSlot(moduleType, tier);
  if (!threshold || slot === null) return progression;
  if (choice !== null && (choice < 0 || choice >= threshold.choices.length || typePoints(progression, moduleType) < threshold.requiredPoints)) return progression;
  return { ...progression, thresholdSelections: written(progression.thresholdSelections, slot, choice ?? SELECTION_UNSET, SELECTION_UNSET) };
}
