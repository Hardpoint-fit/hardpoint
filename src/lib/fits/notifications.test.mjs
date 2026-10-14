import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createAuth } from "../auth-core.ts";
import { createEngineClient } from "../engine/client.ts";
import { startStubEngine } from "../engine/stub-engine.mjs";
import { markAllNotificationsRead, openNotification } from "../site/actions-core.ts";
import { countUnread, listNotifications, markAllRead, openNotification as openRow } from "./notifications.ts";
import { loadNotifications, loadUnreadCount, unreadLabel } from "../site/loaders.ts";
import { setFollow } from "./pilots.ts";
import { createComment, createFit, deleteComment, deleteFit, publishFit, recordEvaluation, setCommentHidden, setFitHidden, unpublishFit, updateFit } from "./queries.ts";
import { createTestDb, sampleFit } from "./test-db.mjs";

const SHA = "build-a";
const ALICE = { userId: "user_alice", name: "alice" };
const BOB = { userId: "user_bob", name: "bob" };
const CAROL = { userId: "user_carol", name: "carol" };
const good = { buildSha: SHA, valid: true, rating: 10, stats: {}, issues: [] };

let db;
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
  await db.exec("TRUNCATE fits, fit_reports, pilots, write_budget_windows CASCADE");
});

async function draft(owner = ALICE) {
  return createFit(db, { authorUserId: owner.userId, authorName: owner.name, title: "A fit", content: sampleFit("1000"), buildSha: SHA, evaluation: good });
}
async function published(owner = ALICE) {
  const fit = await draft(owner);
  await publishFit(db, { id: fit.id, authorUserId: owner.userId, buildSha: SHA });
  return fit;
}
const say = (fitId, who, body, parentId = null) => createComment(db, { fitId, parentId, authorUserId: who.userId, authorName: who.name, body });
const inbox = async (who) => (await listNotifications(db, { userId: who.userId })).notifications;
const kinds = async (who) => (await inbox(who)).map((n) => n.kind).sort();

test("a comment tells the fit's author; a reply tells the comment's author; nobody is told of their own action", async () => {
  const fit = await published();
  const top = await say(fit.id, BOB, "nice");
  assert.deepEqual(await kinds(ALICE), ["comment"]);
  assert.deepEqual(await kinds(BOB), []);
  const own = await say(fit.id, ALICE, "thanks", null);
  assert.deepEqual(await kinds(ALICE), ["comment"], "the author's own comment tells nobody here");
  assert.deepEqual(await kinds(BOB), []);
  await say(fit.id, CAROL, "agreed", top.id);
  assert.deepEqual(await kinds(BOB), ["reply"], "bob is told of the reply to his comment");
  assert.deepEqual(await kinds(ALICE), ["comment", "comment"], "and the fit's author of a comment on their fit");
  await say(fit.id, BOB, "me again", top.id);
  assert.deepEqual(await kinds(BOB), ["reply"], "replying to yourself tells you nothing");
  // The fit's author replying to a comment of their own on their own fit: nothing for them.
  const before = (await inbox(ALICE)).length;
  await say(fit.id, ALICE, "self", own.id);
  assert.equal((await inbox(ALICE)).length, before);
  // The fit's author is also the parent's author: one notification, the reply.
  await say(fit.id, BOB, "re alice", own.id);
  const forAlice = (await inbox(ALICE)).filter((n) => n.commentId !== null);
  assert.equal(forAlice.filter((n) => n.kind === "reply").length, 1);
  assert.equal((await db.query("SELECT 1 FROM notifications WHERE user_id = $1 GROUP BY comment_id HAVING count(*) > 1", [ALICE.userId])).rows.length, 0);
});

