import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createTestDb } from "./test-db.mjs";
import { spendWriteBudget, WRITE_BUDGETS } from "./write-limits.ts";
import { slowDownMessage } from "../slow-down.ts";

let db;
before(async () => {
  db = await createTestDb();
});
after(() => db.close());
beforeEach(() => db.exec("TRUNCATE write_budget_windows"));

const at = (iso) => new Date(iso);
const used = async (budget) =>
  (await db.query("SELECT budget, used FROM write_budget_windows WHERE user_id = 'u1' ORDER BY budget")).rows.find((row) => row.budget === budget)?.used;

test("a window allows its limit, then refuses until it turns over", async () => {
  const now = at("2026-10-14T12:00:20Z");
  for (let i = 0; i < 10; i++) assert.deepEqual(await spendWriteBudget(db, "u1", "report", now), { ok: true });
  assert.deepEqual(await spendWriteBudget(db, "u1", "report", now), { ok: false, retryAfterMs: 3_580_000 });
  assert.deepEqual(await spendWriteBudget(db, "u2", "report", now), { ok: true }, "another user has their own budget");
  assert.deepEqual(await spendWriteBudget(db, "u1", "report", at("2026-10-14T13:00:00Z")), { ok: true });
});

test("a refusal by one window takes nothing from the others", async () => {
  const minute = at("2026-10-14T12:00:00Z");
  for (let i = 0; i < 10; i++) await spendWriteBudget(db, "u1", "comment", minute);
  assert.equal((await spendWriteBudget(db, "u1", "comment", minute)).ok, false);
  assert.equal(await used("comment/86400000"), 10, "the day window counts only the writes that happened");
});

test("the day window caps comments across minutes", async () => {
  const day = WRITE_BUDGETS.comment[1].limit;
  for (let i = 0; i < day; i++) {
    const minute = at(new Date(Date.parse("2026-10-14T00:00:00Z") + Math.floor(i / 10) * 60_000).toISOString());
    assert.equal((await spendWriteBudget(db, "u1", "comment", minute)).ok, true, `comment ${i}`);
  }
  const refused = await spendWriteBudget(db, "u1", "comment", at("2026-10-14T20:00:00Z"));
  assert.deepEqual(refused, { ok: false, retryAfterMs: 4 * 3_600_000 });
  assert.equal(slowDownMessage(refused.retryAfterMs), "SLOW DOWN — TRY AGAIN IN 4 HOURS.");
});

test("concurrent writes never pass the limit", async () => {
  const now = at("2026-10-14T12:00:00Z");
  const results = await Promise.all(Array.from({ length: 45 }, () => spendWriteBudget(db, "u1", "fit", now)));
  assert.equal(results.filter((result) => result.ok).length, WRITE_BUDGETS.fit[0].limit);
});

test("a user's ended windows are dropped when they next write", async () => {
  await spendWriteBudget(db, "u1", "vote", at("2026-10-14T12:00:00Z"));
  await spendWriteBudget(db, "u1", "vote", at("2026-10-14T12:05:00Z"));
  const { rows } = await db.query("SELECT count(*)::int AS n FROM write_budget_windows WHERE user_id = 'u1'");
  assert.equal(rows[0].n, 1);
});

test("the wait is worded in whole, rounded-up units", () => {
  assert.equal(slowDownMessage(0), "SLOW DOWN — TRY AGAIN IN 1 SECOND.");
  assert.equal(slowDownMessage(54_100), "SLOW DOWN — TRY AGAIN IN 55 SECONDS.");
  assert.equal(slowDownMessage(3_580_000), "SLOW DOWN — TRY AGAIN IN 60 MINUTES.");
});
