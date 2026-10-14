// RANDOMIZE ROLL and each modifier line's dice: the selected item's modifiers rolled by the engine with the
// game's own roller, the way a drop rolls them (POST /v1/roll). The answer becomes a "rolled" roll edit for
// the reducer, so it is one edit like any manual one and the engine judges the fit again after it.
import type { EngineClient } from "#/lib/engine/client";
import type { Catalog, CatalogBreachTier, OpenItem } from "#/lib/engine/types";
import { ROLLED_RARITIES } from "./roll-edits";
import { isTemplated, modifierCount, type BuilderCatalog, type RollSubject } from "./rules";
import type { RollEdit } from "./state";

/** The tiers a roll can be made at. An engine older than the roll route lists none, and the builder offers no dice. */
export function breachTiers(catalog: Catalog): CatalogBreachTier[] {
  return (catalog.breachTiers as CatalogBreachTier[] | undefined) ?? [];
}

/** The highest tier, as the engine rolls without one: the best odds at the best tiers. */
export function defaultBreachTier(catalog: Catalog): number | null {
  return breachTiers(catalog).at(-1)?.index ?? null;
}

/** Whether the engine can roll this item: an Augmented or Prototype roll with a pool to roll from. */
export function canRandomize(cat: BuilderCatalog, subject: RollSubject, item: OpenItem): boolean {
  const roll = item.roll;
  return breachTiers(cat.catalog).length > 0 && ROLLED_RARITIES.includes(roll.rarity) && !isTemplated(roll.rarity) && modifierCount(cat, subject, roll).max > 0;
}

export type Randomized =
  | { ok: true; edit: RollEdit; seed: number; breachTier: number }
  /** `message` is for the player; a cancelled roll (a newer one replaced it) has none to show. */
  | { ok: false; message: string | null };

export const ROLL_MESSAGES = {
  rateLimited: "TOO MANY ROLLS. WAIT A MOMENT, THEN ROLL AGAIN.",
  rejected: "THE ENGINE CAN'T ROLL THIS ITEM AS IT IS.",
  unavailable: "THE ENGINE ISN'T ANSWERING, SO NOTHING WAS ROLLED. TRY AGAIN SHORTLY.",
} as const;

/** Asks the engine to roll every modifier of `item`, or `line` alone, at `breachTier`. Never throws. */
export async function randomize(
  engine: Pick<EngineClient, "roll">,
  item: OpenItem,
  options: { breachTier: number; line?: number; signal?: AbortSignal },
): Promise<Randomized> {
  const { breachTier, line, signal } = options;
  const result = await engine.roll({ item, breachTier, ...(line === undefined ? {} : { line }) }, { signal });
  if (result.ok) {
    const { item: rolled, seed } = result.value;
    return { ok: true, edit: { kind: "rolled", def: item.def, sent: item.roll, rolled: rolled.roll }, seed, breachTier: result.value.breachTier };
  }
  switch (result.error.kind) {
    case "cancelled":
      return { ok: false, message: null };
    case "rateLimited":
      return { ok: false, message: ROLL_MESSAGES.rateLimited };
    case "rejected":
      return { ok: false, message: ROLL_MESSAGES.rejected };
    default:
      return { ok: false, message: ROLL_MESSAGES.unavailable };
  }
}
