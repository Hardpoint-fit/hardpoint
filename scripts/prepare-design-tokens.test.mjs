import assert from "node:assert/strict";
import test from "node:test";
import { buildTokensCss, ussTokensToCss } from "./prepare-design-tokens.mjs";

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

test("the share card's token values resolve from the sheets, tiers included", async () => {
  const { buildCardTokens } = await import("./prepare-design-tokens.mjs");
  const card = buildCardTokens();
  assert.equal(card.tiers.standard.bg, "rgb(34, 36, 40)");
  assert.equal(card.tokens["accent-orange"], "rgb(255, 153, 0)");
});
