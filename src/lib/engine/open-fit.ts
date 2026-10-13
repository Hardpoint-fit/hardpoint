// Shape checks for open fit JSON that came from somewhere the site doesn't control: the database, a
// browser's saved draft, a server action's argument. Enough to draw or edit it safely; the engine
// judges everything else. Pure, so client and server code share it.
import type { OpenFit } from "./types";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isInts = (value: unknown): value is number[] => Array.isArray(value) && value.every((each) => Number.isInteger(each));

function isRoll(value: unknown): boolean {
  return isObject(value) && Array.isArray(value.ports) && Array.isArray(value.modifiers);
}

/** Enough of an open fit's shape to draw it. */
export function isOpenFit(value: unknown): value is OpenFit {
  if (!isObject(value) || !isObject(value.hull) || typeof value.hull.def !== "string") return false;
  if (!Array.isArray(value.modules) || !Array.isArray(value.ammo) || !Array.isArray(value.slotOverrides)) return false;
  return value.modules.every(
    (module) =>
      isObject(module) &&
      isObject(module.item) &&
      typeof module.item.def === "string" &&
      isRoll(module.item.roll) &&
      Number.isInteger(module.row) &&
      Number.isInteger(module.col) &&
      Number.isInteger(module.rotation),
  );
}

const isString = (value: unknown): value is string => typeof value === "string";
const isRef = (value: unknown) => value === null || isString(value);
const isInt = (value: unknown) => Number.isInteger(value);
const isBool = (value: unknown) => typeof value === "boolean";

function isModifier(value: unknown): boolean {
  return (
    isObject(value) &&
    isString(value.stat) &&
    isString(value.operation) &&
    isInt(value.tier) &&
    isString(value.value) &&
    isInt(value.slot) &&
    isBool(value.isInverted) &&
    isBool(value.isFractured)
  );
}

const isPort = (value: unknown) => isObject(value) && isInt(value.row) && isInt(value.col) && isString(value.direction) && isRef(value.cipher);

const isScaledStat = (value: unknown) => value === null || (isObject(value) && isRef(value.rule) && isString(value.strength));

/** Every field of a roll the builder reads, with the right type. */
function isEditableRoll(value: unknown): boolean {
  return (
    isObject(value) &&
    isString(value.quality) &&
    isString(value.rarity) &&
    Array.isArray(value.modifiers) &&
    value.modifiers.every(isModifier) &&
    Array.isArray(value.ports) &&
    value.ports.every(isPort) &&
    isRef(value.artifact) &&
    isRef(value.regalia) &&
    isRef(value.heretical) &&
    isRef(value.moduleTypeOverride) &&
    isRef(value.harmonicSet) &&
    isBool(value.isIdentified) &&
    isBool(value.isHarmonized) &&
    isBool(value.isMirrored) &&
    isScaledStat(value.scaledStat)
  );
}

const isEditableItem = (value: unknown) => isObject(value) && isString(value.def) && isEditableRoll(value.roll) && isInt(value.patina);

/**
 * An open fit the builder can edit: every field it reads (rolls, ports, modifiers, progression, ammo,
 * slot overrides) present with its type. For drafts from a browser and fits read back for editing.
 */
export function isEditableFit(value: unknown): value is OpenFit {
  if (!isOpenFit(value)) return false;
  const fit = value as unknown as Record<string, unknown> & { hull: Record<string, unknown> };
  const progression = fit.progression;
  return (
    isEditableItem(fit.hull) &&
    value.modules.every((module) => isEditableItem(module.item)) &&
    value.slotOverrides.every((override) => isObject(override) && isInt(override.cell) && isString(override.slotType)) &&
    isObject(progression) &&
    typeof progression.affinityType === "string" &&
    Number.isInteger(progression.affinityXp) &&
    isInts(progression.allocatedPoints) &&
    isInts(progression.thresholdSelections) &&
    value.ammo.every((ammo) => isObject(ammo) && Number.isInteger(ammo.moduleIndex) && typeof ammo.ammoType === "string")
  );
}
