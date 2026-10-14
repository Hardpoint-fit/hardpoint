import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { SIGN_IN_UNAVAILABLE_MESSAGE } from "../auth-errors.ts";
import { createAuth } from "../auth-core.ts";
import { createEngineClient } from "../engine/client.ts";
import { startStubEngine } from "../engine/stub-engine.mjs";
import { getFit, listComments, listOpenReports } from "../fits/queries.ts";
import { createTestDb } from "../fits/test-db.mjs";
import { addComment, deleteComment, deleteFit, editComment, unpublishFit, moderate, report, resolveReport, vote, DATABASE_DOWN_MESSAGE } from "./actions-core.ts";
import { WRITE_BUDGETS } from "../fits/write-limits.ts";
import { ADMIN, ALICE, BOB, seedSite } from "./seed.mjs";

let db;
let ids;
let stub;
before(async () => {
  db = await createTestDb();
  stub = await startStubEngine();
});
after(async () => {
  await stub.close();
  await db.close();
});
beforeEach(async () => {
  await db.exec("TRUNCATE fits, fit_reports, write_budget_windows CASCADE");
  ids = await seedSite(db);
});

const profiles = { [ALICE.userId]: ALICE, [BOB.userId]: BOB, [ADMIN.userId]: ADMIN };
function authAs(userId, { enabled = true } = {}) {
  return createAuth(
    { authEnabled: enabled, adminUserIds: [ADMIN.userId] },
    { session: async () => (userId ? { userId, name: profiles[userId]?.name ?? "PILOT", isAdminRole: false } : null) },
  );
}
const deps = (auth, { database = { status: "ready", db }, engine = createEngineClient({ baseUrl: stub.url }) } = {}) => ({
  database: () => database,
  auth,
  engine,
});

test("with sign-in not configured every write refuses with 503 and writes nothing", async () => {
  const off = deps(authAs(BOB.userId, { enabled: false }));
  const results = [
    await vote(off, { fitId: ids.pending, voted: true }),
    await addComment(off, { fitId: ids.showcase, parentId: null, body: "hi" }),
    await editComment(off, { id: ids.comment, body: "edited" }),
    await report(off, { targetKind: "fit", targetId: ids.showcase, reason: "bad" }),
    await moderate(off, { targetKind: "fit", targetId: ids.showcase, hidden: true }),
    await resolveReport(off, { reportId: ids.fitReport }),
  ];
  for (const result of results) {
    assert.deepEqual(result, { ok: false, reason: "auth_unavailable", status: 503, message: SIGN_IN_UNAVAILABLE_MESSAGE });
  }
  assert.equal((await getFit(db, ids.pending)).votes, 0);
  assert.equal((await listComments(db, ids.showcase))[0].body.includes("edited"), false);
  assert.equal((await getFit(db, ids.showcase)).status, "published");
});

test("signed out is 401, and moderation by a non-admin is 403", async () => {
  assert.equal((await vote(deps(authAs(null)), { fitId: ids.showcase, voted: true })).status, 401);
  assert.equal((await moderate(deps(authAs(BOB.userId)), { targetKind: "fit", targetId: ids.showcase, hidden: true })).status, 403);
  assert.equal((await resolveReport(deps(authAs(BOB.userId)), { reportId: ids.fitReport })).status, 403);
});

test("a signed-in pilot votes once however often they ask", async () => {
  const bob = deps(authAs(BOB.userId));
  assert.deepEqual(await vote(bob, { fitId: ids.pending, voted: true }), { ok: true, voted: true, votes: 1 });
  assert.deepEqual(await vote(bob, { fitId: ids.pending, voted: true }), { ok: true, voted: true, votes: 1 });
  assert.deepEqual(await vote(bob, { fitId: ids.pending, voted: false }), { ok: true, voted: false, votes: 0 });
  const missing = await vote(bob, { fitId: "nosuchfit0", voted: true });
  assert.equal(missing.status, 404);
});