test("publishing tells each follower once, only on the transition to published", async () => {
  const fit = await draft();
  await setFollow(db, { follower: BOB, followeeUserId: ALICE.userId, following: true });
  await setFollow(db, { follower: CAROL, followeeUserId: ALICE.userId, following: true });
  assert.deepEqual(await kinds(BOB), []);
  await publishFit(db, { id: fit.id, authorUserId: ALICE.userId, buildSha: SHA });
  assert.deepEqual(await kinds(BOB), ["follow_fit"]);
  assert.deepEqual(await kinds(CAROL), ["follow_fit"]);
  assert.deepEqual(await kinds(ALICE), []);
  const [first] = await inbox(BOB);
  assert.equal(first.actorName, "alice");
  assert.equal(first.fitTitle, "A fit");
  await publishFit(db, { id: fit.id, authorUserId: ALICE.userId, buildSha: SHA });
  await updateFit(db, { id: fit.id, authorUserId: ALICE.userId, title: "Renamed", content: sampleFit("1000"), evaluation: good });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n, 2, "re-saves and a second publish call add nothing");
});

test("hiding or unpublishing a fit, and hiding or tombstoning a comment, delete what they told", async () => {
  await draft();
  await setFollow(db, { follower: BOB, followeeUserId: ALICE.userId, following: true });
  const fit = await published();
  const top = await say(fit.id, BOB, "one");
  const reply = await say(fit.id, CAROL, "two", top.id);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n, 4);

  await setCommentHidden(db, top.id, true);
  const left = (await db.query("SELECT comment_id::text AS c, kind FROM notifications ORDER BY id")).rows;
  assert.deepEqual(left.map((r) => r.kind), ["follow_fit"], "the comment and its reply's notifications go");
  assert.ok(!left.some((r) => r.c === reply.id));

  await setCommentHidden(db, top.id, false);
  const again = await say(fit.id, CAROL, "three");
  const reply2 = await say(fit.id, BOB, "four", again.id);
  await deleteComment(db, { id: again.id, authorUserId: CAROL.userId }); // has a reply: tombstone
  const rows = (await db.query("SELECT comment_id::text AS c FROM notifications WHERE comment_id IS NOT NULL")).rows.map((r) => r.c);
  assert.ok(!rows.includes(again.id), "a tombstoned comment's notifications are gone");
  assert.ok(rows.includes(reply2.id), "its reply is still visible, so what it told stays");

  await setFitHidden(db, fit.id, true);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n, 0);
  await setFitHidden(db, fit.id, false);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n, 0, "restoring brings nothing back");

  await say(fit.id, BOB, "five");
  assert.equal((await inbox(ALICE)).length, 1);
  await unpublishFit(db, { id: fit.id, authorUserId: ALICE.userId });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n, 0);
});

test("deleting a fit or a comment cascades to its notifications", async () => {
  const fit = await published();
  const c = await say(fit.id, BOB, "x");
  await deleteComment(db, { id: c.id, authorUserId: BOB.userId });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n, 0);
  await say(fit.id, BOB, "y");
  await deleteFit(db, { id: fit.id, authorUserId: ALICE.userId });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n, 0);
});

test("reads drop notifications whose fit or comment is no longer visible even if a row was left behind", async () => {
  const fit = await published();
  const c = await say(fit.id, BOB, "x");
  assert.equal(await countUnread(db, ALICE.userId), 1);
  await db.query("UPDATE fit_comments SET hidden = true WHERE id = $1::bigint", [c.id]);
  assert.equal(await countUnread(db, ALICE.userId), 0);
  assert.deepEqual(await inbox(ALICE), []);
  await db.query("UPDATE fit_comments SET hidden = false WHERE id = $1::bigint", [c.id]);
  assert.equal((await inbox(ALICE)).length, 1);
  await db.query("UPDATE fits SET status = 'hidden' WHERE id = $1", [fit.id]);
  assert.equal(await countUnread(db, ALICE.userId), 0);
  assert.deepEqual(await inbox(ALICE), []);
  assert.equal(await openRow(db, { userId: ALICE.userId, id: "1" }), null);
});

