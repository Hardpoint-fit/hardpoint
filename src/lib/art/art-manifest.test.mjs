import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { art2x, artManifest, findArtifactArt, findModuleArt } from "./art-manifest.ts";

const catalog = JSON.parse(readFileSync(new URL("../engine/__fixtures__/catalog.json", import.meta.url), "utf8"));
const publicDir = new URL("../../../public", import.meta.url).pathname;

// Fixture entries the Unity tree has no prefab icon for (none today). Ammo has no game owner for icons
// and is not a module here, so it is not in the manifest and shows the site's placeholder.
const NO_ART = new Set();

test("every module and hull in the catalog fixture has art or is listed as having none", () => {
  const withArt = [];
  const without = [];
  for (const entry of [...catalog.items, ...catalog.hulls]) (findModuleArt(entry.path) ? withArt : without).push(entry.name);
  console.log(`art coverage: ${withArt.length} with art, ${without.length} without (${[...new Set(without)].join(", ") || "none"})`);
  assert.deepEqual([...new Set(without)].filter((name) => !NO_ART.has(name)), [], "items without art that are not listed");
  for (const name of NO_ART) assert.ok(without.includes(name), `${name} now has art; drop it from NO_ART`);
});

test("ciphers in the catalog have art by path", () => {
  for (const cipher of catalog.ciphers) assert.ok(findModuleArt(cipher.path)?.base, cipher.name);
});

test("every manifest URL has both sizes on disk", () => {
  const urls = [...Object.values(artManifest.modules).flatMap((art) => Object.values(art)), ...Object.values(artManifest.artifacts), ...Object.values(artManifest.shipClasses)];
  assert.ok(urls.length > 0);
  for (const url of new Set(urls)) {
    assert.ok(existsSync(join(publicDir, url)), url);
    assert.ok(existsSync(join(publicDir, art2x(url))), art2x(url));
  }
  assert.equal(art2x("/art/a.webp"), "/art/a@2x.webp");
});

test("the manifest carries ship classes and looks artifacts up by path", () => {
  for (const shipClass of ["Frigate", "Cruiser", "Dreadnought", "Unknown"]) assert.match(artManifest.shipClasses[shipClass], /^\/art\/[0-9a-f]{32}\.[0-9a-f]{16}\.webp$/);
  const [key, url] = Object.entries(artManifest.artifacts)[0];
  assert.equal(findArtifactArt(key), url);
  assert.equal(findArtifactArt("Not An Artifact"), null);
  assert.equal(findModuleArt(null), null);
});
