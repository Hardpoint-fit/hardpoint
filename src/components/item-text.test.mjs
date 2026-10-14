// Icons, descriptions and fact rows as the pages render them, including the cases Review Focus #1 and #3
// name: an item with no art, and a description with odd characters and line breaks.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FIXTURES } from "../lib/engine/stub-engine.mjs";
import { FittingGrid } from "./grid/fitting-grid.tsx";
import { buildGridModel, catalogLookups } from "./grid/model.ts";
import { ItemTip } from "./builder/palette.tsx";
import { FactRows, ItemDescription, ItemIcon } from "./item-text.tsx";
import { PublicConfigProvider } from "../lib/public-config.tsx";

const render = (element) => renderToStaticMarkup(element);

test("an icon carries both sizes; no art draws the placeholder, never a broken image", () => {
  const html = render(h(ItemIcon, { src: "/art/abc.webp", size: 36 }));
  assert.match(html, /src="\/art\/abc\.webp"/);
  assert.match(html, /srcSet="\/art\/abc\.webp 1x, \/art\/abc@2x\.webp 2x"/);
  const none = render(h(ItemIcon, { src: null, size: 36 }));
  assert.doesNotMatch(none, /<img/);
  assert.match(none, /class="item-icon item-icon--none"/);
  assert.match(none, />\?</);
});

test("a description is plain text: markup is escaped, line breaks and odd characters kept (Review Focus #3)", () => {
  const text = 'LINE ONE\nLINE TWO <script>alert("x")</script> & ∞ → °/S² "QUOTED" ‮RTL';
  const html = render(h(ItemDescription, { text }));
  assert.equal(html.match(/<p class="item-desc">/g).length, 1);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /LINE ONE\nLINE TWO/, "the break is kept; CSS shows it (white-space: pre-line)");
  assert.match(html, /∞ → °\/S²/);
  assert.equal(render(h(ItemDescription, { text: null })), "");
  const long = render(h(ItemDescription, { text: "X".repeat(5000) }));
  assert.equal(long.length, '<p class="item-desc"></p>'.length + 5000);
});

test("fact rows show label, value and unit with the engine's tone", () => {
  const html = render(h(FactRows, { facts: FIXTURES.catalog.items.find((item) => item.name === "AUTO VENTING").facts, note: "STANDARD ROLL" }));
  assert.match(html, /<div class="facts__note">STANDARD ROLL<\/div>/);
  assert.match(html, /<span class="facts__label">HEAT DISSIPATION<\/span><span class="facts__value-group"><span class="facts__value positive">\+1,200%<\/span><\/span>/);
  assert.match(html, /<span class="facts__value ">3<\/span><span class="facts__unit">S<\/span>/);
  assert.match(html, /<span class="facts__value negative">-50%<\/span>/);
  assert.equal(render(h(FactRows, { facts: [] })), "");
});

test("the palette tooltip shows the item's art, description and plainest-roll facts", () => {
  const item = FIXTURES.catalog.items.find((each) => each.name === "ARMOR HARDENER");
  const html = render(h(ItemTip, { item }));
  assert.match(html, /class="item-icon" src="https:\/\/api\.example\.test\/v1\/art\/[0-9a-f]{32}\.[0-9a-f]{16}\.webp"/);
  assert.match(html, /BOOSTS YOUR ARMOR&#x27;S KINETIC AND EXPLOSIVE RESISTANCE WHILE ACTIVE\./);
  assert.equal(html.split('class="facts__row"').length - 1, item.facts.length);
});

test("a module with no art at all keeps its footprint and name, and the grid still draws (Review Focus #1)", () => {
  const catalog = structuredClone(FIXTURES.catalog);
  const coolant = catalog.items.find((item) => item.name === "COOLANT RESERVOIR");
  coolant.art = null;
  coolant.name = "NO ART HERE";
  const hull = catalog.hulls.find((each) => each.def === FIXTURES.fit.hull.def);
  const model = buildGridModel({ hull, ...catalogLookups(catalog) }, FIXTURES.fit);
  const bare = model.modules.find((module) => module.name === "NO ART HERE");
  assert.equal(bare.icon, null);
  const config = { apiUrl: null, authEnabled: false };
  const html = render(h(PublicConfigProvider, { config }, h(FittingGrid, { model })));
  assert.equal(html.split('data-module="').length - 1, FIXTURES.fit.modules.length);
  const start = html.indexOf(`data-module="${bare.index}"`);
  const own = html.slice(html.lastIndexOf("<div", start), html.indexOf(`data-module="${bare.index + 1}"`));
  assert.match(own, /fg-module--no-art/);
  assert.doesNotMatch(own.slice(0, own.indexOf('class="tip"')), /fg-module__icon/, "no image in the footprint");
  assert.match(own, /<span class="fg-module__label "[^>]*>NO ART HERE<\/span>/, "the name stands in for the art");
  assert.match(own, /item-icon item-icon--none/, "the tooltip's placeholder");
});

test("a grid module shows its artifact's icon, and a cipher cell its cipher's, from the catalog's art", () => {
  const catalog = FIXTURES.catalog;
  const bane = catalog.artifacts.find((artifact) => artifact.art);
  const fit = structuredClone(FIXTURES.fitShowcase);
  const module = fit.modules.find((each) => catalog.items.some((item) => item.def === each.item.def && item.category === "Module"));
  Object.assign(module.item.roll, { rarity: "Artifact", artifact: bane.def, isIdentified: true });
  const hull = catalog.hulls.find((each) => each.def === fit.hull.def);
  const model = buildGridModel({ hull, ...catalogLookups(catalog) }, fit);
  assert.equal(model.modules[fit.modules.indexOf(module)].icon, bane.art.base, `${bane.name} shows its own icon`);
  const ciphers = model.modules.flatMap((each) => each.ciphers);
  assert.ok(ciphers.length > 0, "the showcase fit holds a cipher");
  const art = new Map(catalog.ciphers.map((cipher) => [cipher.name, cipher.art.base]));
  for (const cipher of ciphers) assert.equal(cipher.icon, art.get(cipher.name), cipher.name);
});