test("a retried insert adds no second row, and the unique index treats missing comment and build as equal", async () => {
  const fit = await published();
  await say(fit.id, BOB, "x");
  const ins = `INSERT INTO notifications (user_id, kind, fit_id, comment_id, actor_user_id) SELECT user_id, kind, fit_id, comment_id, actor_user_id FROM notifications ON CONFLICT DO NOTHING`;
  await db.query(ins);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n, 1);
  const bare = `INSERT INTO notifications (user_id, kind, fit_id) VALUES ($1, 'follow_fit', $2) ON CONFLICT DO NOTHING`;
  await db.query(bare, [BOB.userId, fit.id]);
  await db.query(bare, [BOB.userId, fit.id]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1", [BOB.userId])).rows[0].n, 1);
});

test("an evaluation that turns a published fit invalid tells its author once per build", async () => {
  const fit = await published();
  const bad = (buildSha) => ({ buildSha, valid: false, rating: null, stats: {}, issues: [{ moduleIndex: 0, kind: "Slot", message: "no" }] });
  await recordEvaluation(db, fit.id, bad("build-b"));
  assert.deepEqual(await kinds(ALICE), ["fit_broken"]);
  await recordEvaluation(db, fit.id, bad("build-b"));
  assert.deepEqual(await kinds(ALICE), ["fit_broken"], "the same build again");
  await recordEvaluation(db, fit.id, bad("build-c"));
  assert.deepEqual(await kinds(ALICE), ["fit_broken"], "invalid on the build before: it did not break now");
  await recordEvaluation(db, fit.id, { ...good, buildSha: "build-d" });
  await recordEvaluation(db, fit.id, bad("build-e"));
  assert.deepEqual(await kinds(ALICE), ["fit_broken", "fit_broken"], "valid on d, invalid on e");
});

test("reads are the viewer's own and page newest first; opening and marking read touch only their rows", async () => {
  const fit = await published();
  for (let i = 0; i < 5; i++) await say(fit.id, BOB, `c${i}`);
  await say(fit.id, CAROL, "carol's");
  const first = await listNotifications(db, { userId: ALICE.userId, limit: 4 });
  assert.equal(first.notifications.length, 4);
  assert.ok(first.nextCursor);
  const second = await listNotifications(db, { userId: ALICE.userId, limit: 4, cursor: first.nextCursor });
  assert.equal(second.notifications.length, 2);
  assert.equal(second.nextCursor, null);
  const all = [...first.notifications, ...second.notifications];
  assert.equal(new Set(all.map((n) => n.id)).size, 6);
  assert.deepEqual(all.map((n) => Number(n.id)), all.map((n) => Number(n.id)).sort((a, b) => b - a));
  assert.equal(all[0].actorName, "carol");
  assert.deepEqual((await listNotifications(db, { userId: ALICE.userId, cursor: "garbage" })).notifications.length, 6);

  const target = all[2];
  assert.equal(await openRow(db, { userId: BOB.userId, id: target.id }), null, "not bob's");
  assert.equal(await countUnread(db, ALICE.userId), 6);
  assert.deepEqual(await openRow(db, { userId: ALICE.userId, id: target.id }), { fitId: fit.id, commentId: target.commentId });
  assert.equal(await countUnread(db, ALICE.userId), 5);
  assert.equal((await inbox(ALICE)).filter((n) => n.read).length, 1);
  const notBob = await markAllRead(db, BOB.userId);
  assert.equal(notBob, 0);
  assert.equal(await countUnread(db, ALICE.userId), 5, "bob's mark-all touches nothing of alice's");
  assert.equal(await markAllRead(db, ALICE.userId), 5);
  assert.equal(await countUnread(db, ALICE.userId), 0);
  assert.equal(await openRow(db, { userId: ALICE.userId, id: "abc" }), null);
});

