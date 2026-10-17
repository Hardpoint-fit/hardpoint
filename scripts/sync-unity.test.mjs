import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { OUTPUTS, buildCardTokens, ussTokensToCss } from "./sync-unity.mjs";

test("Unity-only declarations are dropped and custom properties kept", () => {
  const css = ussTokensToCss(`:root { --a: 1px; --font-family: resource("Fonts/X"); -unity-font-definition: var(--font-family); }
.u-font-regular { -unity-font-style: normal; }`);
  assert.match(css, /--a: 1px/);
  assert.doesNotMatch(css, /unity|resource/);
  assert.doesNotMatch(css, /u-font-regular/);
});

test("the synced token sheet defines the game palette and nothing Unity-only", () => {
  const css = readFileSync(OUTPUTS.tokens, "utf8");
  assert.match(css, /--accent-orange:/);
  assert.match(css, /--text-primary:/);
  assert.doesNotMatch(css, /resource\(|-unity-/);
});

test("the share card's token values are the ones the synced sheet resolves to, tiers included", () => {
  const card = JSON.parse(readFileSync(OUTPUTS.cardTokens, "utf8"));
  assert.deepEqual(card, buildCardTokens(readFileSync(OUTPUTS.tokens, "utf8")));
  assert.equal(card.tiers.standard.bg, "rgb(34, 36, 40)");
  assert.equal(card.tokens["accent-orange"], "rgb(255, 153, 0)");
});
