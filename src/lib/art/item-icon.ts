// Which image an item shows, by the game's rule (Runtime/ArenaUI/Foundation/SpriteElement.cs,
// ModuleIconPresentation.Resolve):
//   1. an identified item with an artifact shows that artifact's own icon, when the artifact authors one;
//   2. otherwise the module's icon for its rarity (BaseModuleDefPrototype.GetIcon): Augmented shows the
//      augmented icon, Prototype and Heretical the prototype icon (a heretical item was a Prototype before
//      its brand), Artifact the artifact icon, each falling back to the base icon when not authored;
//   3. an item with no art at all has no icon: the caller draws its placeholder.
// "Identified" is InventorySharedHelpers.IsEffectivelyIdentified: the category can't be identified, or
// the item is Normal rarity, or it has been identified.
import { artManifest, findArtifactArt, findModuleArt, type ArtManifest, type ModuleArt } from "./art-manifest";

/** IdentifyItemRules.SupportsIdentification. */
const IDENTIFIABLE = new Set(["Module", "Conduit", "Consumable", "Ship"]);

export function isEffectivelyIdentified(category: string | null, roll: { rarity: string; isIdentified: boolean }): boolean {
  return category === null || !IDENTIFIABLE.has(category) || roll.rarity === "Normal" || roll.isIdentified;
}

/** BaseModuleDefPrototype.GetIcon(rarity) over the manifest's variants. */
export function moduleIcon(art: ModuleArt, rarity: string): string {
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
  /** The item prototype's catalog path (a module, hull or cipher). */
  path: string | null;
  /** ItemCategory; null when unknown, which nothing can identify. */
  category: string | null;
};

export type IconRoll = { rarity: string; isIdentified: boolean };

/**
 * The image URL (128px; see art2x for 256px) an item shows, or null when it has none. `artifactPath` is
 * the catalog `path` of the artifact the roll names, if any: its asset is found by that path.
 */
export function itemIcon(subject: IconSubject, roll: IconRoll, artifactPath: string | null = null, manifest: ArtManifest = artManifest): string | null {
  if (artifactPath && isEffectivelyIdentified(subject.category, roll)) {
    const own = findArtifactArt(artifactPath, manifest);
    if (own) return own;
  }
  const art = findModuleArt(subject.path, manifest);
  return art ? moduleIcon(art, roll.rarity) : null;
}

/** The icon of an item's plainest roll: what the palette and hull picker show. */
export function baseIcon(path: string | null, manifest: ArtManifest = artManifest): string | null {
  return findModuleArt(path, manifest)?.base ?? null;
}
