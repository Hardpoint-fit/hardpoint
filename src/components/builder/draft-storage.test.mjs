// The autosave slot: versioned key, round trip, and anything unreadable dropped rather than thrown.
import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURES } from "../../lib/engine/stub-engine.mjs";
import { DRAFT_VERSION, clearDraft, draftKey, readDraft, writeDraft } from "./draft-storage.ts";

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const meta = { title: "Brawler", description: "", tags: ["pvp"] };

test("a draft round-trips under a versioned key per fit", () => {
  const storage = memoryStorage();
  assert.equal(draftKey(null), `citadel-fits:builder-draft:v${DRAFT_VERSION}:new`);
  assert.equal(draftKey("AbC123xyz0"), `citadel-fits:builder-draft:v${DRAFT_VERSION}:AbC123xyz0`);
  assert.equal(writeDraft(storage, null, { fit: FIXTURES.fit, meta, base: null }, new Date("2026-10-13T00:00:00Z")), true);
  const draft = readDraft(storage, null);
  assert.deepEqual(draft, { fit: FIXTURES.fit, meta, savedAt: "2026-10-13T00:00:00.000Z", base: null });
  assert.equal(readDraft(storage, "other"), null);
  clearDraft(storage, null);
  assert.equal(readDraft(storage, null), null);
});

test("corrupt, old-format or half-shaped drafts are dropped", () => {
  const storage = memoryStorage();
  const key = draftKey(null);
  for (const text of [
    "{not json",
    JSON.stringify({ version: 0, fit: FIXTURES.fit, meta, savedAt: "x" }),
    JSON.stringify({ version: DRAFT_VERSION, fit: { hull: {} }, meta, savedAt: "x" }),
    JSON.stringify({ version: DRAFT_VERSION, fit: { ...FIXTURES.fit, progression: null }, meta, savedAt: "x" }),
    JSON.stringify({ version: DRAFT_VERSION, fit: FIXTURES.fit, meta: { title: 3 }, savedAt: "x" }),
    "null",
  ]) {
    storage.setItem(key, text);
    assert.equal(readDraft(storage, null), null, text.slice(0, 40));
    assert.equal(storage.getItem(key), null, "removed");
  }
});

test("a storage that throws (blocked, full) reads as empty and refuses writes quietly", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readDraft(broken, null), null);
  assert.equal(writeDraft(broken, null, { fit: FIXTURES.fit, meta, base: null }), false);
  clearDraft(broken, null);
  assert.equal(readDraft(null, null), null);
});
