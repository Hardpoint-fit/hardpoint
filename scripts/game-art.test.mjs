import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { assertNotLfsPointer, buildArtManifest, buildGameArt } from "./game-art.mjs";

const MARKER = "m_Script: {fileID: 11500000, guid: 134bc6beb3b4b4dd3a8bb00317c7f27f, type: 3}";
const LFS = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n";

/** A one-module Unity tree: a prefab whose icon and Prototype icon are the given images. */
function tree(images) {
  const root = mkdtempSync(join(tmpdir(), "game-art-"));
  const assets = join(root, "Assets");
  mkdirSync(join(assets, "Modules"), { recursive: true });
  mkdirSync(join(assets, "Icons"), { recursive: true });
  const guid = (n) => String(n).padStart(32, "0");
  images.forEach(({ name, bytes }, i) => {
    writeFileSync(join(assets, "Icons", name), bytes);
    writeFileSync(join(assets, "Icons", `${name}.meta`), `fileFormatVersion: 2\nguid: ${guid(i + 1)}\n`);
  });
  const prefab = `--- !u!114 &1\nMonoBehaviour:\n  ${MARKER}\n  data:\n    icon: {fileID: 21300000, guid: ${guid(1)}, type: 3}\n    prototypeIcon: {fileID: 21300000, guid: ${guid(images.length)}, type: 3}\n    name: Test Module\n`;
  writeFileSync(join(assets, "Modules", "Test Module.prefab"), prefab);
  return { root, assets, out: join(root, "out"), manifest: join(root, "manifest.json") };
}

const png = (color) => sharp({ create: { width: 40, height: 40, channels: 4, background: color } }).png().toBuffer();

test("the manifest keeps only variants whose image was written", () => {
  const manifest = buildArtManifest(
    { rarityIconsByKey: new Map([["testmodule", { base: "a", Prototype: "b", Heretical: "b", Artifact: "missing" }], ["noimage", { base: "missing" }]]), artifactIconsByKey: new Map([["art", "a"]]), shipClassSprites: new Map([["Frigate", "b"], ["Gone", "missing"]]) },
    new Set(["a", "b"]),
  );
  assert.deepEqual(manifest, {
    modules: { testmodule: { base: "/art/a.webp", Prototype: "/art/b.webp", Heretical: "/art/b.webp" } },
    artifacts: { art: "/art/a.webp" },
    shipClasses: { Frigate: "/art/b.webp" },
  });
});

test("a tree's module images become 128 and 256 webp files and manifest URLs, and a second run rebuilds nothing", async () => {
  const t = tree([{ name: "a.png", bytes: await png("#ff0000") }, { name: "b.png", bytes: await png("#00ff00") }]);
  try {
    const first = await buildGameArt({ assetsRoot: t.assets, outDir: t.out, manifestFile: t.manifest });
    assert.equal(first.images, 2);
    assert.equal(first.rebuilt, 2);
    const manifest = JSON.parse(readFileSync(t.manifest, "utf8"));
    assert.equal(manifest.modules.testmodule.base, "/art/00000000000000000000000000000001.webp");
    assert.equal(manifest.modules.testmodule.Prototype, "/art/00000000000000000000000000000002.webp");
    const meta = await sharp(join(t.out, "00000000000000000000000000000001@2x.webp")).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, 40); // never enlarged
    assert.equal(readdirSync(t.out).filter((name) => name.endsWith(".webp")).length, 4);
    assert.equal((await buildGameArt({ assetsRoot: t.assets, outDir: t.out, manifestFile: t.manifest })).rebuilt, 0);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("an icon that is still a Git LFS pointer fails the build", async () => {
  const t = tree([{ name: "a.png", bytes: Buffer.from(LFS) }]);
  try {
    await assert.rejects(buildGameArt({ assetsRoot: t.assets, outDir: t.out, manifestFile: t.manifest }), /Git LFS pointer: .*a\.png/);
    assert.throws(() => assertNotLfsPointer(join(t.assets, "Icons", "a.png")), /git lfs pull/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