test("comments and replies are written under the signed-in author's name; edits only by the author", async () => {
  const bob = deps(authAs(BOB.userId));
  const top = await addComment(bob, { fitId: ids.pending, parentId: null, body: "First" });
  assert.equal(top.ok, true);
  assert.equal(top.comment.authorName, "BOB");
  const reply = await addComment(deps(authAs(ALICE.userId)), { fitId: ids.pending, parentId: top.comment.id, body: "Reply" });
  assert.equal(reply.ok, true);
  const nested = await addComment(bob, { fitId: ids.pending, parentId: reply.comment.id, body: "Too deep" });
  assert.equal(nested.status, 400, "one level of replies");
  assert.equal((await editComment(bob, { id: top.comment.id, body: "First, edited" })).ok, true);
  assert.equal((await editComment(bob, { id: reply.comment.id, body: "Not mine" })).status, 403);
  const empty = await addComment(bob, { fitId: ids.pending, parentId: null, body: "   " });
  assert.equal(empty.status, 400);
  assert.equal(typeof empty.message, "string");
});

test("a report is filed once per pilot and target", async () => {
  const bob = deps(authAs(BOB.userId));
  assert.deepEqual(await report(bob, { targetKind: "fit", targetId: ids.showcase, reason: "Copied" }), { ok: true, created: true });
  assert.deepEqual(await report(bob, { targetKind: "fit", targetId: ids.showcase, reason: "Copied again" }), { ok: true, created: false });
});

test("an admin hides what was reported, which closes its reports, and resolves the rest", async () => {
  const admin = deps(authAs(ADMIN.userId));
  assert.deepEqual(await moderate(admin, { targetKind: "comment", targetId: ids.reply, hidden: true }), { ok: true, changed: true, resolved: 1 });
  assert.deepEqual(await resolveReport(admin, { reportId: ids.fitReport }), { ok: true, resolved: true });
  assert.deepEqual((await listOpenReports(db)).reports, []);
  assert.deepEqual(await moderate(admin, { targetKind: "fit", targetId: ids.showcase, hidden: true }), { ok: true, changed: true, resolved: 0 });
  assert.equal(await getFit(db, ids.showcase), null, "hidden from the public");
  assert.deepEqual(await moderate(admin, { targetKind: "fit", targetId: ids.showcase, hidden: false }), { ok: true, changed: true, resolved: 0 });
});

test("without a database a write is a 503 refusal", async () => {
  const result = await vote(deps(authAs(BOB.userId), { database: { status: "unavailable" } }), { fitId: ids.showcase, voted: true });
  assert.deepEqual(result, { ok: false, reason: "unavailable", status: 503, message: DATABASE_DOWN_MESSAGE });
});

test("a pilot's writes are rate-limited per user, with a typed 429 the controls show", async () => {
  let now = new Date("2026-10-14T12:00:05Z");
  const clocked = (userId) => ({ ...deps(authAs(userId)), now: () => now });
  const bob = clocked(BOB.userId);
  for (let i = 0; i < WRITE_BUDGETS.vote[0].limit; i++) {
    assert.equal((await vote(bob, { fitId: ids.pending, voted: i % 2 === 0 })).ok, true);
  }
  const limited = await vote(bob, { fitId: ids.pending, voted: true });
  assert.deepEqual(limited, {
    ok: false,
    reason: "rate_limited",
    status: 429,
    message: "SLOW DOWN — TRY AGAIN IN 55 SECONDS.",
    retryAfterMs: 55_000,
  });
  assert.equal((await getFit(db, ids.pending)).votes, 0, "the refused vote wrote nothing");
  assert.equal((await vote(clocked(ALICE.userId), { fitId: ids.pending, voted: true })).ok, true, "budgets are per user");
  assert.equal((await addComment(bob, { fitId: ids.showcase, parentId: null, body: "other budget" })).ok, true, "budgets are per action");
  assert.equal((await moderate(clocked(ADMIN.userId), { targetKind: "fit", targetId: ids.showcase, hidden: false })).ok, true);
  now = new Date("2026-10-14T12:01:00Z");
  assert.equal((await vote(bob, { fitId: ids.pending, voted: true })).ok, true, "a new window allows it again");
});

