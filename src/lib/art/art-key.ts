// How the site joins a catalog item to its game art. The art manifest (art-manifest.generated.json,
// written by scripts/game-art.mjs) is keyed the way tools/ship-restore/lib/game-assets.js keys icons
// (`iconKeys`): a name lower-cased with everything but a-z and 0-9 removed. The catalog's `path` is the
// prototype's Identifier.Path, the item prefab's path plus "EntityPrototype". Candidates, most specific
// first:
//   1. the whole path, minus "Assets/" and the trailing (Entity|Ship)Prototype: the prefab's own path;
//   2. the text as given, then its last path segment, as is (`iconKeys`' first two);
//   3. that segment minus the (Entity|Ship)Prototype suffix: the prefab's file name;
//   4. that, minus a trailing " Hull": a hull item's ship name.
// Candidates 2-4 are exactly what `iconKeys` returns; 1 only makes a path more specific than a file
// name, since several prefabs share one. The first candidate the manifest has wins. A display name
// (catalog `name`) has no path, so it has no candidate 1.

const SUFFIX = /(?:Entity|Ship)?Prototype$/i;

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Every manifest key an item path (or name) can be found under, most specific first. */
export function artKeys(path: string | null | undefined): string[] {
  const text = String(path ?? "").trim();
  if (!text || text.length > 500) return [];
  const tail = text.split("/").at(-1) ?? "";
  const withoutPrototype = tail.replace(SUFFIX, "");
  const withoutHull = withoutPrototype.replace(/ Hull$/i, "");
  const whole = text.includes("/") ? text.replace(/^Assets\//i, "").replace(SUFFIX, "") : "";
  return [...new Set([whole, text, tail, withoutPrototype, withoutHull].map(normalize).filter(Boolean))];
}

/** The most specific key for a path: the one an exact prefab path is stored under. */
export function artKey(path: string | null | undefined): string {
  return artKeys(path)[0] ?? "";
}
