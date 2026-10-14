import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { listBookmarks, setBookmark } from "./bookmarks.ts";
import { getForkInfo } from "./forks.ts";
import { ANONYMOUS, FitDataError, browseFits, createFit, deleteFit, getFit, publishFit, setFitHidden, unpublishFit } from "./queries.ts";
import { parseBrowseParams } from "./filters.ts";
import { createTestDb, sampleFit } from "./test-db.mjs";

const SHA = "build-a";
const ALICE = { userId: "user_alice", isAdmin: false };
const BOB = { userId: "user_bob", isAdmin: false };
const CAROL = { userId: "user_carol", isAdmin: false };
const ADMIN = { userId: "user_admin", isAdmin: true };
const good = { buildSha: SHA, valid: true, rating: 10, stats: { speed: 3, sections: [] }, issues: [] };

let db;
before(async () => {
  db = await createTestDb();
});
after(() => db.close());
beforeEach(async () => {
  await db.exec("TRUNCATE fits, fit_reports, pilots CASCADE");
});

async function draft(owner = ALICE, extra = {}) {
  return createFit(db, {
    authorUserId: owner.userId,
    authorName: owner.userId.replace("user_", ""),
    title: extra.title ?? "A fit",
    content: sampleFit("1000"),
    buildSha: SHA,
    evaluation: good,
    ...extra,
  });
}
async function published(owner = ALICE, extra = {}) {
  const fit = await draft(owner, extra);
  await publishFit(db, { id: fit.id, authorUserId: owner.userId, buildSha: SHA });
  return fit;
}
const rejects = (promise, code) => assert.rejects(promise, (error) => error instanceof FitDataError && error.code === code, `expected ${code}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- bookmarks ----------------------------------------------------------------------------------

test("bookmarking is idempotent in both directions and keeps the first bookmark's time", async () => {
  const fit = await published();
  assert.deepEqual(await setBookmark(db, { fitId: fit.id, userId: BOB.userId, bookmarked: true }), { bookmarked: true });
  const first = (await db.query("SELECT created_at FROM fit_bookmarks")).rows[0].created_at;
  await sleep(5);
  assert.deepEqual(await setBookmark(db, { fitId: fit.id, userId: BOB.userId, bookmarked: true }), { bookmarked: true });
  const rows = (await db.query("SELECT created_at FROM fit_bookmarks")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].created_at.getTime(), first.getTime());
  assert.equal((await getFit(db, fit.id, { viewer: BOB })).viewerBookmarked, true);
  assert.equal((await getFit(db, fit.id, { viewer: CAROL })).viewerBookmarked, false, "a bookmark is the pilot's own");
  assert.equal((await getFit(db, fit.id)).viewerBookmarked, false);
  assert.deepEqual(await setBookmark(db, { fitId: fit.id, userId: BOB.userId, bookmarked: false }), { bookmarked: false });
  assert.deepEqual(await setBookmark(db, { fitId: fit.id, userId: BOB.userId, bookmarked: false }), { bookmarked: false });
  assert.equal((await getFit(db, fit.id, { viewer: BOB })).viewerBookmarked, false);
});

test("only a published fit can be bookmarked; an unknown or malformed id is not found", async () => {
  const fit = await published();
  const d = await draft();
  await rejects(setBookmark(db, { fitId: d.id, userId: BOB.userId, bookmarked: true }), "not_found");
  await rejects(setBookmark(db, { fitId: "0000000000", userId: BOB.userId, bookmarked: true }), "not_found");
  await rejects(setBookmark(db, { fitId: "../../x", userId: BOB.userId, bookmarked: true }), "not_found");
  await rejects(setBookmark(db, { fitId: fit.id, userId: "", bookmarked: true }), "invalid");
  await setFitHidden(db, fit.id, true);
  await rejects(setBookmark(db, { fitId: fit.id, userId: BOB.userId, bookmarked: true }), "not_found");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM fit_bookmarks")).rows[0].n, 0);
});

test("the list is the viewer's own, newest bookmark first, and only published fits", async () => {
  const a = await published(ALICE, { title: "A" });
  const b = await published(ALICE, { title: "B" });
  const c = await published(CAROL, { title: "C" });
  for (const fit of [a, b, c]) {
    await setBookmark(db, { fitId: fit.id, userId: BOB.userId, bookmarked: true });
    await sleep(5);
  }
  await setBookmark(db, { fitId: a.id, userId: CAROL.userId, bookmarked: true });
  const titles = async (userId) => (await listBookmarks(db, { userId, buildSha: SHA })).fits.map((fit) => fit.title);
  assert.deepEqual(await titles(BOB.userId), ["C", "B", "A"]);
  assert.deepEqual(await titles(CAROL.userId), ["A"]);
  assert.deepEqual(await titles("user_nobody"), []);
  assert.ok((await listBookmarks(db, { userId: BOB.userId })).fits.every((fit) => fit.viewerBookmarked && fit.status === "published"));

  // Unpublished and hidden fits drop out, whoever's they are, and return with the fit.
  await unpublishFit(db, { id: b.id, authorUserId: ALICE.userId });
  await setFitHidden(db, c.id, true);
  assert.deepEqual(await titles(BOB.userId), ["A"]);
  await publishFit(db, { id: b.id, authorUserId: ALICE.userId, buildSha: SHA });
  await setFitHidden(db, c.id, false);
  assert.deepEqual(await titles(BOB.userId), ["C", "B", "A"]);

  // The author's own hidden fit is not listed in their own bookmarks either.
  await setBookmark(db, { fitId: a.id, userId: ALICE.userId, bookmarked: true });
  await setFitHidden(db, a.id, true);
  assert.deepEqual(await titles(ALICE.userId), []);
});

test("bookmarks page by cursor without repeating or skipping, and a foreign cursor is ignored", async () => {
  const fits = [];
  for (let i = 0; i < 5; i++) {
    const fit = await published(ALICE, { title: `F${i}` });
    fits.push(fit);
    await setBookmark(db, { fitId: fit.id, userId: BOB.userId, bookmarked: true });
  }
  // Two bookmarks in one instant: the fit id breaks the tie.
  await db.query("UPDATE fit_bookmarks SET created_at = (SELECT created_at FROM fit_bookmarks WHERE fit_id = $1) WHERE fit_id = $2", [fits[1].id, fits[2].id]);
  const seen = [];
  let cursor;
  for (let guard = 0; guard < 10; guard++) {
    const page = await listBookmarks(db, { userId: BOB.userId, limit: 2, cursor });
    seen.push(...page.fits.map((fit) => fit.id));
    cursor = page.nextCursor ?? undefined;
    if (!cursor) break;
  }
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
  assert.deepEqual([...seen].sort(), fits.map((fit) => fit.id).sort());

  const browsePage = await browseFits(db, { query: parseBrowseParams(new URLSearchParams("sort=new")), buildSha: SHA, limit: 1 });
  assert.equal((await listBookmarks(db, { userId: BOB.userId, limit: 2, cursor: browsePage.nextCursor })).fits.length, 2, "a browse cursor starts the list over");
  assert.equal((await listBookmarks(db, { userId: BOB.userId, limit: 2, cursor: "garbage" })).fits.length, 2);
});

test("deleting a fit takes its bookmarks with it", async () => {
  const fit = await published();
  await setBookmark(db, { fitId: fit.id, userId: BOB.userId, bookmarked: true });
  assert.equal(await deleteFit(db, { id: fit.id, authorUserId: ALICE.userId }), true);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM fit_bookmarks")).rows[0].n, 0);
});

test("browse carries whether the viewer bookmarked each card", async () => {
  const a = await published(ALICE, { title: "A" });
  await published(ALICE, { title: "B" });
  await setBookmark(db, { fitId: a.id, userId: BOB.userId, bookmarked: true });
  const page = await browseFits(db, { query: parseBrowseParams(new URLSearchParams("")), buildSha: SHA, viewer: BOB });
  assert.deepEqual(page.fits.map((fit) => [fit.title, fit.viewerBookmarked]).sort(), [["A", true], ["B", false]]);
  const anonymous = await browseFits(db, { query: parseBrowseParams(new URLSearchParams("")), buildSha: SHA, viewer: ANONYMOUS });
  assert.ok(anonymous.fits.every((fit) => !fit.viewerBookmarked));
});

// --- fork credit --------------------------------------------------------------------------------

const forkedFromOf = async (id) => (await db.query("SELECT forked_from, forked_from_deleted FROM fits WHERE id = $1", [id])).rows[0];

test("a first save records the source when the saver may see it; anything else stores no credit and no error", async () => {
  const source = await published(ALICE, { title: "Source" });
  const aliceDraft = await draft(ALICE, { title: "Private" });
  const hidden = await published(ALICE, { title: "Hidden" });
  await setFitHidden(db, hidden.id, true);

  const fork = await draft(BOB, { forkedFrom: source.id });
  assert.deepEqual(await forkedFromOf(fork.id), { forked_from: source.id, forked_from_deleted: false });
  const own = await draft(ALICE, { forkedFrom: aliceDraft.id });
  assert.equal((await forkedFromOf(own.id)).forked_from, aliceDraft.id, "your own draft is a source you may credit");
  const ownHidden = await draft(ALICE, { forkedFrom: hidden.id });
  assert.equal((await forkedFromOf(ownHidden.id)).forked_from, hidden.id);

  for (const forkedFrom of [aliceDraft.id, hidden.id, "0000000000", "../../x", "", null, undefined, "x".repeat(500)]) {
    const fit = await draft(BOB, { forkedFrom });
    assert.deepEqual(await forkedFromOf(fit.id), { forked_from: null, forked_from_deleted: false }, String(forkedFrom).slice(0, 12));
  }
});

test("the credit shows the source to those who may see it, 'another fit' to those who may not, and counts published copies", async () => {
  const source = await published(ALICE, { title: "Source" });
  const fork = await published(BOB, { forkedFrom: source.id });
  const draftFork = await draft(CAROL, { forkedFrom: source.id });
  assert.deepEqual(await getForkInfo(db, fork.id, ANONYMOUS), {
    credit: { state: "source", id: source.id, title: "Source", authorUserId: ALICE.userId, authorName: "alice" },
    copies: 0,
  });
  assert.equal((await getForkInfo(db, source.id, ANONYMOUS)).copies, 1, "the draft fork isn't counted");
  assert.equal((await getForkInfo(db, source.id, ANONYMOUS)).credit, null);
  await publishFit(db, { id: draftFork.id, authorUserId: CAROL.userId, buildSha: SHA });
  assert.equal((await getForkInfo(db, source.id, ANONYMOUS)).copies, 2);
  await setFitHidden(db, draftFork.id, true);
  assert.equal((await getForkInfo(db, source.id, ANONYMOUS)).copies, 1, "a hidden copy isn't counted");

  // The source goes back to a draft: others see "another fit", the author and an admin still see it.
  await unpublishFit(db, { id: source.id, authorUserId: ALICE.userId });
  assert.deepEqual((await getForkInfo(db, fork.id, ANONYMOUS)).credit, { state: "unseen" });
  assert.deepEqual((await getForkInfo(db, fork.id, BOB)).credit, { state: "unseen" });
  assert.equal((await getForkInfo(db, fork.id, ALICE)).credit.state, "source");
  assert.equal((await getForkInfo(db, fork.id, ADMIN)).credit.state, "source");
  const unseen = JSON.stringify(await getForkInfo(db, fork.id, BOB));
  assert.ok(!unseen.includes("Source") && !unseen.includes("alice"), "no title or pilot leaks");
  assert.equal((await getForkInfo(db, "0000000000", ANONYMOUS)).credit, null);
});

test("deleting the source leaves its forks working and marked, in one statement", async () => {
  const source = await published(ALICE, { title: "Source" });
  const fork = await published(BOB, { forkedFrom: source.id });
  const fork2 = await draft(CAROL, { forkedFrom: source.id });
  const unrelated = await published(BOB, { title: "Unrelated" });
  assert.equal(await deleteFit(db, { id: source.id, authorUserId: BOB.userId }), false, "not theirs: nothing is marked");
  assert.equal((await forkedFromOf(fork.id)).forked_from, source.id);
  assert.equal(await deleteFit(db, { id: source.id, authorUserId: ALICE.userId }), true);
  for (const id of [fork.id, fork2.id]) assert.deepEqual(await forkedFromOf(id), { forked_from: null, forked_from_deleted: true });
  assert.deepEqual(await forkedFromOf(unrelated.id), { forked_from: null, forked_from_deleted: false });
  assert.deepEqual(await getForkInfo(db, fork.id, ANONYMOUS), { credit: { state: "deleted" }, copies: 0 });
  assert.equal((await getFit(db, fork.id)).id, fork.id, "the fork still renders");
  // A chain: deleting the middle marks the end, and leaves the root's count at what it was.
  const root = await published(ALICE, { title: "Root" });
  const middle = await published(BOB, { forkedFrom: root.id });
  const end = await published(CAROL, { forkedFrom: middle.id });
  assert.equal(await deleteFit(db, { id: middle.id, authorUserId: BOB.userId }), true);
  assert.deepEqual((await getForkInfo(db, end.id, ANONYMOUS)).credit, { state: "deleted" });
  assert.equal((await getForkInfo(db, root.id, ANONYMOUS)).copies, 0);
});

test("the schema refuses a fit that is both forked and marked deleted", async () => {
  const source = await published(ALICE);
  const fork = await draft(BOB, { forkedFrom: source.id });
  await assert.rejects(db.query("UPDATE fits SET forked_from_deleted = true WHERE id = $1", [fork.id]));
});
