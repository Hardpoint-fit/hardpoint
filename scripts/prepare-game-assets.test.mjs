import assert from "node:assert/strict";
import test from "node:test";
import { buildTokensCss, ussTokensToCss } from "./prepare-game-assets.mjs";

test("Unity-only declarations are dropped and custom properties kept", () => {
  const css = ussTokensToCss(`:root { --a: 1px; --font-family: resource("Fonts/X"); -unity-font-definition: var(--font-family); }
.u-font-regular { -unity-font-style: normal; }`);
  assert.match(css, /--a: 1px/);
  assert.doesNotMatch(css, /unity|resource/);
  assert.doesNotMatch(css, /u-font-regular/);
});

test("the real token sheets convert and still define the game palette", () => {
  const css = buildTokensCss();
  assert.match(css, /--accent-orange:/);
  assert.match(css, /--text-primary:/);
  assert.doesNotMatch(css, /resource\(|-unity-/);
});

test("the fitting art carries the game's 48px port notches, hardpoint glyphs and grid colours", async () => {
  const { buildFittingArt } = await import("./prepare-game-assets.mjs");
  const art = buildFittingArt();
  assert.equal(art.cellSize, 48);
  assert.equal(art.slotInset, 3);
  for (const form of ["FemaleOpen", "MaleAttached", "Expansion"]) {
    assert.equal(art.ports[form].length, 4, `${form} has a notch per direction`);
    for (const notch of art.ports[form]) assert.ok(notch.borders.length > 0);
  }
  for (const slot of ["Battery", "Subsystem", "Propulsion"]) assert.ok(art.hardpoints[slot].paths.length > 0);
  assert.match(art.colors.ConduitConnected, /^rgba\(180, 180, 0, 1\)$/);
  assert.equal(art.tiers.standard.bg, "rgb(34, 36, 40)");
  assert.equal(art.tokens["accent-orange"], "rgb(255, 153, 0)");
});

test("stat wording is read from the game and covers every displayable stat", async () => {
  const { buildStatText } = await import("./prepare-game-assets.mjs");
  const text = buildStatText();
  assert.equal(text.labels.MaxSpeed, "MAX VELOCITY");
  assert.ok(text.lowerIsBetter.includes("Mass"));
  assert.ok(text.integer.includes("CargoCapacity"));
  assert.deepEqual(text.inverted, [{ stat: "TurretCycleDuration", operation: "Multiply" }]);
  assert.throws(
    () => buildStatText('StatType.A => "A",', "static bool IsIntegerValued(StatType t) => false; static bool IsLowerBetter(StatType t) => false;", "enum StatType {\n  None = 0,\n  A = 1,\n  B = 2,\n}"),
    /without display copy: B/,
  );
});
