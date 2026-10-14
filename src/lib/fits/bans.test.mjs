// Bans on pglite: the ban row, the refusal check, hiding everything a pilot published, and the admin pilot list.
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { BANNED_MESSAGE, PilotBannedError, assertNotBanned, banPilot, getBan, hidePilotContent, listPilots, unbanPilot, validateBanReason } from "./bans.ts";
import { listNotifications } from "./notifications.ts";
import { upsertPilotAtSignIn } from "./pilots.ts";
import { createComment, createFit, createReport, getFit, listComments, listOpenReports, publishFit, ANONYMOUS } from "./queries.ts";
import { createTestDb, sampleFit } from "./test-db.mjs";

const SHA = "build-a";
const ALICE = { userId: "user_alice", name: "alice" };
const BOB = { userId: "user_bob", name: "bob" };
const CAROL = { userId: "user_carol", name: "carol" };
const ADMIN = { userId: "user_admin", name: "warden" };
const good = { buildSha: SHA, valid: true, rating: 10, stats: {}, issues: [] };

let db;
before(async () => {
  db = await createTestDb();
});
after(() => db.close());
beforeEach(async () => {
  await db.exec("TRUNCATE fits, fit_reports, pilots, write_budget_windows CASCADE");
  for (const pilot of [ALICE, BOB, CAROL, ADMIN]) await upsertPilotAtSignIn(db, { userId: pilot.userId, name: pilot.name, avatarUrl: null });
});

async function draft(owner) {
  return createFit(db, { authorUserId: owner.userId, authorName: owner.name, title: "A fit", content: sampleFit("1000"), buildSha: SHA, evaluation: good });
}
async function published(owner) {
  const fit = await draft(owner);
  await publishFit(db, { id: fit.id, authorUserId: owner.userId, buildSha: SHA });
  return fit;
}
const say = (fitId, who, body, parentId = null) => createComment(db, { fitId, parentId, authorUserId: who.userId, authorName: who.name, body });
const ban = (who, extra = {}) => banPilot(db, { userId: who.userId, reason: "Spam", bannedBy: ADMIN.userId, hideAll: false, ...extra });
const isBanned = async (who) =>
  assertNotBanned(db, who.userId).then(
    () => false,
    (error) => {
      assert.ok(error instanceof PilotBannedError);
      assert.equal(error.message, BANNED_MESSAGE);
      return true;
    },
  );

test("a ban is one row with a reason; banning again keeps the first; unbanning deletes it", async () => {
  assert.equal(await isBanned(BOB), false);
  assert.deepEqual(await ban(BOB), { created: true, hidden: null });
  assert.equal(await isBanned(BOB), true);
  assert.equal(await isBanned(ALICE), false, "only the banned pilot");
  assert.deepEqual(await ban(BOB, { reason: "Again" }), { created: false, hidden: null });
  const stored = await getBan(db, BOB.userId);
  assert.equal(stored.reason, "Spam");
  assert.equal(stored.bannedBy, ADMIN.userId);
  assert.equal(stored.bannedByName, "warden");
  assert.equal(await getBan(db, ALICE.userId), null);
  assert.equal(await unbanPilot(db, BOB.userId), true);
  assert.equal(await unbanPilot(db, BOB.userId), false);
  assert.equal(await isBanned(BOB), false);
});

test("a ban needs a reason of 1 to 500 characters and a pilot with a row", async () => {
  await assert.rejects(ban(BOB, { reason: "   " }), (e) => e.code === "invalid");
  await assert.rejects(ban(BOB, { reason: "x".repeat(501) }), (e) => e.code === "invalid");
  assert.equal(validateBanReason(` ${"x".repeat(500)} `).length, 500);
  await assert.rejects(banPilot(db, { userId: "user_nobody", reason: "x", bannedBy: ADMIN.userId, hideAll: false }), (e) => e.code === "not_found");
  await assert.rejects(banPilot(db, { userId: "bad id'; --", reason: "x", bannedBy: ADMIN.userId, hideAll: false }), (e) => e.code === "not_found");
  assert.equal(await isBanned(BOB), false);
});

