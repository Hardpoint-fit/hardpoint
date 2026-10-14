import generated from "./art-manifest.generated.json";
import { artKeys } from "./art-key";

export type ArtVariant = "base" | "Augmented" | "Prototype" | "Artifact" | "Heretical";

/** A module, hull item or cipher's images by rarity variant; `base` is always present. The other
 *  variants exist only where the prefab authors them (BaseModuleDefPrototype.GetIcon picks among them). */
export type ModuleArt = { base: string } & Partial<Record<Exclude<ArtVariant, "base">, string>>;

/**
 * Written by tools/game-data-api/art/game-art.mjs from the Unity tree. Every URL is a 128px WebP under /art; the same
 * name with "@2x" before ".webp" is the 256px one (see `art2x`).
 */
export type ArtManifest = {
  /** Modules, hull items and ciphers, by key (see art-key.ts). */
  modules: Record<string, ModuleArt>;
  /** Artifact definitions' icons (shown for an identified artifact), by the definition's asset path key. */
  artifacts: Record<string, string>;
  /** Enemy ship-class sprites by ShipClass name: Frigate, Cruiser, Dreadnought, Unknown. */
  shipClasses: Record<string, string>;
};

export const artManifest: ArtManifest = generated;

/** The first manifest entry any of a path's (or name's) keys finds, or null for an item without art. */
export function findModuleArt(path: string | null | undefined, manifest: ArtManifest = artManifest): ModuleArt | null {
  for (const key of artKeys(path)) {
    const art = manifest.modules[key];
    if (art) return art;
  }
  return null;
}

export function findArtifactArt(path: string | null | undefined, manifest: ArtManifest = artManifest): string | null {
  for (const key of artKeys(path)) {
    const url = manifest.artifacts[key];
    if (url) return url;
  }
  return null;
}

/** The 256px twin of a manifest URL, for high-density screens. */
export function art2x(url: string): string {
  return url.replace(/\.webp$/, "@2x.webp");
}
