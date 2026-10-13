// The autosave slot: versioned key, round trip, and anything unreadable dropped rather than thrown.
import assert from "node:assert/strict";
import test from "node:test";
import { FIXTURES } from "../../lib/engine/stub-engine.mjs";
import { DRAFT_VERSION, autosave, bootDraft, clearDraft, draftKey, draftSlot, readDraft, writeDraft } from "./draft-storage.ts";

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
const EMPTY = { title: "", description: "", tags: [] };
const withModule0 = (edit) => ({ ...FIXTURES.fit, modules: FIXTURES.fit.modules.map((m, i) => (i === 0 ? { ...m, item: { ...m.item, roll: edit(m.item.roll) } } : m)) });

test("a draft round-trips under a versioned key per fit", () => {
  const storage = memoryStorage();
  assert.equal(draftKey(draftSlot(null)), `citadel-fits:builder-draft:v${DRAFT_VERSION}:new`);
  assert.equal(draftKey(draftSlot("AbC123xyz0")), `citadel-fits:builder-draft:v${DRAFT_VERSION}:AbC123xyz0`);
  assert.equal(draftSlot(null, "Src1234567"), "copy-Src1234567");
  assert.equal(writeDraft(storage, "new", { fit: FIXTURES.fit, meta, base: null }, new Date("2026-10-13T00:00:00Z")), true);
  const draft = readDraft(storage, "new");
  assert.deepEqual(draft, { fit: FIXTURES.fit, meta, savedAt: "2026-10-13T00:00:00.000Z", base: null });
  assert.equal(readDraft(storage, "other"), null);
  clearDraft(storage, "new");
  assert.equal(readDraft(storage, "new"), null);
});

test("corrupt, old-format or half-shaped drafts are dropped", () => {
  const storage = memoryStorage();
  const key = draftKey("new");
  for (const text of [
    "{not json",
    JSON.stringify({ version: 0, fit: FIXTURES.fit, meta, savedAt: "x" }),
    JSON.stringify({ version: DRAFT_VERSION, fit: { hull: {} }, meta, savedAt: "x" }),
    JSON.stringify({ version: DRAFT_VERSION, fit: { ...FIXTURES.fit, progression: null }, meta, savedAt: "x" }),
    JSON.stringify({ version: DRAFT_VERSION, fit: FIXTURES.fit, meta: { title: 3 }, savedAt: "x" }),
    "null",
    // Shapes inside the fit: a modifier without its value, a port without its direction, a hull roll missing a flag.
    JSON.stringify({ version: DRAFT_VERSION, fit: withModule0((roll) => ({ ...roll, modifiers: [{ stat: "MaxHull" }] })), meta, savedAt: "x" }),
    JSON.stringify({ version: DRAFT_VERSION, fit: withModule0((roll) => ({ ...roll, ports: [{ row: 2, col: 2 }] })), meta, savedAt: "x" }),
    JSON.stringify({ version: DRAFT_VERSION, fit: { ...FIXTURES.fit, hull: { ...FIXTURES.fit.hull, roll: { ...FIXTURES.fit.hull.roll, isMirrored: "no" } } }, meta, savedAt: "x" }),
    JSON.stringify({ version: DRAFT_VERSION, fit: { ...FIXTURES.fit, slotOverrides: [{ cell: "0" }] }, meta, savedAt: "x" }),
  ]) {
    storage.setItem(key, text);
    assert.equal(readDraft(storage, "new"), null, text.slice(0, 40));
    assert.equal(storage.getItem(key), null, "removed");
  }
});

test("a storage that throws (blocked, full) reads as empty and refuses writes quietly", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readDraft(broken, "new"), null);
  assert.equal(writeDraft(broken, "new", { fit: FIXTURES.fit, meta, base: null }), false);
  clearDraft(broken, "new");
  assert.equal(readDraft(null, "new"), null);
});

test("opening a copy never touches an unsaved new fit: it autosaves to its own slot, and only once edited", () => {
  const storage = memoryStorage();
  const mine = { ...FIXTURES.fit, progression: { ...FIXTURES.fit.progression, affinityXp: 458 } };
  writeDraft(storage, "new", { fit: mine, meta, base: null });
  const start = { fitId: null, copiedFrom: { id: "Src1234567" }, updatedAt: null };
  assert.equal(bootDraft(storage, start), null, "the copy starts from the server's fit, not the new slot");
  const slot = draftSlot(null, "Src1234567");
  autosave(storage, slot, { fit: FIXTURES.fitShowcase, meta: EMPTY, dirty: false, base: null });
  assert.equal(readDraft(storage, slot), null, "an unedited copy isn't saved");
  autosave(storage, slot, { fit: FIXTURES.fitShowcase, meta: EMPTY, dirty: true, base: null });
  assert.deepEqual(readDraft(storage, "new").fit, mine, "the new fit's draft is still there");
  assert.deepEqual(readDraft(storage, slot).fit, FIXTURES.fitShowcase);
  assert.deepEqual(bootDraft(storage, start).fit, FIXTURES.fitShowcase, "reopening the copy restores its edits");
  assert.deepEqual(bootDraft(storage, { fitId: null, copiedFrom: null, updatedAt: null }).fit, mine);
});

test("an edit's draft is restored only over the saved version it was made on", () => {
  const storage = memoryStorage();
  writeDraft(storage, "Fit1234567", { fit: FIXTURES.fit, meta, base: "2026-10-13T10:00:00Z" });
  assert.ok(bootDraft(storage, { fitId: "Fit1234567", copiedFrom: null, updatedAt: "2026-10-13T10:00:00Z" }));
  assert.equal(bootDraft(storage, { fitId: "Fit1234567", copiedFrom: null, updatedAt: "2026-10-13T11:00:00Z" }), null);
});

test("every recorded engine fit is editable", async () => {
  const { isEditableFit } = await import("../../lib/engine/open-fit.ts");
  for (const fit of [FIXTURES.fit, FIXTURES.fitShowcase, FIXTURES.fitRemovedItem, FIXTURES.imported.fit]) assert.equal(isEditableFit(fit), true);
});
