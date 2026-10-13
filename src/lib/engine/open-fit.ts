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

/** An open fit the builder can edit: drawable, with a hull roll and a progression. */
export function isEditableFit(value: unknown): value is OpenFit {
  if (!isOpenFit(value)) return false;
  const fit = value as unknown as Record<string, unknown> & { hull: Record<string, unknown> };
  const progression = fit.progression;
  return (
    isRoll(fit.hull.roll) &&
    isObject(progression) &&
    typeof progression.affinityType === "string" &&
    Number.isInteger(progression.affinityXp) &&
    isInts(progression.allocatedPoints) &&
    isInts(progression.thresholdSelections) &&
    value.ammo.every((ammo) => isObject(ammo) && Number.isInteger(ammo.moduleIndex) && typeof ammo.ammoType === "string")
  );
}
