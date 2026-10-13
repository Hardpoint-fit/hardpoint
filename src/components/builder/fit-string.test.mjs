// Review Focus #1: a fit string pasted from chat, wrapped across lines with trailing spaces, imports.
import assert from "node:assert/strict";
import test from "node:test";
import { createEngineClient } from "../../lib/engine/client.ts";
import { FIXTURES, startStubEngine } from "../../lib/engine/stub-engine.mjs";
import { normalizeFitString } from "./fit-string.ts";
import { indexCatalog } from "./rules.ts";
import { initialState, reduce } from "./state.ts";

/** The exported string as chat shows it: 64-character lines, CRLF, trailing spaces, an indent. */
function wrapped(text) {
  const lines = [];
  for (let i = 0; i < text.length; i += 64) lines.push(text.slice(i, i + 64));
  return `  ${lines.join("  \r\n\t")}  \n`;
}

test("wrapping, tabs and trailing spaces are dropped; nothing else changes", () => {
  const { fitString } = FIXTURES.exported;
  assert.notEqual(wrapped(fitString), fitString);
  assert.equal(normalizeFitString(wrapped(fitString)), fitString);
  assert.equal(normalizeFitString("CFIT1.ab cd ef"), "CFIT1.abcdef", "a non-breaking space too");
});

test("a wrapped fit string imports through the engine and loads into the builder", async () => {
  const stub = await startStubEngine();
  try {
    const client = createEngineClient({ baseUrl: stub.url });
    const result = await client.importFitString(normalizeFitString(wrapped(FIXTURES.exported.fitString)));
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.fit, FIXTURES.imported.fit);
    const cat = indexCatalog(FIXTURES.catalog);
    const state = reduce(cat, initialState(), { type: "load", fit: result.value.fit });
    assert.equal(state.fit.modules.length, FIXTURES.imported.fit.modules.length);
    const bad = await client.importFitString(normalizeFitString("not a fit string"));
    assert.equal(bad.ok, false);
    assert.equal(bad.error.kind, "rejected", "the engine's message is shown");
  } finally {
    await stub.close();
  }
});
