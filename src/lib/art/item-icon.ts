// Which image an item shows, by the game's rule (Runtime/ArenaUI/Foundation/SpriteElement.cs,
// ModuleIconPresentation.Resolve):
//   1. an identified item with an artifact shows that artifact's own icon, when the artifact authors one;
//   2. otherwise the module's icon for its rarity (BaseModuleDefPrototype.GetIcon): Augmented shows the
//      augmented icon, Prototype and Heretical the prototype icon (a heretical item was a Prototype before
//      its brand), Artifact the artifact icon, each falling back to the base icon when not authored;
//   3. an item with no art at all has no icon: the caller draws its placeholder.
// "Identified" is InventorySharedHelpers.IsEffectivelyIdentified: the category can't be identified, or
// the item is Normal rarity, or it has been identified.
// The images are the API's: each catalog entity carries its `art` (URLs), and this only picks among them.
import type { ArtKeys } from "../engine/types.ts";

/** IdentifyItemRules.SupportsIdentification. */
const IDENTIFIABLE = new Set(["Module", "Conduit", "Consumable", "Ship"]);

export function isEffectivelyIdentified(category: string | null, roll: { rarity: string; isIdentified: boolean }): boolean {
  return category === null || !IDENTIFIABLE.has(category) || roll.rarity === "Normal" || roll.isIdentified;
}

/** BaseModuleDefPrototype.GetIcon(rarity) over the art's variants. */
export function moduleIcon(art: ArtKeys, rarity: string): string {
  switch (rarity) {
    case "Augmented":
      return art.Augmented ?? art.base;
    case "Prototype":
    case "Heretical":
      return art.Prototype ?? art.base;
    case "Artifact":
      return art.Artifact ?? art.base;
    default:
      return art.base;
  }
}

export type IconSubject = {
  /** The item's, hull's or cipher's catalog `art`. */
  art: ArtKeys | null;
  /** ItemCategory; null when unknown, which nothing can identify. */
  category: string | null;
};

export type IconRoll = { rarity: string; isIdentified: boolean };

/**
 * The image URL (128px; see art2x for 256px) an item shows, or null when it has none. `artifactArt` is
 * the catalog `art` of the artifact the roll names, if any (null for one that authors no icon).
 */
export function itemIcon(subject: IconSubject, roll: IconRoll, artifactArt: ArtKeys | null = null): string | null {
  if (artifactArt && isEffectivelyIdentified(subject.category, roll)) return artifactArt.base;
  return subject.art ? moduleIcon(subject.art, roll.rarity) : null;
}

/** The icon of an item's plainest roll: what the palette and hull picker show. */
export function baseIcon(art: ArtKeys | null): string | null {
  return art?.base ?? null;
}

/** The 256px twin of an art URL, for high-density screens. */
export function art2x(url: string): string {
  return url.replace(/\.webp$/, "@2x.webp");
}