test("comments and reports have their own budgets", async () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const bob = { ...deps(authAs(BOB.userId)), now: () => now };
  for (let i = 0; i < 10; i++) assert.equal((await addComment(bob, { fitId: ids.showcase, parentId: null, body: `c${i}` })).ok, true);
  assert.equal((await editComment(bob, { id: ids.comment, body: "edit" })).status, 429, "edits spend the comment budget");
  assert.equal((await report(bob, { targetKind: "fit", targetId: ids.showcase, reason: "spam" })).ok, true);
});


test("delete and unpublish refuse without sign-in or a database, and spend the fit and comment budgets", async () => {
  const off = deps(authAs(ALICE.userId, { enabled: false }));
  for (const result of [await deleteFit(off, { fitId: ids.showcase }), await unpublishFit(off, { fitId: ids.showcase }), await deleteComment(off, { id: ids.comment })]) {
    assert.equal(result.status, 503);
  }
  assert.equal((await deleteFit(deps(authAs(null)), { fitId: ids.showcase })).status, 401);
  assert.equal((await deleteFit(deps(authAs(ALICE.userId), { database: { status: "unavailable" } }), { fitId: ids.showcase })).status, 503);
  assert.ok(await getFit(db, ids.showcase));

  const now = new Date("2026-10-14T12:00:00Z");
  const alice = { ...deps(authAs(ALICE.userId)), now: () => now };
  for (let i = 0; i < WRITE_BUDGETS.fit[0].limit; i++) await unpublishFit(alice, { fitId: ids.draft });
  const limited = await deleteFit(alice, { fitId: ids.draft });
  assert.equal(limited.status, 429);
  assert.ok(await getFit(db, ids.draft, { viewer: { userId: ALICE.userId, isAdmin: false } }), "the refused delete wrote nothing");
});

test("a pilot can delete and unpublish only their own fit; a forged id changes nothing", async () => {
  const bob = deps(authAs(BOB.userId));
  assert.equal((await deleteFit(bob, { fitId: ids.showcase })).status, 404);
  assert.equal((await unpublishFit(bob, { fitId: ids.showcase })).status, 404);
  assert.equal((await getFit(db, ids.showcase)).status, "published");
  const alice = deps(authAs(ALICE.userId));
  assert.deepEqual(await unpublishFit(alice, { fitId: ids.showcase }), { ok: true, fitId: ids.showcase });
  assert.equal(await getFit(db, ids.showcase), null, "now a draft, so private");
  assert.equal((await unpublishFit(alice, { fitId: ids.showcase })).status, 404);
  assert.deepEqual(await deleteFit(alice, { fitId: ids.showcase }), { ok: true, fitId: ids.showcase });
  assert.equal((await deleteFit(alice, { fitId: ids.showcase })).status, 404);
  assert.deepEqual((await listOpenReports(db)).reports.filter((r) => r.target?.fitId === ids.showcase), []);
});

test("deleting a comment is the author's alone and spends the comment budget", async () => {
  const alice = deps(authAs(ALICE.userId));
  const bob = deps(authAs(BOB.userId));
  assert.equal((await deleteComment(alice, { id: ids.comment })).status, 404, "BOB's comment is not ALICE's");
  assert.deepEqual(await deleteComment(bob, { id: ids.comment }), { ok: true, deletion: "tombstoned" });
  assert.equal((await editComment(bob, { id: ids.comment, body: "revive" })).status, 403);
  assert.deepEqual(await deleteComment(alice, { id: ids.reply }), { ok: true, deletion: "removed" });
  assert.equal((await deleteComment(bob, { id: "9999999" })).status, 404);
  const now = new Date("2026-10-14T12:00:00Z");
  const clocked = { ...deps(authAs(BOB.userId)), now: () => now };
  for (let i = 0; i < 10; i++) await deleteComment(clocked, { id: "9999999" });
  assert.equal((await deleteComment(clocked, { id: "9999999" })).status, 429);
});
