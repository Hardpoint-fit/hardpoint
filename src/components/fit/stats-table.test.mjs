// The MODIFIERS list: the engine's modifier groups, one row per stat with its stages combined, each row's
// sources in the tooltip; and the per-stage list a verdict stored before the groups falls back to.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FIXTURES } from "../../lib/engine/stub-engine.mjs";
import { Modifiers, StatsTable } from "./stats-table.tsx";

const line = { kind: "Module", asset: FIXTURES.catalog.items[0].def, affinityType: "None", raw: 0.2, ratio: 0.81, effective: 0.162, isStackingExempt: false };
const cipher = { kind: "Cipher", asset: FIXTURES.catalog.ciphers[0].def, raw: 0.05 };
// A module whose own stat and cipher stack as one source, the parts under it.
const module = { ...line, parts: [{ kind: "Module", asset: line.asset, raw: 0.15 }, cipher] };
const affinity = { kind: "AffinityClass", asset: null, affinityType: "Propulsion", raw: 0.021, ratio: 1, effective: 0.021, isStackingExempt: true, parts: [] };
// What the engine sends for MAX VELOCITY from a module and from an affinity: two stage lines in `stats`,
// one row in `modifierGroups` with (1 + 0.162)(1 + 0.021) - 1 and both sources.
const stats = [
  { stat: "MaxSpeed", stage: "Fitted", operation: "Multiply", total: 0.162, sources: [line] },
  { stat: "MaxSpeed", stage: "Affinity", operation: "Multiply", total: 0.021, sources: [{ ...affinity, parts: undefined }] },
];
const groups = [
  {
    category: "Agility",
    label: "AGILITY",
    rows: [{ stat: "MaxSpeed", label: "MAX VELOCITY", operation: "Multiply", total: 0.186402, sources: [module, affinity] }],
  },
];

const count = (html, text) => html.split(text).length - 1;

test("a stat that modules and an affinity both change is one row with both sources", () => {
  const html = renderToStaticMarkup(h(Modifiers, { groups, stats, catalog: FIXTURES.catalog }));
  assert.equal(count(html, 'class="stats__row'), 1);
  assert.match(html, /<span class="stats-group__title">AGILITY<\/span><span class="stats-group__count">1<\/span>/);
  assert.match(html, /<span class="stats__label">MAX VELOCITY<\/span><span class="stats__value tone-positive">\+18\.6%<\/span>/);
  assert.match(html, />2 SOURCES</);
  assert.match(html, new RegExp(FIXTURES.catalog.items[0].name.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /AGILITY AFFINITY/);
  assert.match(html, /\+16\.2%/);
  assert.match(html, /\+2\.1%/);
});

test("a module's stacked lines are listed under it, each at its raw value", () => {
  const html = renderToStaticMarkup(h(Modifiers, { groups, stats, catalog: FIXTURES.catalog }));
  assert.equal(count(html, "plate__row--part"), 2);
  const parts = html.slice(html.indexOf("plate__row--part"));
  assert.match(parts, /\+15%/);
  assert.match(parts, new RegExp(`${FIXTURES.catalog.ciphers[0].name.toUpperCase()}<span class="tone-neutral"> · CIPHER`));
  assert.match(parts, /\+5%/);
  assert.ok(html.indexOf("plate__row--part") < html.indexOf("AGILITY AFFINITY"), "under the module, before the next source");
});

test("categories keep the engine's order, each under its header", () => {
  const two = [{ category: "Defense", label: "DEFENSE", rows: [{ ...groups[0].rows[0], stat: "MaxArmor", label: "MAX ARMOR" }] }, ...groups];
  const html = renderToStaticMarkup(h(Modifiers, { groups: two, stats, catalog: null }));
  assert.ok(html.indexOf("DEFENSE") < html.indexOf("AGILITY"));
  assert.equal(count(html, 'class="stats-group"'), 2);
});

test("without groups (a verdict stored before them) the stats are listed a line per stage", () => {
  const html = renderToStaticMarkup(h(Modifiers, { groups: null, stats, catalog: FIXTURES.catalog }));
  assert.equal(html, renderToStaticMarkup(h(StatsTable, { stats, catalog: FIXTURES.catalog })));
  assert.equal(count(html, 'class="stats__row'), 2);
  assert.doesNotMatch(html, /stats-group/);
});

test("a fit that changes nothing says so", () => {
  assert.equal(renderToStaticMarkup(h(Modifiers, { groups: [], stats: [], catalog: null })), '<p class="note">NO STAT CHANGES.</p>');
});
