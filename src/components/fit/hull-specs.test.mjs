// The hull specs panel from the engine's recorded sections: every section and row, in the engine's order
// and words, with headline values and help.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FIXTURES } from "../../lib/engine/stub-engine.mjs";
import { HullSpecs } from "./hull-specs.tsx";

test("every section and row of the recorded fit, in order, with the engine's text and units", () => {
  const { sections } = FIXTURES.evaluateValid;
  const html = renderToStaticMarkup(h(HullSpecs, { sections }));
  const titles = [...html.matchAll(/<span class="specs__title">([^<]*)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(titles, sections.map((section) => section.label));
  const rows = [...html.matchAll(/data-spec="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(rows, sections.flatMap((section) => section.rows.map((row) => row.id)));
  for (const row of sections.flatMap((section) => section.rows)) {
    const shown = row.secondary ?? row.primary;
    assert.ok(html.includes(`>${shown.text}</span>${shown.unit ? `<span class="specs__unit">${shown.unit}</span>` : ""}`), row.id);
  }
  // Headlines: defense repeats effective health; utility has none.
  const defense = sections.find((section) => section.id === "defense");
  const ehp = defense.rows.find((row) => row.id === "effective-health").primary;
  assert.ok(html.includes(`<span class="specs__title">DEFENSE</span><span class="specs__summary"><span class="specs__value ">${ehp.text}</span>`));
  assert.match(html, /<span class="specs__title">UTILITY<\/span><\/header>/);
});

test("a guided weapon's section leads with its first row; a row without help has no bubble", () => {
  const row = (id, text, help = { title: "", text: "" }) => ({ id, label: id.toUpperCase(), primary: { text, unit: "", number: null }, secondary: null, primaryTone: "Neutral", secondaryTone: "Neutral", help });
  const sections = [{ id: "guided-weapon-123", label: "HELLFIRE RACK", rows: [row("volley-damage", "120"), row("range", "4")] }];
  const html = renderToStaticMarkup(h(HullSpecs, { sections }));
  assert.match(html, /<span class="specs__title">HELLFIRE RACK<\/span><span class="specs__summary"><span class="specs__value ">120<\/span>/);
  assert.doesNotMatch(html, /class="tip specs__tip"/);
  assert.equal(renderToStaticMarkup(h(HullSpecs, { sections: [] })), '<div class="specs" aria-label="Hull specs"></div>');
});
