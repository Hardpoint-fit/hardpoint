// Extracts the game's item art for the site. The Unity tree owns which sprite an item shows
// (BaseModuleDefPrototype.GetIcon's icon, augmentedIcon, prototypeIcon, artifactIcon fields; the
// artifact definition's icon; EntityOverlayHudConfig's ship-class sprites), and tools/ship-restore/lib/
// game-assets.js, shared with the killboard, already reads exactly those fields. This file only turns
// what it indexes into web images and a manifest; it adds no icon rules of its own.
//
// Outputs (gitignored, rebuilt by scripts/prepare-game-assets.mjs):
//   public/art/<guid>.<hash>.webp      the image trimmed and fitted inside 128x128
//   public/art/<guid>.<hash>@2x.webp   the same fitted inside 256x256
//   src/lib/art/art-manifest.generated.json   see src/lib/art/art-manifest.ts for its shape
//   .cache/game-art.json               each source's size and mtime, so unchanged images aren't rebuilt
// <hash> is of both images' bytes, so a name never changes content: the site serves /art immutable.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { readGameAssets } = require("../../../../tools/ship-restore/lib/game-assets.js");

const SIZES = [
  ["", 128],
  ["@2x", 256],
];
const VARIANTS = ["base", "Augmented", "Prototype", "Artifact", "Heretical"];
// Bump when the image pipeline changes, so cached images are rebuilt.
const PIPELINE_VERSION = 2;
const LFS_SPEC = "version https://git-lfs.github.com/spec/v1";

/** An image still a Git LFS pointer (art not fetched) cannot be decoded; building must stop, not ship blanks. */
export function assertNotLfsPointer(file) {
  const head = Buffer.alloc(LFS_SPEC.length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  if (head.toString("utf8") === LFS_SPEC) throw new Error(`Game art is a Git LFS pointer: ${file}. Run \`git lfs pull\` (or fetch the art) before building.`);
}

/**
 * The manifest from the asset index: module-like prefabs (modules, hull items, ciphers) by normalized
 * key with the variants that have an image, artifacts by key, and ship-class sprites by class. Entries
 * whose image was not written are left out, so the site never names a missing file. `written` maps each
 * written image's guid to its file stem (`<guid>.<hash>`).
 */
export function buildArtManifest({ rarityIconsByKey, artifactIconsByKey, shipClassSprites }, written, base = "/art") {
  const url = (guid) => `${base}/${written.get(guid)}.webp`;
  const modules = {};
  for (const [key, icons] of [...rarityIconsByKey].sort(([a], [b]) => a.localeCompare(b))) {
    if (!icons.base || !written.has(icons.base)) continue;
    modules[key] = Object.fromEntries(VARIANTS.filter((variant) => icons[variant] && written.has(icons[variant])).map((variant) => [variant, url(icons[variant])]));
  }
  const only = (map) => Object.fromEntries([...map].filter(([, guid]) => written.has(guid)).sort(([a], [b]) => a.localeCompare(b)).map(([key, guid]) => [key, url(guid)]));
  return { modules, artifacts: only(artifactIconsByKey), shipClasses: only(shipClassSprites) };
}

/**
 * Writes the web images and the manifest. An image is rebuilt only when its source's size or mtime
 * changed (cacheFile, kept outside the served directory), so a second run reads no pixels. Returns
 * counts for reporting.
 */
export async function buildGameArt({ assetsRoot, outDir, manifestFile, cacheFile, base = "/art" }) {
  const index = readGameAssets(assetsRoot);
  const { imagesByGuid, rarityIconsByKey, artifactIconsByKey, shipClassSprites } = index;
  const wanted = new Set([
    ...[...rarityIconsByKey.values()].flatMap((icons) => Object.values(icons).filter(Boolean)),
    ...artifactIconsByKey.values(),
    ...shipClassSprites.values(),
  ]);

  mkdirSync(outDir, { recursive: true });
  let cache = {};
  try {
    const stored = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (stored.version === PIPELINE_VERSION) cache = stored.images;
  } catch {}

  /** guid -> file stem. */
  const written = new Map();
  const unresolved = [];
  const next = {};
  let rebuilt = 0;
  let bytes = 0;
  for (const guid of [...wanted].sort()) {
    const image = imagesByGuid.get(guid);
    if (!image) {
      unresolved.push(guid);
      continue;
    }
    assertNotLfsPointer(image.file);
    const stat = statSync(image.file);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const files = (hash) => SIZES.map(([suffix]) => join(outDir, `${guid}.${hash}${suffix}.webp`));
    let hash = cache[guid]?.signature === signature ? cache[guid].hash : null;
    if (!hash || !files(hash).every((file) => existsSync(file))) {
      // Item renders sit in canvases with wide transparent margins: trim them so the icon fills its box.
      const source = await sharp(image.file)
        .trim({ threshold: 1 })
        .toBuffer()
        .catch(() => readFileSync(image.file));
      const images = [];
      for (const [, size] of SIZES)
        images.push(await sharp(source).resize(size, size, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82, alphaQuality: 90 }).toBuffer());
      const digest = createHash("sha256");
      for (const each of images) digest.update(each);
      hash = digest.digest("hex").slice(0, 16);
      files(hash).forEach((file, i) => writeFileSync(file, images[i]));
      rebuilt++;
    }
    next[guid] = { signature, hash };
    bytes += files(hash).reduce((sum, file) => sum + statSync(file).size, 0);
    written.set(guid, `${guid}.${hash}`);
  }
  // Every other image (and the cache an older pipeline kept here) is removed, so public/art holds
  // exactly the manifest's files.
  const kept = new Set([...written.values()].flatMap((stem) => SIZES.map(([suffix]) => `${stem}${suffix}.webp`)));
  for (const name of readdirSync(outDir)) if ((name.endsWith(".webp") || name === ".cache.json") && !kept.has(name)) rmSync(join(outDir, name));
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ version: PIPELINE_VERSION, images: next }));

  const manifest = buildArtManifest(index, written, base);
  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 1)}\n`);
  return {
    images: written.size,
    rebuilt,
    bytes,
    unresolved,
    modules: Object.keys(manifest.modules).length,
    artifacts: Object.keys(manifest.artifacts).length,
    shipClasses: Object.keys(manifest.shipClasses).length,
    manifestFile: relative(process.cwd(), manifestFile),
  };
}
