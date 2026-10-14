import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { SIGN_IN_UNAVAILABLE_MESSAGE } from "../auth-errors.ts";
import { createAuth } from "../auth-core.ts";
import { createEngineClient } from "../engine/client.ts";
import { startStubEngine } from "../engine/stub-engine.mjs";
import { getFit, listComments, listOpenReports } from "../fits/queries.ts";
import { createTestDb } from "../fits/test-db.mjs";
import * as core from "./actions-core.ts";
import { getBan } from "../fits/bans.ts";
import { addComment, banPilot, unbanPilot, bookmark, compareChoices, previewMarkdown, deleteComment, deleteFit, editBio, editComment, follow, publishFit, saveFit, unpublishFit, moderate, report, resolveReport, vote, DATABASE_DOWN_MESSAGE } from "./actions-core.ts";
import { FIXTURES } from "../engine/stub-engine.mjs";
import { listRevisions } from "../fits/revisions.ts";
import { listBookmarks } from "../fits/bookmarks.ts";
import { getForkInfo } from "../fits/forks.ts";
import { getPilotProfile } from "../fits/pilots.ts";
import { DESCRIPTION_MAX } from "../fits/limits.ts";
import { renderMarkdown } from "../fits/markdown.ts";
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
  await db.exec("TRUNCATE fits, fit_reports, write_budget_windows, pilots CASCADE");
  ids = await seedSite(db);
});

