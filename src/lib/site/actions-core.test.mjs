import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { SIGN_IN_UNAVAILABLE_MESSAGE } from "../auth-errors.ts";
import { createAuth } from "../auth-core.ts";
import { createEngineClient } from "../engine/client.ts";
import { deadEngineUrl, FIXTURES, startStubEngine } from "../engine/stub-engine.mjs";
import { ANONYMOUS, getFit, listComments, listOpenReports } from "../fits/queries.ts";
import { createTestDb } from "../fits/test-db.mjs";
import { addComment, copyFitString, editComment, moderate, report, resolveReport, vote, DATABASE_DOWN_MESSAGE } from "./actions-core.ts";
import { ADMIN, ALICE, BOB, seedSite } from "./seed.mjs";

let db;
let ids;
let stub;
let dead;
before(async () => {
  db = await createTestDb();
  stub = await startStubEngine();
  dead = createEngineClient({ baseUrl: await deadEngineUrl() });
});
after(async () => {
  await stub.close();
  await db.close();
});
beforeEach(async () => {
  await db.exec("TRUNCATE fits, fit_reports CASCADE");
  ids = await seedSite(db);
});

const profiles = { [ALICE.userId]: ALICE, [BOB.userId]: BOB, [ADMIN.userId]: ADMIN };
function authAs(userId, { enabled = true } = {}) {
  return createAuth(
    { authEnabled: enabled, adminUserIds: [ADMIN.userId] },
    {
      sessionUserId: async () => userId,
      profile: async (id) => (profiles[id] ? { username: profiles[id].name, firstName: null, lastName: null, publicMetadata: {} } : null),
    },
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

test("anyone can copy a visible fit's string; the engine being down is a clear refusal", async () => {
  const anonymous = deps(authAs(null, { enabled: false }));
  assert.deepEqual(await copyFitString(anonymous, { fitId: ids.showcase, viewer: ANONYMOUS }), { ok: true, fitString: FIXTURES.exported.fitString });
  assert.equal((await copyFitString(anonymous, { fitId: ids.draft, viewer: ANONYMOUS })).status, 404, "a draft is its author's");
  const down = await copyFitString(deps(authAs(null), { engine: dead }), { fitId: ids.showcase, viewer: ANONYMOUS });
  assert.equal(down.status, 503);
  assert.match(down.message, /can't be reached/);
});