test("the unread count stops counting past 99", async () => {
  const fit = await published();
  await db.query(
    `INSERT INTO notifications (user_id, kind, fit_id, actor_user_id, build_sha)
     SELECT $1, 'fit_broken', $2, NULL, 'b' || g FROM generate_series(1, 150) g`,
    [ALICE.userId, fit.id],
  );
  assert.equal(await countUnread(db, ALICE.userId), 100);
});

test("the actions need sign-in and only touch the signed-in pilot's rows", async () => {
  const fit = await published();
  await say(fit.id, CAROL, "x");
  const id = (await inbox(ALICE))[0].id;
  const authAs = (userId, enabled = true) =>
    createAuth({ authEnabled: enabled, adminUserIds: [] }, { session: async () => (userId ? { userId, name: userId, isAdminRole: false } : null) });
  const deps = (auth, database = { status: "ready", db }) => ({ database: () => database, auth, engine: createEngineClient({ baseUrl: stub.url }) });
  assert.equal((await openNotification(deps(authAs(null)), { id })).status, 401);
  assert.equal((await markAllNotificationsRead(deps(authAs(null)))).status, 401);
  assert.equal((await openNotification(deps(authAs(ALICE.userId, false)), { id })).status, 503);
  assert.equal((await openNotification(deps(authAs(ALICE.userId), { status: "unavailable" }), { id })).status, 503);
  assert.deepEqual(await openNotification(deps(authAs(BOB.userId)), { id }), { ok: true, target: null });
  assert.equal(await countUnread(db, ALICE.userId), 1);
  assert.deepEqual(await markAllNotificationsRead(deps(authAs(BOB.userId))), { ok: true, marked: 0 });
  assert.equal(await countUnread(db, ALICE.userId), 1);
  assert.deepEqual(await openNotification(deps(authAs(ALICE.userId)), { id }), { ok: true, target: { fitId: fit.id, commentId: (await inbox(ALICE))[0].commentId } });
  assert.equal(await countUnread(db, ALICE.userId), 0);
});

test("the page loaders: a signed-in pilot's list and the header's count, 99+ and an unavailable database", async () => {
  const fit = await published();
  await say(fit.id, BOB, "x");
  const ready = { database: () => ({ status: "ready", db }) };
  assert.equal(await loadUnreadCount(ready, ALICE.userId), 1);
  assert.equal(await loadUnreadCount(ready, BOB.userId), 0);
  assert.equal(await loadUnreadCount({ database: () => ({ status: "unavailable" }) }, ALICE.userId), 0);
  assert.equal(unreadLabel(7), "7");
  assert.equal(unreadLabel(99), "99");
  assert.equal(unreadLabel(100), "99+");
  const deps = { ...ready, engine: { current: async () => ({ status: "down", buildSha: null }) }, catalog: { get: async () => ({ ok: false }), peek: () => null, etag: () => null } };
  const data = await loadNotifications(deps, {}, ALICE.userId);
  assert.equal(data.status, "ok");
  assert.equal(data.notifications.length, 1);
  assert.equal((await loadNotifications({ ...deps, database: () => ({ status: "unavailable" }) }, {}, ALICE.userId)).status, "unavailable");
});

test("followers are told on a fit's first publication only, not when it is republished after an unpublish", async () => {
  const fit = await draft();
  await setFollow(db, { follower: BOB, followeeUserId: ALICE.userId, following: true });
  await publishFit(db, { id: fit.id, authorUserId: ALICE.userId, buildSha: SHA });
  assert.deepEqual(await kinds(BOB), ["follow_fit"]);
  await unpublishFit(db, { id: fit.id, authorUserId: ALICE.userId });
  assert.deepEqual(await kinds(BOB), []);
  await publishFit(db, { id: fit.id, authorUserId: ALICE.userId, buildSha: SHA });
  assert.deepEqual(await kinds(BOB), [], "the republish says nothing");
});