const profiles = { [ALICE.userId]: ALICE, [BOB.userId]: BOB, [ADMIN.userId]: ADMIN };
function authAs(userId, { enabled = true, adminRole = "none" } = {}) {
  return createAuth(
    { authEnabled: enabled, adminUserIds: [ADMIN.userId] },
    { session: async () => (userId ? { userId, name: profiles[userId]?.name ?? "PILOT", adminRole } : null) },
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

// --- follows and bios ------------------------------------------------------------------------------

test("follow and bio edits need sign-in and a database", async () => {
  const off = deps(authAs(BOB.userId, { enabled: false }));
  assert.equal((await follow(off, { userId: ALICE.userId, following: true })).status, 503);
  assert.equal((await editBio(off, { bio: "hi" })).status, 503);
  assert.equal((await follow(deps(authAs(null)), { userId: ALICE.userId, following: true })).status, 401);
  assert.equal((await editBio(deps(authAs(null)), { bio: "hi" })).status, 401);
  const down = deps(authAs(BOB.userId), { database: { status: "unavailable" } });
  assert.equal((await follow(down, { userId: ALICE.userId, following: true })).status, 503);
  assert.equal((await getPilotProfile(db, ALICE.userId, { userId: null, isAdmin: false })).followers, 0);
});

test("a pilot follows and unfollows another, never themself, and the counts follow", async () => {
  const bob = deps(authAs(BOB.userId));
  assert.deepEqual(await follow(bob, { userId: ALICE.userId, following: true }), { ok: true, following: true, followers: 1 });
  assert.deepEqual(await follow(bob, { userId: ALICE.userId, following: true }), { ok: true, following: true, followers: 1 });
  const self = await follow(bob, { userId: BOB.userId, following: true });
  assert.equal(self.ok, false);
  assert.equal(self.status, 400);
  assert.equal((await follow(bob, { userId: "user_nobody", following: true })).status, 404);
  // An admin who never wrote anything has no row until their first write creates it from the session.
  assert.equal((await follow(deps(authAs(ADMIN.userId)), { userId: ALICE.userId, following: true })).ok, true);
  assert.equal((await getPilotProfile(db, ADMIN.userId, { userId: null, isAdmin: false })).name, "WARDEN");
  assert.deepEqual(await follow(bob, { userId: ALICE.userId, following: false }), { ok: true, following: false, followers: 1 });
});

test("follows and bio edits spend their own budgets", async () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const bob = { ...deps(authAs(BOB.userId)), now: () => now };
  for (let i = 0; i < WRITE_BUDGETS.follow[0].limit; i++) {
    assert.equal((await follow(bob, { userId: ALICE.userId, following: i % 2 === 0 })).ok, true);
  }
  const limited = await follow(bob, { userId: ALICE.userId, following: true });
  assert.equal(limited.status, 429);
  assert.equal((await getPilotProfile(db, ALICE.userId, { userId: null, isAdmin: false })).followers, 0, "the refused follow wrote nothing");
  assert.equal((await vote(bob, { fitId: ids.pending, voted: true })).ok, true, "other budgets are untouched");

  for (let i = 0; i < WRITE_BUDGETS.profile[0].limit; i++) assert.equal((await editBio(bob, { bio: `bio ${i}` })).ok, true);
  assert.equal((await editBio(bob, { bio: "one too many" })).status, 429);
  assert.equal((await getPilotProfile(db, BOB.userId, { userId: null, isAdmin: false })).bio, `bio ${WRITE_BUDGETS.profile[0].limit - 1}`);
});

test("a bio edit changes only the signed-in pilot's bio and refuses what isn't plain text", async () => {
  const alice = deps(authAs(ALICE.userId));
  assert.deepEqual(await editBio(alice, { bio: " Frigates only. " }), { ok: true, bio: "Frigates only." });
  assert.equal((await getPilotProfile(db, BOB.userId, { userId: null, isAdmin: false })).bio, "");
  const long = await editBio(alice, { bio: "x".repeat(501) });
  assert.equal(long.status, 400);
  assert.match(long.message, /500/);
});

test("saving a published fit appends a revision with the note; a draft save and a publish record none of the note", async () => {
  const alice = deps(authAs(ALICE.userId));
  const created = await saveFit(alice, { fitId: null, title: "History", description: "", tags: [], fit: FIXTURES.fit, note: "ignored on a draft" });
  assert.equal(created.ok, true);
  const id = created.fit.fitId;
  assert.deepEqual(await listRevisions(db, id), [], "a draft has no history");
  assert.equal((await publishFit(alice, { fitId: id })).ok, true);
  const saved = await saveFit(alice, { fitId: id, title: "History v2", description: "", tags: [], fit: FIXTURES.fit, note: "  Tuned the heat  " });
  assert.equal(saved.ok, true);
  const empty = await saveFit(alice, { fitId: id, title: "History v3", description: "", tags: [], fit: FIXTURES.fit });
  assert.equal(empty.ok, true);
  const revisions = await listRevisions(db, id);
  assert.deepEqual(revisions.map((r) => [r.revision, r.note]), [[3, null], [2, "Tuned the heat"], [1, null]]);
});

test("a too-long note is refused as a value and saves nothing; another pilot's fit is not theirs to save", async () => {
  const alice = deps(authAs(ALICE.userId));
  const before = (await listRevisions(db, ids.showcase)).length;
  const long = await saveFit(alice, { fitId: ids.showcase, title: "Nope", description: "", tags: [], fit: FIXTURES.fit, note: "x".repeat(201) });
  assert.equal(long.ok, false);
  assert.equal(long.status, 400);
  const forged = await saveFit(deps(authAs(BOB.userId)), { fitId: ids.showcase, title: "Mine", description: "", tags: [], fit: FIXTURES.fit, note: "hi" });
  assert.equal(forged.status, 403);
  assert.equal((await listRevisions(db, ids.showcase)).length, before);
  assert.equal((await getFit(db, ids.showcase)).title, "Scarab cipher brawler");
});

test("bookmarks need sign-in and a database, are idempotent, refuse unpublished fits, and spend their own budget", async () => {
  assert.equal((await bookmark(deps(authAs(BOB.userId, { enabled: false })), { fitId: ids.showcase, bookmarked: true })).status, 503);
  assert.equal((await bookmark(deps(authAs(null)), { fitId: ids.showcase, bookmarked: true })).status, 401);
  assert.equal((await bookmark(deps(authAs(BOB.userId), { database: { status: "unavailable" } }), { fitId: ids.showcase, bookmarked: true })).status, 503);
  const bob = deps(authAs(BOB.userId));
  assert.deepEqual(await bookmark(bob, { fitId: ids.showcase, bookmarked: true }), { ok: true, bookmarked: true });
  assert.deepEqual(await bookmark(bob, { fitId: ids.showcase, bookmarked: true }), { ok: true, bookmarked: true });
  assert.deepEqual((await listBookmarks(db, { userId: BOB.userId })).fits.map((fit) => fit.id), [ids.showcase]);
  assert.equal((await bookmark(bob, { fitId: ids.draft, bookmarked: true })).status, 404, "another pilot's draft");
  assert.equal((await bookmark(bob, { fitId: "nope", bookmarked: true })).status, 404);
  assert.deepEqual(await bookmark(bob, { fitId: ids.showcase, bookmarked: false }), { ok: true, bookmarked: false });
  assert.deepEqual(await bookmark(bob, { fitId: ids.showcase, bookmarked: false }), { ok: true, bookmarked: false });
  assert.deepEqual((await listBookmarks(db, { userId: BOB.userId })).fits, []);

  const now = new Date("2026-10-14T12:00:00Z");
  const limited = { ...deps(authAs(BOB.userId)), now: () => now };
  const spent = WRITE_BUDGETS.bookmark[0].limit;
  assert.equal(spent, 60);
  for (let i = 0; i < spent; i++) assert.equal((await bookmark(limited, { fitId: ids.showcase, bookmarked: i % 2 === 0 })).ok, true);
  const refused = await bookmark(limited, { fitId: ids.showcase, bookmarked: true });
  assert.equal(refused.status, 429);
  assert.equal(refused.reason, "rate_limited");
  assert.equal((await vote(limited, { fitId: ids.pending, voted: true })).ok, true, "votes have their own budget");
});

test("a new fit saved with a source is credited once; an edit, a hidden source and a forged id add or change nothing", async () => {
  const bob = deps(authAs(BOB.userId));
  const created = await saveFit(bob, { fitId: null, title: "My take", description: "", tags: [], fit: FIXTURES.fit, forkedFrom: ids.showcase });
  assert.equal(created.ok, true);
  const id = created.fit.fitId;
  const credit = async () => (await getForkInfo(db, id, { userId: BOB.userId, isAdmin: false })).credit;
  assert.equal((await credit()).id, ids.showcase);

  // Saving again with another source (or none) changes nothing: the credit is for the first save.
  assert.equal((await saveFit(bob, { fitId: id, title: "My take 2", description: "", tags: [], fit: FIXTURES.fit, forkedFrom: ids.removed })).ok, true);
  assert.equal((await credit()).id, ids.showcase);
  assert.equal((await saveFit(bob, { fitId: id, title: "My take 3", description: "", tags: [], fit: FIXTURES.fit })).ok, true);
  assert.equal((await credit()).id, ids.showcase);

  // A source Bob may not see, or that doesn't exist, is not an error: the fit is just not credited.
  for (const forkedFrom of [ids.draft, "0000000000", "x".repeat(500), undefined, null]) {
    const result = await saveFit(bob, { fitId: null, title: "Uncredited", description: "", tags: [], fit: FIXTURES.fit, forkedFrom });
    assert.equal(result.ok, true, String(forkedFrom).slice(0, 12));
    assert.equal((await getForkInfo(db, result.fit.fitId, { userId: BOB.userId, isAdmin: false })).credit, null);
  }
  // The same source is fine for its own author.
  const own = await saveFit(deps(authAs(ALICE.userId)), { fitId: null, title: "From my draft", description: "", tags: [], fit: FIXTURES.fit, forkedFrom: ids.draft });
  assert.equal((await getForkInfo(db, own.fit.fitId, { userId: ALICE.userId, isAdmin: false })).credit.state, "source");
});

test("the writing preview renders the page's sanitized Markdown for signed-in pilots only, bounded and rate-limited", async () => {
  const source = "**bold** <script>alert(1)</script> [x](javascript:alert(1)) [ok](https://example.com)";
  assert.equal((await previewMarkdown(deps(authAs(BOB.userId, { enabled: false })), { text: "hi" })).status, 503);
  assert.equal((await previewMarkdown(deps(authAs(null)), { text: "hi" })).status, 401);
  assert.equal((await previewMarkdown(deps(authAs(BOB.userId), { database: { status: "unavailable" } }), { text: "hi" })).status, 503);
  const bob = deps(authAs(BOB.userId));
  const result = await previewMarkdown(bob, { text: source });
  assert.equal(result.ok, true);
  assert.equal(result.html, renderMarkdown(source), "the same renderer the fit page uses");
  assert.match(result.html, /<strong>bold<\/strong>/);
  assert.doesNotMatch(result.html, /<script|href="javascript/i);
  assert.match(result.html, /href="https:\/\/example\.com"/);
  assert.equal((await previewMarkdown(bob, { text: "" })).ok, true);

  const tooLong = await previewMarkdown(bob, { text: "x".repeat(DESCRIPTION_MAX + 1) });
  assert.equal(tooLong.status, 400);
  assert.equal((await previewMarkdown(bob, { text: "x".repeat(DESCRIPTION_MAX) })).ok, true);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM write_budget_windows WHERE user_id = $1 AND budget LIKE 'preview/%'`, [BOB.userId])).rows[0].n, 1, "a refused size spends nothing");

  const now = new Date("2026-10-14T12:00:00Z");
  const limited = { ...deps(authAs(ALICE.userId)), now: () => now };
  const spent = WRITE_BUDGETS.preview[0].limit;
  assert.equal(spent, 60);
  for (let i = 0; i < spent; i++) assert.equal((await previewMarkdown(limited, { text: "a" })).ok, true);
  const refused = await previewMarkdown(limited, { text: "a" });
  assert.equal(refused.status, 429);
  assert.equal((await vote(limited, { fitId: ids.pending, voted: true })).ok, true, "votes have their own budget");
});

test("compare choices are the pilot's own bookmarks and fits only, capped", async () => {
  assert.equal((await compareChoices(deps(authAs(null)))).status, 401);
  assert.equal((await compareChoices(deps(authAs(ALICE.userId, { enabled: false })))).status, 503);
  await bookmark(deps(authAs(BOB.userId)), { fitId: ids.showcase, bookmarked: true });
  const bob = await compareChoices(deps(authAs(BOB.userId)));
  assert.deepEqual(bob.bookmarks.map((c) => c.id), [ids.showcase]);
  assert.deepEqual(bob.mine.map((c) => c.id).sort(), [ids.pending, ids.removed].sort());
  const alice = await compareChoices(deps(authAs(ALICE.userId)));
  assert.deepEqual(alice.bookmarks, [], "bookmarks are private");
  assert.ok(alice.mine.some((c) => c.id === ids.draft && c.status === "draft"), "own drafts are offered");
  assert.ok(!alice.mine.some((c) => c.id === ids.removed), "never another pilot's fit");
  assert.equal((await compareChoices(deps(authAs(ALICE.userId)), { limit: 1 })).mine.length, 1);
});

// ---------------------------------------------------------------------------------------------------
// Bans

const BANNED = { ok: false, reason: "banned", status: 403, message: "Your account is suspended from posting." };
/** A pilot with the Clerk admin role now (not in SITE_ADMIN_USER_IDS). */
const MOD = { userId: "user_mod", name: "MOD" };

/**
 * Every function actions-core exports that a pilot calls, with arguments that would succeed for BOB. A new
 * export missing here fails the coverage test below, so no write can be added without its ban check tested.
 */
function everyCall() {
  const fit = FIXTURES.fit;
  return {
    vote: (d) => vote(d, { fitId: ids.showcase, voted: true }),
    bookmark: (d) => bookmark(d, { fitId: ids.showcase, bookmarked: true }),
    addComment: (d) => addComment(d, { fitId: ids.showcase, parentId: null, body: "hello" }),
    editComment: (d) => editComment(d, { id: ids.comment, body: "edited" }),
    deleteComment: (d) => deleteComment(d, { id: ids.comment }),
    report: (d) => report(d, { targetKind: "fit", targetId: ids.showcase, reason: "bad" }),
    saveFit: (d) => saveFit(d, { fitId: null, title: "New", description: "", tags: [], fit }),
    publishFit: (d) => publishFit(d, { fitId: ids.pending }),
    unpublishFit: (d) => unpublishFit(d, { fitId: ids.pending }),
    deleteFit: (d) => deleteFit(d, { fitId: ids.pending }),
    follow: (d) => follow(d, { userId: ALICE.userId, following: true }),
    editBio: (d) => editBio(d, { bio: "hi" }),
    previewMarkdown: (d) => previewMarkdown(d, { text: "**hi**" }),
    openNotification: (d) => core.openNotification(d, { id: "1" }),
    markAllNotificationsRead: (d) => core.markAllNotificationsRead(d),
    compareChoices: (d) => compareChoices(d),
    moderate: (d) => moderate(d, { targetKind: "fit", targetId: ids.showcase, hidden: true }),
    resolveReport: (d) => resolveReport(d, { reportId: ids.fitReport }),
    banPilot: (d) => banPilot(d, { userId: ALICE.userId, reason: "x", hideAll: false }),
    unbanPilot: (d) => unbanPilot(d, { userId: ALICE.userId }),
  };
}
const ADMIN_CALLS = ["moderate", "resolveReport", "banPilot", "unbanPilot"];
/** Signed-in reads: a ban doesn't stop them. */
const READS = ["compareChoices"];

test("the ban coverage list names every function actions-core exports", () => {
  const exported = Object.entries(core).filter(([, value]) => typeof value === "function").map(([name]) => name).sort();
  assert.deepEqual(exported, Object.keys(everyCall()).sort());
});

test("a banned pilot is refused on every write with a clear message, writes nothing and spends no budget; reads go on", async () => {
  const admin = deps(authAs(ADMIN.userId));
  assert.deepEqual(await banPilot(admin, { userId: BOB.userId, reason: "Spam", hideAll: false }), { ok: true, created: true, hidden: null });
  const bob = deps(authAs(BOB.userId));
  for (const [name, call] of Object.entries(everyCall())) {
    if (ADMIN_CALLS.includes(name)) continue;
    const result = await call(bob);
    if (READS.includes(name)) assert.equal(result.ok, true, name);
    else assert.deepEqual(result, BANNED, name);
  }
  assert.equal((await getFit(db, ids.showcase)).votes, 2, "the vote wasn't counted");
  assert.equal((await getFit(db, ids.pending)).status, "published", "nor the unpublish or delete");
  assert.equal((await listComments(db, ids.showcase))[0].body.includes("edited"), false);
  assert.equal((await getPilotProfile(db, ALICE.userId, { userId: BOB.userId, isAdmin: false })).followers, 0);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM write_budget_windows WHERE user_id = $1`, [BOB.userId]);
  assert.equal(rows[0].n, 0, "the check runs before any budget is spent");
  // Another pilot writes as before, and an unban restores Bob's writes.
  assert.equal((await vote(deps(authAs(ALICE.userId)), { fitId: ids.pending, voted: true })).ok, true);
  assert.deepEqual(await unbanPilot(admin, { userId: BOB.userId }), { ok: true, unbanned: true });
  assert.equal((await vote(bob, { fitId: ids.showcase, voted: true })).ok, true);
});

test("a banned moderator (Clerk role, not a site admin) can't moderate either", async () => {
  await db.query(`INSERT INTO pilots (user_id, name) VALUES ($1, $2)`, [MOD.userId, MOD.name]);
  const mod = deps(authAs(MOD.userId, { adminRole: "active" }));
  assert.equal((await moderate(mod, { targetKind: "fit", targetId: ids.showcase, hidden: true })).ok, true);
  await moderate(mod, { targetKind: "fit", targetId: ids.showcase, hidden: false });
  assert.equal((await banPilot(deps(authAs(ADMIN.userId)), { userId: MOD.userId, reason: "Abuse", hideAll: false })).ok, true, "a Clerk-role admin can be banned");
  for (const name of ADMIN_CALLS) assert.deepEqual(await everyCall()[name](mod), BANNED, name);
  assert.equal((await getFit(db, ids.showcase)).status, "published");
});

test("ban and unban: admins only, never yourself or a site admin, a pilot that exists, a reason of 1 to 500", async () => {
  const admin = deps(authAs(ADMIN.userId));
  for (const call of [everyCall().banPilot, everyCall().unbanPilot]) {
    assert.equal((await call(deps(authAs(null)))).status, 401);
    assert.equal((await call(deps(authAs(BOB.userId)))).status, 403);
    assert.equal((await call(deps(authAs(BOB.userId, { adminRole: "expired" })))).status, 403, "an expired role must re-verify first");
    assert.equal((await call(deps(authAs(ADMIN.userId, { enabled: false })))).status, 503);
  }
  assert.deepEqual(await banPilot(admin, { userId: ADMIN.userId, reason: "x", hideAll: false }), { ok: false, reason: "invalid", status: 400, message: "You can't ban yourself." });
  await db.query(`INSERT INTO pilots (user_id, name) VALUES ($1, $2)`, [MOD.userId, MOD.name]);
  const mod = deps(authAs(MOD.userId, { adminRole: "active" }));
  assert.deepEqual(await banPilot(mod, { userId: ADMIN.userId, reason: "x", hideAll: false }), { ok: false, reason: "forbidden", status: 403, message: "Site admins can't be banned." });
  assert.deepEqual(await banPilot(mod, { userId: MOD.userId, reason: "x", hideAll: false }), { ok: false, reason: "invalid", status: 400, message: "You can't ban yourself." });
  assert.equal((await banPilot(admin, { userId: "user_nobody", reason: "x", hideAll: false })).status, 404);
  assert.equal((await banPilot(admin, { userId: BOB.userId, reason: " ", hideAll: false })).status, 400);
  assert.equal((await banPilot(admin, { userId: BOB.userId, reason: "x".repeat(501), hideAll: false })).status, 400);
  assert.equal(await getBan(db, BOB.userId), null, "nothing was written");
  assert.deepEqual(await unbanPilot(admin, { userId: BOB.userId }), { ok: true, unbanned: false });
});

test("a ban that hides everything hides the pilot's published fits and comments and resolves their reports", async () => {
  const admin = deps(authAs(ADMIN.userId));
  // Seed: Bob has two published fits (one reported) and a comment; Alice's reply under his comment was reported.
  const result = await banPilot(admin, { userId: BOB.userId, reason: "Spam", hideAll: true });
  assert.deepEqual(result, { ok: true, created: true, hidden: { fits: 2, comments: 1, reports: 1 } });
  assert.equal(await getFit(db, ids.removed), null);
  assert.equal(await getFit(db, ids.pending), null);
  assert.equal((await getFit(db, ids.showcase)).status, "published", "other pilots' fits are untouched");
  assert.deepEqual((await listOpenReports(db)).reports.map((r) => r.id), [ids.commentReport], "the report on Alice's reply stays open");
});

test("two moderators banning each other at once: the ban is checked inside its transaction, so only one lands", async () => {
  const OTHER = { userId: "user_mod2", name: "MOD2" };
  for (const pilot of [MOD, OTHER]) await db.query(`INSERT INTO pilots (user_id, name) VALUES ($1, $2)`, [pilot.userId, pilot.name]);
  const results = await Promise.all([
    banPilot(deps(authAs(MOD.userId, { adminRole: "active" })), { userId: OTHER.userId, reason: "x", hideAll: false }),
    banPilot(deps(authAs(OTHER.userId, { adminRole: "active" })), { userId: MOD.userId, reason: "y", hideAll: false }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  assert.deepEqual(results.find((result) => !result.ok), BANNED);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM pilot_bans`);
  assert.equal(rows[0].n, 1);
});

test("publish refusals say whether the engine was unreachable, failed, or refused the fit", async () => {
  const via = (error) => deps(authAs(ALICE.userId), { engine: { evaluate: async () => ({ ok: false, error }) } });
  const unreachable = await publishFit(via({ kind: "unavailable", message: "x" }), { fitId: ids.draft });
  assert.deepEqual([unreachable.reason, unreachable.status], ["engine", 503]);
  assert.match(unreachable.message, /can't be reached right now/);
  const failed = await publishFit(via({ kind: "failed", message: "x" }), { fitId: ids.draft });
  assert.deepEqual([failed.reason, failed.status], ["engine", 502]);
  assert.match(failed.message, /^The fit check failed on the loadout engine\./);
  const refused = await publishFit(via({ kind: "rejected", message: "modules[0]: bad port" }), { fitId: ids.draft });
  assert.deepEqual([refused.reason, refused.status], ["engine", 422]);
  assert.match(refused.message, /modules\[0\]: bad port/);
});