test("hiding all of a pilot's content hides their published fits and live comments, drops their notifications and closes their reports", async () => {
  const bobFit = await published(BOB);
  const bobDraft = await draft(BOB);
  const aliceFit = await published(ALICE);
  const bobComment = await say(aliceFit.id, BOB, "spam");
  const reply = await say(aliceFit.id, CAROL, "reply to spam", bobComment.id);
  const carolOnBob = await say(bobFit.id, CAROL, "nice");
  const aliceComment = await say(aliceFit.id, ALICE, "mine");
  await createReport(db, { targetKind: "fit", targetId: bobFit.id, reporterUserId: ALICE.userId, reason: "bad" });
  await createReport(db, { targetKind: "comment", targetId: bobComment.id, reporterUserId: ALICE.userId, reason: "bad" });
  const kept = await createReport(db, { targetKind: "comment", targetId: aliceComment.id, reporterUserId: CAROL.userId, reason: "other" });
  // Alice was told of Bob's comment and Carol's reply under it on her fit; Bob of Carol's reply and comment.
  assert.equal((await listNotifications(db, { userId: ALICE.userId })).notifications.length, 2);
  assert.equal((await listNotifications(db, { userId: BOB.userId })).notifications.length, 2);

  const result = await ban(BOB, { hideAll: true });
  assert.deepEqual(result, { created: true, hidden: { fits: 1, comments: 1, reports: 2 } });
  assert.equal(await getFit(db, bobFit.id), null, "the published fit is hidden from the public");
  assert.equal((await getFit(db, bobFit.id, { viewer: { userId: null, isAdmin: true } })).status, "hidden");
  assert.equal((await getFit(db, bobDraft.id, { viewer: { userId: BOB.userId, isAdmin: false } })).status, "draft", "a draft stays a draft");
  const thread = await listComments(db, aliceFit.id, { viewer: ANONYMOUS });
  assert.deepEqual(thread.map((c) => c.id), [aliceComment.id], "the hidden comment takes its reply with it");
  assert.equal((await listComments(db, aliceFit.id, { viewer: { userId: null, isAdmin: true } })).find((c) => c.id === bobComment.id).hidden, true);
  assert.equal((await listNotifications(db, { userId: ALICE.userId })).notifications.length, 0);
  assert.equal((await listNotifications(db, { userId: BOB.userId })).notifications.length, 0);
  const open = (await listOpenReports(db)).reports.map((r) => r.id);
  assert.deepEqual(open, [kept.id], "only the report on someone else's comment stays open");
  void reply;
  void carolOnBob;
  // Running it again changes nothing.
  assert.deepEqual(await hidePilotContent(db, BOB.userId), { fits: 0, comments: 0, reports: 0 });
  // Unbanning lifts the ban only: what it hid stays hidden.
  await unbanPilot(db, BOB.userId);
  assert.equal(await getFit(db, bobFit.id), null);
});

test("the pilot list: newest first, paged without repeats, searched by name (escaped) or exact id, banned only", async () => {
  await db.exec("TRUNCATE pilots CASCADE");
  for (let i = 0; i < 7; i++) await upsertPilotAtSignIn(db, { userId: `user_p${i}`, name: i === 3 ? "100%_real\\x" : `pilot ${i}`, avatarUrl: null });
  await db.query(`UPDATE pilots SET created_at = '2026-10-01T00:00:00Z'`); // ties broken by user id
  const seen = [];
  let cursor;
  do {
    const page = await listPilots(db, { limit: 3, cursor });
    seen.push(...page.pilots.map((p) => p.userId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(seen, ["user_p6", "user_p5", "user_p4", "user_p3", "user_p2", "user_p1", "user_p0"]);

  assert.deepEqual((await listPilots(db, { q: "%" })).pilots.map((p) => p.userId), ["user_p3"], "% is a literal");
  assert.deepEqual((await listPilots(db, { q: "_" })).pilots.map((p) => p.userId), ["user_p3"], "_ is a literal");
  assert.deepEqual((await listPilots(db, { q: "\\" })).pilots.map((p) => p.userId), ["user_p3"], "\\ is a literal");
  assert.deepEqual((await listPilots(db, { q: "PILOT 1" })).pilots.map((p) => p.userId), ["user_p1"], "names match without case");
  assert.deepEqual((await listPilots(db, { q: "user_p5" })).pilots.map((p) => p.userId), ["user_p5"], "an exact id");
  assert.deepEqual((await listPilots(db, { q: "'; DROP TABLE pilots; --" })).pilots, []);
  assert.equal((await listPilots(db, { q: "x".repeat(10_000) })).pilots.length, 0, "a long query is capped, not an error");
  assert.equal((await listPilots(db, { cursor: "garbage" })).pilots.length, 7, "a bad cursor starts over");

  await banPilot(db, { userId: "user_p2", reason: "Spam", bannedBy: "user_p0", hideAll: false });
  const banned = await listPilots(db, { banned: true });
  assert.deepEqual(banned.pilots.map((p) => p.userId), ["user_p2"]);
  assert.equal(banned.pilots[0].ban.reason, "Spam");
  assert.equal(banned.pilots[0].ban.bannedByName, "pilot 0");
  assert.equal((await listPilots(db, { q: "pilot 1" })).pilots[0].ban, null);
});
