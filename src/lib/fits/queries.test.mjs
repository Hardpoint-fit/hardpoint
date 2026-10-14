import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createTestDb, sampleFit } from "./test-db.mjs";
import {
  ANONYMOUS,
  FitDataError,
  browseFits,
  createComment,
  createFit,
  createReport,
  deleteComment,
  deleteFit,
  editComment,
  fitsNeedingEvaluation,
  generateFitId,
  getFit,
  getFitForEvaluation,
  listComments,
  listOpenReports,
  publishFit,
  recordEvaluation,
  resolveReport,
  resolveReportsForTarget,
  setCommentHidden,
  setFitHidden,
  setVote,
  toggleVote,
  unpublishFit,
  updateFit,
} from "./queries.ts";
import { parseBrowseParams } from "./filters.ts";
import { getRevision, listRevisions } from "./revisions.ts";

const SHA = "build-a";
const SHA2 = "build-b";
const ALICE = { userId: "user_alice", isAdmin: false };
const BOB = { userId: "user_bob", isAdmin: false };
const ADMIN = { userId: "user_admin", isAdmin: true };

const HULLS = new Map([
  ["1000", { hullClass: "Frigate", role: "Support" }],
  ["2000", { hullClass: "Cruiser", role: "Tank" }],
  ["3000", { hullClass: "Frigate", role: "Damage" }],
]);

const good = { buildSha: SHA, valid: true, rating: 10, stats: { speed: 3, sections: [] }, issues: [] };
const bad = { buildSha: SHA, valid: false, rating: null, stats: {}, issues: [{ code: "removed_item" }] };

let db;
before(async () => {
  db = await createTestDb();
});
after(() => db.close());
beforeEach(async () => {
  await db.exec("TRUNCATE fits, fit_reports, pilots CASCADE");
});

async function draft(owner = ALICE, overrides = {}) {
  const hull = overrides.hull ?? "1000";
  return createFit(db, {
    authorUserId: owner.userId,
    authorName: owner.userId.replace("user_", ""),
    title: overrides.title ?? "A fit",
    description: overrides.description,
    tags: overrides.tags,
    content: sampleFit(hull),
    buildSha: SHA,
    evaluation: overrides.evaluation === undefined ? good : overrides.evaluation ?? undefined,
  });
}

async function published(owner = ALICE, overrides = {}) {
  const fit = await draft(owner, overrides);
  await publishFit(db, { id: fit.id, authorUserId: owner.userId, buildSha: SHA });
  return fit;
}

async function browse(params = "", extra = {}) {
  return browseFits(db, { query: parseBrowseParams(new URLSearchParams(params)), buildSha: SHA, hulls: HULLS, ...extra });
}

const rejects = (promise, code) =>
  assert.rejects(promise, (error) => error instanceof FitDataError && error.code === code, `expected ${code}`);

// --- schema and migration -----------------------------------------------------------------------

test("applying the schema again is a no-op, and schema_version records each version once", async () => {
  const { applySchema } = await import("./migrate.mjs");
  await applySchema(db);
  await applySchema(db);
  const { rows } = await db.query("SELECT version FROM schema_version ORDER BY version");
  assert.deepEqual(rows, [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
});

test("concurrent applies on a fresh database all succeed", async () => {
  const { applySchema } = await import("./migrate.mjs");
  const { PGlite } = await import("@electric-sql/pglite");
  const fresh = await PGlite.create();
  await Promise.all([applySchema(fresh), applySchema(fresh), applySchema(fresh)]);
  const { rows } = await fresh.query("SELECT count(*)::int AS n FROM schema_version");
  assert.equal(rows[0].n, 5);
  await fresh.close();
});

test("fit ids are 10 URL-safe characters", () => {
  const ids = new Set(Array.from({ length: 500 }, generateFitId));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[0-9A-Za-z]{10}$/);
});

// --- create, read, visibility ---------------------------------------------------------------------

test("a new fit is a draft that only its author (or an admin) can read", async () => {
  const fit = await draft();
  assert.equal(fit.status, "draft");
  assert.equal(fit.publishedAt, null);
  assert.equal(fit.evaluation.valid, true);
  assert.equal((await getFit(db, fit.id, { viewer: ALICE }))?.id, fit.id);
  assert.equal(await getFit(db, fit.id), null);
  assert.equal(await getFit(db, fit.id, { viewer: BOB }), null);
  assert.equal((await getFit(db, fit.id, { viewer: ADMIN }))?.id, fit.id);
  assert.equal((await browse()).fits.length, 0);
});

test("getFit returns the stored open fit and rejects malformed ids without querying", async () => {
  const content = sampleFit();
  const created = await createFit(db, {
    authorUserId: "user_alice", authorName: "alice", title: "x", content, buildSha: SHA,
  });
  assert.deepEqual((await getFit(db, created.id, { viewer: ALICE })).fit, content.fit);
  assert.equal(await getFit(db, "x'; DROP TABLE fits;--"), null);
  assert.equal(await getFit(db, "short"), null);
});

test("publishing needs a valid evaluation for the build", async () => {
  const invalidFit = await draft(ALICE, { evaluation: bad });
  await rejects(publishFit(db, { id: invalidFit.id, authorUserId: "user_alice", buildSha: SHA }), "not_valid");
  const unevaluated = await draft(ALICE, { evaluation: null });
  await rejects(publishFit(db, { id: unevaluated.id, authorUserId: "user_alice", buildSha: SHA }), "not_valid");
  const fine = await draft();
  await rejects(publishFit(db, { id: fine.id, authorUserId: "user_alice", buildSha: SHA2 }), "not_valid");
  const done = await publishFit(db, { id: fine.id, authorUserId: "user_alice", buildSha: SHA });
  assert.equal(done.status, "published");
  assert.ok(done.publishedAt);
  assert.equal((await getFit(db, fine.id)).id, fine.id);
});

test("only the author publishes, and republishing keeps the first publication time", async () => {
  const fit = await draft();
  await rejects(publishFit(db, { id: fit.id, authorUserId: "user_bob", buildSha: SHA }), "forbidden");
  await rejects(publishFit(db, { id: "AAAAAAAAAA", authorUserId: "user_alice", buildSha: SHA }), "not_found");
  const first = await publishFit(db, { id: fit.id, authorUserId: "user_alice", buildSha: SHA });
  assert.equal(await unpublishFit(db, { id: fit.id, authorUserId: "user_bob" }), false);
  assert.equal(await unpublishFit(db, { id: fit.id, authorUserId: "user_alice" }), true);
  assert.equal(await getFit(db, fit.id), null);
  const again = await publishFit(db, { id: fit.id, authorUserId: "user_alice", buildSha: SHA });
  assert.equal(again.publishedAt, first.publishedAt);
});

test("hidden fits vanish from public reads and browse; admins still see them; restoring brings them back", async () => {
  const fit = await published();
  assert.equal(await setFitHidden(db, fit.id, true), true);
  assert.equal(await setFitHidden(db, fit.id, true), false);
  assert.equal(await getFit(db, fit.id), null);
  assert.equal(await getFit(db, fit.id, { viewer: BOB }), null);
  // The author, unlike the public, still finds their hidden fit, labelled, on their own page: to delete it.
  assert.equal((await getFit(db, fit.id, { viewer: ALICE })).status, "hidden");
  assert.equal((await getFit(db, fit.id, { viewer: ADMIN })).status, "hidden");
  assert.equal((await browse()).fits.length, 0);
  assert.equal((await browse(`author=user_alice`)).fits.length, 0);
  assert.equal((await browse(`author=user_alice`, { viewer: BOB })).fits.length, 0);
  assert.deepEqual((await browse(`author=user_alice`, { viewer: ALICE })).fits.map((f) => f.status), ["hidden"]);
  await rejects(updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "sneaky" }), "forbidden");
  await rejects(setVote(db, { fitId: fit.id, userId: "user_bob", voted: true }), "not_found");
  assert.equal(await setFitHidden(db, fit.id, false), true);
  assert.equal((await browse()).fits.length, 1);
});

test("drafts can't be hidden (they are already private)", async () => {
  const fit = await draft();
  assert.equal(await setFitHidden(db, fit.id, true), false);
});

// --- text rules -----------------------------------------------------------------------------------

test("title, description and tag limits are enforced", async () => {
  const make = (over) =>
    createFit(db, { authorUserId: "u", authorName: "n", title: "t", content: sampleFit(), buildSha: SHA, ...over });
  await rejects(make({ title: "   " }), "invalid");
  await rejects(make({ title: "x".repeat(81) }), "invalid");
  await rejects(make({ title: "two\nlines" }), "invalid");
  await make({ title: "x".repeat(80) });
  await make({ title: "é".repeat(80) });
  await rejects(make({ description: "x".repeat(10_001) }), "invalid");
  await make({ description: "x".repeat(10_000) });
  await rejects(make({ tags: ["bad tag"] }), "invalid");
  await rejects(make({ tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }), "invalid");
  await rejects(make({ content: { hullItem: "12x", fit: {} } }), "invalid");
  await rejects(make({ content: { hullItem: "12", fit: [] } }), "invalid");
  const fit = await make({ tags: ["PvP", "pvp", "budget"] });
  assert.deepEqual(fit.tags, ["pvp", "budget"]);
});

// --- update ---------------------------------------------------------------------------------------

test("an author edits text and keeps votes and comments; others can't", async () => {
  const fit = await published();
  await setVote(db, { fitId: fit.id, userId: "user_bob", voted: true });
  await createComment(db, { fitId: fit.id, authorUserId: "user_bob", authorName: "bob", body: "nice" });
  const updated = await updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "Renamed", tags: ["new"] });
  assert.equal(updated.title, "Renamed");
  assert.deepEqual(updated.tags, ["new"]);
  assert.equal(updated.votes, 1);
  assert.equal(updated.comments, 1);
  assert.ok(updated.updatedAt >= fit.updatedAt);
  await rejects(updateFit(db, { id: fit.id, authorUserId: "user_bob", title: "mine now" }), "forbidden");
  await rejects(updateFit(db, { id: "AAAAAAAAAA", authorUserId: "user_alice", title: "x" }), "not_found");
});

test("changing content drops cached evaluations, and a published fit only takes content that validated", async () => {
  const fit = await published();
  await recordEvaluation(db, fit.id, { ...good, buildSha: SHA2 });
  const next = sampleFit("2000");
  await rejects(updateFit(db, { id: fit.id, authorUserId: "user_alice", content: next }), "not_valid");
  await rejects(updateFit(db, { id: fit.id, authorUserId: "user_alice", content: next, evaluation: bad }), "not_valid");
  const updated = await updateFit(db, { id: fit.id, authorUserId: "user_alice", content: next, evaluation: { ...good, rating: 99 } });
  assert.equal(updated.hullItem, "2000");
  assert.equal(updated.evaluation.rating, 99);
  const { rows } = await db.query("SELECT build_sha FROM fit_evaluations WHERE fit_id = $1", [fit.id]);
  assert.deepEqual(rows, [{ build_sha: SHA }]);
  // A draft can take an invalid fit, and then can't be published.
  await unpublishFit(db, { id: fit.id, authorUserId: "user_alice" });
  const broken = await updateFit(db, { id: fit.id, authorUserId: "user_alice", content: sampleFit("3000"), evaluation: bad });
  assert.equal(broken.evaluation.valid, false);
  await rejects(publishFit(db, { id: fit.id, authorUserId: "user_alice", buildSha: SHA }), "not_valid");
});

// --- browse: filters ------------------------------------------------------------------------------

test("browse filters by hull, hull class, role, tags and author", async () => {
  const a = await published(ALICE, { hull: "1000", tags: ["pvp", "budget"] });
  const b = await published(BOB, { hull: "2000", tags: ["pvp"] });
  const c = await published(BOB, { hull: "3000", tags: ["pve"] });
  const ids = async (params) => (await browse(params + "&sort=new")).fits.map((f) => f.id).sort();
  assert.deepEqual(await ids("hull=2000"), [b.id]);
  assert.deepEqual(await ids("class=Frigate"), [a.id, c.id].sort());
  assert.deepEqual(await ids("role=Tank"), [b.id]);
  assert.deepEqual(await ids("class=Frigate&role=Damage"), [c.id]);
  assert.deepEqual(await ids("tag=pvp"), [a.id, b.id].sort());
  assert.deepEqual(await ids("tag=pvp&tag=budget"), [a.id]);
  assert.deepEqual(await ids("author=user_bob"), [b.id, c.id].sort());
  assert.deepEqual(await ids("author=user_bob&tag=pvp"), [b.id]);
  assert.deepEqual(await ids("class=Dreadnought"), []);
  // Without a lookup, a class filter can't match anything rather than matching everything.
  const noLookup = await browseFits(db, { query: parseBrowseParams(new URLSearchParams("class=Frigate")), hulls: undefined });
  assert.deepEqual(noLookup.fits, []);
});

test("an author's page shows their own drafts only to them", async () => {
  await published(ALICE);
  await draft(ALICE, { title: "secret draft" });
  const own = await browse("author=user_alice", { viewer: ALICE });
  assert.deepEqual(own.fits.map((f) => f.status).sort(), ["draft", "published"]);
  assert.equal((await browse("author=user_alice", { viewer: BOB })).fits.length, 1);
  assert.equal((await browse("author=user_alice")).fits.length, 1);
});

test("'works on current build' needs a valid evaluation for that sha", async () => {
  const ok = await published();
  const stale = await published(ALICE, { evaluation: good });
  await recordEvaluation(db, stale.id, { ...bad, buildSha: SHA2 });
  await recordEvaluation(db, ok.id, { ...good, buildSha: SHA2 });
  const onB = await browse("current=1&sort=new", { buildSha: SHA2 });
  assert.deepEqual(onB.fits.map((f) => f.id), [ok.id]);
  assert.equal(onB.fits[0].evaluation.buildSha, SHA2);
  assert.equal((await browse("current=1&sort=new", { buildSha: "build-never" })).fits.length, 0);
  assert.equal((await browse("current=1&sort=new", { buildSha: null })).fits.length, 0);
  // Not filtering: the stale fit is listed, with its failure and its last valid verdict.
  const all = await browse("sort=new", { buildSha: SHA2 });
  const row = all.fits.find((f) => f.id === stale.id);
  assert.equal(row.evaluation.valid, false);
  assert.equal(row.lastValidEvaluation.buildSha, SHA);
});

// --- browse: sort and paging ----------------------------------------------------------------------

test("sorts: top all time, top this week, new, most discussed", async () => {
  const old = await published(ALICE, { title: "old favourite" });
  const fresh = await published(ALICE, { title: "fresh" });
  const chatty = await published(ALICE, { title: "chatty" });
  for (const u of ["u1", "u2", "u3"]) await setVote(db, { fitId: old.id, userId: u, voted: true });
  await setVote(db, { fitId: fresh.id, userId: "u1", voted: true });
  // The old favourite's votes are all from last month.
  await db.query("UPDATE fit_votes SET created_at = now() - interval '30 days' WHERE fit_id = $1", [old.id]);
  for (const body of ["a", "b"]) await createComment(db, { fitId: chatty.id, authorUserId: "u1", authorName: "u", body });
  const hidden = await createComment(db, { fitId: fresh.id, authorUserId: "u1", authorName: "u", body: "hidden one" });
  await setCommentHidden(db, hidden.id, true);

  const order = async (sort) => (await browse(`sort=${sort}`)).fits.map((f) => f.title);
  assert.deepEqual((await order("top-all"))[0], "old favourite");
  assert.deepEqual((await order("top-week"))[0], "fresh");
  assert.deepEqual(await order("new"), ["chatty", "fresh", "old favourite"]);
  assert.equal((await order("discussed"))[0], "chatty");
  const all = await browse("sort=top-all");
  assert.deepEqual(all.fits.map((f) => f.votes), [3, 1, 0]);
  assert.equal((await browse("sort=discussed")).fits.find((f) => f.title === "fresh").comments, 0);
});

for (const sort of ["new", "top-all", "top-week", "discussed"]) {
  test(`paging by cursor is stable and complete (${sort}), including ties`, async () => {
    const ids = [];
    for (let i = 0; i < 11; i++) ids.push((await published(ALICE, { title: `fit ${i}` })).id);
    // Lots of ties: most fits share a vote/comment count, and some share a timestamp.
    for (const id of ids.slice(0, 4)) await setVote(db, { fitId: id, userId: "u1", voted: true });
    for (const id of ids.slice(0, 2)) await setVote(db, { fitId: id, userId: "u2", voted: true });
    for (const id of ids.slice(3, 8)) await createComment(db, { fitId: id, authorUserId: "u1", authorName: "u", body: "hi" });
    await db.query("UPDATE fits SET published_at = '2026-01-01T00:00:00Z' WHERE id = ANY($1)", [ids.slice(2, 9)]);

    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const page = await browse(`sort=${sort}`, { limit: 3, cursor });
      seen.push(...page.fits.map((f) => f.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 4);
    assert.equal(seen.length, 11);
    assert.equal(new Set(seen).size, 11, "no fit repeated");
    assert.deepEqual([...seen].sort(), [...ids].sort(), "no fit skipped");
    // Paged order equals the unpaged order.
    const whole = (await browse(`sort=${sort}`, { limit: 100 })).fits.map((f) => f.id);
    assert.deepEqual(seen, whole);
  });
}

test("a new fit published between pages doesn't shift later pages", async () => {
  for (let i = 0; i < 6; i++) await published(ALICE, { title: `fit ${i}` });
  const first = await browse("sort=new", { limit: 3 });
  const late = await published(ALICE, { title: "late arrival" });
  const second = await browse("sort=new", { limit: 3, cursor: first.nextCursor });
  const seen = [...first.fits, ...second.fits].map((f) => f.id);
  assert.equal(new Set(seen).size, 6);
  assert.ok(!seen.includes(late.id));
  assert.equal(second.nextCursor, null);
});

test("a cursor from another sort or a garbage cursor is ignored, not trusted", async () => {
  for (let i = 0; i < 4; i++) await published();
  const page = await browse("sort=new", { limit: 2 });
  const wrongSort = await browse("sort=top-all", { limit: 2, cursor: page.nextCursor });
  assert.equal(wrongSort.fits.length, 2);
  const junk = await browse("sort=new", { limit: 2, cursor: "!!!not-base64-json" });
  assert.equal(junk.fits.length, 2);
});

test("a crafted cursor reads as the first page instead of failing the query", async () => {
  for (let i = 0; i < 3; i++) await published();
  const first = (await browse("sort=new", { limit: 2 })).fits.map((f) => f.id);
  const crafted = (fields) => Buffer.from(JSON.stringify({ sort: "new", score: 0, at: "2026-10-13 10:00:00+00", id: "abcdefghij", ...fields })).toString("base64url");
  for (const fields of [{ at: "yesterday" }, { at: "2026-02-31 10:00:00+00" }, { score: 2 ** 31 }, { score: -1 }, { id: "x'; --" }]) {
    const page = await browse("sort=new", { limit: 2, cursor: crafted(fields) });
    assert.deepEqual(page.fits.map((f) => f.id), first, JSON.stringify(fields));
  }
});

test("every page of top this week counts the same week", async () => {
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await published(ALICE, { title: `week ${i}` })).id);
  // Votes eight days old at the second request but inside the week of the first.
  await setVote(db, { fitId: ids[3], userId: "u1", voted: true });
  await setVote(db, { fitId: ids[2], userId: "u1", voted: true });
  await setVote(db, { fitId: ids[2], userId: "u2", voted: true });
  const firstAt = new Date(Date.now() + 1_000);
  const first = await browse("sort=top-week", { limit: 2, now: firstAt });
  assert.deepEqual(first.fits.map((f) => f.id), [ids[2], ids[3]]);
  const second = await browse("sort=top-week", { limit: 2, cursor: first.nextCursor, now: new Date(firstAt.getTime() + 8 * 86_400_000) });
  assert.deepEqual(second.fits.map((f) => f.id).sort(), [ids[0], ids[1]].sort(), "nothing repeated or skipped");
});

test("an admin's crafted report cursor reads as the first page", async () => {
  const fit = await published();
  await createReport(db, { targetKind: "fit", targetId: fit.id, reporterUserId: "user_bob", reason: "x" });
  for (const afterId of ["99999999999999999999", "-1", "1e3", "abc"]) {
    assert.equal((await listOpenReports(db, { afterId })).reports.length, 1, afterId);
  }
});

test("the limit is clamped", async () => {
  await published();
  assert.equal((await browse("", { limit: 0 })).fits.length, 1);
  assert.equal((await browse("", { limit: 1_000_000 })).fits.length, 1);
});

// --- votes (Review Focus #3) ----------------------------------------------------------------------

test("a vote is idempotent: voting again changes nothing, and the count is computed from rows", async () => {
  const fit = await published();
  assert.deepEqual(await setVote(db, { fitId: fit.id, userId: "user_bob", voted: true }), { voted: true, votes: 1 });
  assert.deepEqual(await setVote(db, { fitId: fit.id, userId: "user_bob", voted: true }), { voted: true, votes: 1 });
  assert.deepEqual(await setVote(db, { fitId: fit.id, userId: "user_carol", voted: true }), { voted: true, votes: 2 });
  assert.deepEqual(await setVote(db, { fitId: fit.id, userId: "user_bob", voted: false }), { voted: false, votes: 1 });
  assert.deepEqual(await setVote(db, { fitId: fit.id, userId: "user_bob", voted: false }), { voted: false, votes: 1 });
  const { rows } = await db.query("SELECT count(*)::int AS n FROM fit_votes WHERE fit_id = $1", [fit.id]);
  assert.equal(rows[0].n, 1);
  // No stored score anywhere on the fit.
  const columns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'fits'");
  assert.equal(columns.rows.some((c) => /vote|score/.test(c.column_name)), false);
  assert.equal((await getFit(db, fit.id, { viewer: { userId: "user_carol", isAdmin: false } })).viewerVoted, true);
  assert.equal((await getFit(db, fit.id, { viewer: BOB })).viewerVoted, false);
  assert.equal((await getFit(db, fit.id)).votes, 1);
});

test("toggling twice returns to no vote; many toggles end in the right state", async () => {
  const fit = await published();
  assert.deepEqual(await toggleVote(db, { fitId: fit.id, userId: "user_bob" }), { voted: true, votes: 1 });
  assert.deepEqual(await toggleVote(db, { fitId: fit.id, userId: "user_bob" }), { voted: false, votes: 0 });
  for (let i = 0; i < 5; i++) await toggleVote(db, { fitId: fit.id, userId: "user_bob" });
  assert.equal((await getFit(db, fit.id)).votes, 1);
});

test("an author may vote for their own fit, and it counts once", async () => {
  const fit = await published(ALICE);
  await setVote(db, { fitId: fit.id, userId: "user_alice", voted: true });
  await setVote(db, { fitId: fit.id, userId: "user_alice", voted: true });
  await toggleVote(db, { fitId: fit.id, userId: "user_bob" });
  assert.equal((await getFit(db, fit.id)).votes, 2);
});

test("a flood of simultaneous votes from one user still counts once", async () => {
  const fit = await published();
  await Promise.all(Array.from({ length: 8 }, () => setVote(db, { fitId: fit.id, userId: "user_bob", voted: true }).catch(() => {})));
  assert.equal((await getFit(db, fit.id)).votes, 1);
});

test("voting needs a published fit", async () => {
  const fit = await draft();
  await rejects(setVote(db, { fitId: fit.id, userId: "user_bob", voted: true }), "not_found");
  await rejects(setVote(db, { fitId: "AAAAAAAAAA", userId: "user_bob", voted: true }), "not_found");
});

// --- comments -------------------------------------------------------------------------------------

test("comments nest one level; the parent must be a top-level comment of the same fit", async () => {
  const fit = await published();
  const other = await published();
  const top = await createComment(db, { fitId: fit.id, authorUserId: "user_bob", authorName: "bob", body: "first" });
  const reply = await createComment(db, { fitId: fit.id, parentId: top.id, authorUserId: "user_alice", authorName: "alice", body: "thanks" });
  assert.equal(reply.parentId, top.id);
  await rejects(createComment(db, { fitId: fit.id, parentId: reply.id, authorUserId: "u", authorName: "n", body: "too deep" }), "invalid");
  await rejects(createComment(db, { fitId: other.id, parentId: top.id, authorUserId: "u", authorName: "n", body: "wrong fit" }), "invalid");
  await rejects(createComment(db, { fitId: fit.id, parentId: "999999", authorUserId: "u", authorName: "n", body: "no parent" }), "invalid");
  await rejects(createComment(db, { fitId: fit.id, parentId: "1; DROP", authorUserId: "u", authorName: "n", body: "x" }), "invalid");
  const threads = await listComments(db, fit.id);
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].replies.map((r) => r.body), ["thanks"]);
  assert.equal((await getFit(db, fit.id)).comments, 2);
});

test("comment limits, and no comments on a draft or missing fit", async () => {
  const fit = await published();
  const make = (body, id = fit.id) => createComment(db, { fitId: id, authorUserId: "u", authorName: "n", body });
  await rejects(make("   "), "invalid");
  await rejects(make("x".repeat(2001)), "invalid");
  await make("x".repeat(2000));
  const d = await draft();
  await rejects(make("hi", d.id), "not_found");
  await rejects(make("hi", "AAAAAAAAAA"), "not_found");
});

test("only the author edits a comment, and edited_at is set", async () => {
  const fit = await published();
  const comment = await createComment(db, { fitId: fit.id, authorUserId: "user_bob", authorName: "bob", body: "first" });
  assert.equal(comment.editedAt, null);
  await rejects(editComment(db, { id: comment.id, authorUserId: "user_alice", body: "hijack" }), "forbidden");
  await rejects(editComment(db, { id: "424242", authorUserId: "user_bob", body: "x" }), "not_found");
  await rejects(editComment(db, { id: comment.id, authorUserId: "user_bob", body: "" }), "invalid");
  const edited = await editComment(db, { id: comment.id, authorUserId: "user_bob", body: "second" });
  assert.equal(edited.body, "second");
  assert.ok(edited.editedAt);
  await setCommentHidden(db, comment.id, true);
  await rejects(editComment(db, { id: comment.id, authorUserId: "user_bob", body: "third" }), "forbidden");
});

test("hidden comments are excluded from public reads, with their replies, but an admin sees them", async () => {
  const fit = await published();
  const top = await createComment(db, { fitId: fit.id, authorUserId: "u1", authorName: "n", body: "spam" });
  await createComment(db, { fitId: fit.id, parentId: top.id, authorUserId: "u2", authorName: "n", body: "reply to spam" });
  const keep = await createComment(db, { fitId: fit.id, authorUserId: "u3", authorName: "n", body: "good" });
  const badReply = await createComment(db, { fitId: fit.id, parentId: keep.id, authorUserId: "u4", authorName: "n", body: "rude" });
  assert.equal(await setCommentHidden(db, top.id, true), true);
  assert.equal(await setCommentHidden(db, top.id, true), false);
  assert.equal(await setCommentHidden(db, badReply.id, true), true);
  const pub = await listComments(db, fit.id);
  assert.deepEqual(pub.map((t) => t.body), ["good"]);
  assert.deepEqual(pub[0].replies, []);
  const admin = await listComments(db, fit.id, { viewer: ADMIN });
  assert.equal(admin.length, 2);
  assert.equal(admin.flatMap((t) => t.replies).length, 2);
  assert.equal(await setCommentHidden(db, top.id, false), true);
  assert.equal((await listComments(db, fit.id)).length, 2);
  // The comment count shown on the fit ignores hidden comments.
  assert.equal((await getFit(db, fit.id)).comments, 3);
});

// --- reports --------------------------------------------------------------------------------------

test("one open report per reporter and target; a resolved report allows a new one", async () => {
  const fit = await published();
  const first = await createReport(db, { targetKind: "fit", targetId: fit.id, reporterUserId: "user_bob", reason: "spam" });
  assert.equal(first.created, true);
  const dup = await createReport(db, { targetKind: "fit", targetId: fit.id, reporterUserId: "user_bob", reason: "still spam" });
  assert.deepEqual(dup, { id: first.id, created: false });
  const other = await createReport(db, { targetKind: "fit", targetId: fit.id, reporterUserId: "user_carol", reason: "spam" });
  assert.equal(other.created, true);
  assert.equal((await listOpenReports(db)).reports.length, 2);
  assert.equal(await resolveReport(db, first.id), true);
  assert.equal(await resolveReport(db, first.id), false);
  assert.equal((await listOpenReports(db)).reports.length, 1);
  const again = await createReport(db, { targetKind: "fit", targetId: fit.id, reporterUserId: "user_bob", reason: "back" });
  assert.equal(again.created, true);
});

test("reports validate their target and reason, and the queue previews what was reported", async () => {
  const fit = await published(ALICE, { title: "Reported fit" });
  const comment = await createComment(db, { fitId: fit.id, authorUserId: "u1", authorName: "n", body: "bad words here" });
  const file = (over) => createReport(db, { targetKind: "fit", targetId: fit.id, reporterUserId: "user_bob", reason: "r", ...over });
  await rejects(file({ reason: "  " }), "invalid");
  await rejects(file({ reason: "x".repeat(1001) }), "invalid");
  await rejects(file({ targetId: "AAAAAAAAAA" }), "not_found");
  await rejects(file({ targetKind: "comment", targetId: "abc" }), "not_found");
  await rejects(file({ targetKind: "comment", targetId: "99999" }), "not_found");
  const d = await draft();
  await rejects(file({ targetId: d.id }), "not_found");
  await file({});
  await file({ targetKind: "comment", targetId: comment.id });
  const queue = await listOpenReports(db);
  assert.equal(queue.reports.length, 2);
  const [onFit, onComment] = queue.reports;
  assert.deepEqual(onFit.target, { fitId: fit.id, preview: "Reported fit", hidden: false, authorUserId: "user_alice", authorName: "alice" });
  assert.deepEqual(onComment.target, { fitId: fit.id, preview: "bad words here", hidden: false, authorUserId: "u1", authorName: "n" });
  await setCommentHidden(db, comment.id, true);
  assert.equal((await listOpenReports(db)).reports[1].target.hidden, true);
  assert.equal(await resolveReportsForTarget(db, "comment", comment.id), 1);
  assert.equal((await listOpenReports(db)).reports.length, 1);
});

test("the report queue pages by id", async () => {
  const fits = [];
  for (let i = 0; i < 5; i++) fits.push(await published());
  for (const f of fits) await createReport(db, { targetKind: "fit", targetId: f.id, reporterUserId: "user_bob", reason: "r" });
  const first = await listOpenReports(db, { limit: 2 });
  assert.equal(first.reports.length, 2);
  const second = await listOpenReports(db, { limit: 2, afterId: first.nextAfterId });
  const third = await listOpenReports(db, { limit: 2, afterId: second.nextAfterId });
  assert.equal(third.reports.length, 1);
  assert.equal(third.nextAfterId, null);
  assert.equal(new Set([...first.reports, ...second.reports, ...third.reports].map((r) => r.id)).size, 5);
});

// --- evaluations ----------------------------------------------------------------------------------

test("fitsNeedingEvaluation lists published fits without a verdict for the sha, and shrinks as verdicts are recorded", async () => {
  const a = await published();
  const b = await published();
  await draft(); // drafts aren't re-evaluated
  const hidden = await published();
  await setFitHidden(db, hidden.id, true);
  assert.deepEqual(await fitsNeedingEvaluation(db, SHA), []);
  const needing = await fitsNeedingEvaluation(db, SHA2, 10);
  assert.deepEqual(needing.map((f) => f.id).sort(), [a.id, b.id].sort());
  assert.ok(needing[0].fit && needing[0].hullItem && needing[0].revision);
  assert.equal((await fitsNeedingEvaluation(db, SHA2, 1)).length, 1);
  await recordEvaluation(db, a.id, { buildSha: SHA2, valid: false, rating: null, stats: {}, issues: [{ code: "removed_item" }] }, { revision: needing.find((f) => f.id === a.id).revision });
  assert.deepEqual((await fitsNeedingEvaluation(db, SHA2)).map((f) => f.id), [b.id]);
});

test("a valid verdict stored before the engine sent hull specs is asked about again until it has them", async () => {
  const fit = await published();
  assert.ok(!(await fitsNeedingEvaluation(db, SHA)).some((f) => f.id === fit.id));
  await recordEvaluation(db, fit.id, { ...good, stats: { speed: 3 } });
  const [needing] = (await fitsNeedingEvaluation(db, SHA)).filter((f) => f.id === fit.id);
  assert.ok(needing, "an old row without sections is re-checked");
  await recordEvaluation(db, fit.id, good, { revision: needing.revision });
  assert.ok(!(await fitsNeedingEvaluation(db, SHA)).some((f) => f.id === fit.id), "the re-check filled it in");
  // An invalid verdict has no specs to fill in: it isn't asked about again.
  await recordEvaluation(db, fit.id, bad);
  assert.ok(!(await fitsNeedingEvaluation(db, SHA)).some((f) => f.id === fit.id));
});

test("recordEvaluation upserts, and ignores a verdict on content edited since", async () => {
  const fit = await published();
  const [needing] = await fitsNeedingEvaluation(db, SHA2);
  await updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "edited while the job ran" });
  assert.equal(await recordEvaluation(db, fit.id, { ...good, buildSha: SHA2 }, { revision: needing.revision }), false);
  assert.equal((await getFit(db, fit.id, { buildSha: SHA2 })).evaluation, null);
  assert.equal(await recordEvaluation(db, fit.id, { ...good, buildSha: SHA2, rating: 5 }), true);
  assert.equal(await recordEvaluation(db, fit.id, { ...good, buildSha: SHA2, rating: 6 }), true);
  const { evaluation } = await getFit(db, fit.id, { buildSha: SHA2 });
  assert.equal(evaluation.rating, 6);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM fit_evaluations WHERE fit_id = $1 AND build_sha = $2", [fit.id, SHA2]);
  assert.equal(rows[0].n, 1);
  assert.equal(await recordEvaluation(db, "AAAAAAAAAA", good), false);
  await rejects(recordEvaluation(db, fit.id, { ...good, rating: NaN }), "invalid");
});

test("a reply under a hidden comment isn't counted, as it isn't listed", async () => {
  const fit = await published();
  const top = await createComment(db, { fitId: fit.id, authorUserId: "u1", authorName: "n", body: "top" });
  await createComment(db, { fitId: fit.id, parentId: top.id, authorUserId: "u2", authorName: "m", body: "reply" });
  await createComment(db, { fitId: fit.id, authorUserId: "u3", authorName: "o", body: "other" });
  assert.equal((await getFit(db, fit.id)).comments, 3);
  await setCommentHidden(db, top.id, true);
  const listed = (await listComments(db, fit.id)).reduce((n, thread) => n + 1 + thread.replies.length, 0);
  assert.equal(listed, 1);
  assert.equal((await getFit(db, fit.id)).comments, listed);
  assert.equal((await browse("sort=discussed")).fits.find((f) => f.id === fit.id).comments, listed);
});

test("a report resolved between the insert and the read back is filed again", async () => {
  const fit = await published();
  const input = { targetKind: "fit", targetId: fit.id, reporterUserId: "user_bob", reason: "x" };
  const first = await createReport(db, input);
  let resolvedOnce = false;
  const racing = {
    async query(text, params) {
      if (!resolvedOnce && text.includes("SELECT id::text AS id FROM fit_reports")) {
        resolvedOnce = true;
        await db.query("UPDATE fit_reports SET resolved_at = now() WHERE id = $1::bigint", [first.id]);
      }
      return db.query(text, params);
    },
  };
  const again = await createReport(racing, input);
  assert.equal(again.created, true);
  assert.notEqual(again.id, first.id);
});

test("a stale verdict never replaces the one an edit stored for the same build", async () => {
  const fit = await published();
  const fresh = sampleFit("1000");
  // The job reads the fit, then the author edits it and the edit stores its own verdict for the build.
  const [stale] = await fitsNeedingEvaluation(db, SHA2);
  await updateFit(db, { id: fit.id, authorUserId: ALICE.userId, content: fresh, evaluation: { ...good, buildSha: SHA2, rating: 9 } });
  assert.equal(await recordEvaluation(db, fit.id, { ...bad, buildSha: SHA2 }, { revision: stale.revision }), false);
  assert.equal((await getFit(db, fit.id, { buildSha: SHA2 })).evaluation.rating, 9);

  // Interleaved in either order, the edit's verdict is the one left.
  const again = await getFitForEvaluation(db, fit.id);
  await Promise.all([
    recordEvaluation(db, fit.id, { ...bad, buildSha: SHA2 }, { revision: again.revision }),
    updateFit(db, { id: fit.id, authorUserId: ALICE.userId, content: sampleFit("1000"), evaluation: { ...good, buildSha: SHA2, rating: 11 } }),
  ]);
  const { evaluation } = await getFit(db, fit.id, { buildSha: SHA2 });
  assert.equal(evaluation.valid, true);
  assert.equal(evaluation.rating, 11);
});

test("evaluations keep the engine's stats and issues verbatim", async () => {
  const fit = await published();
  const stats = { Speed: "1500", nested: { a: [1, 2] } };
  const issues = [{ code: "removed_item", item: "123" }];
  await recordEvaluation(db, fit.id, { buildSha: SHA2, valid: false, rating: null, stats, issues });
  const { evaluation } = await getFit(db, fit.id, { buildSha: SHA2 });
  assert.deepEqual(evaluation.stats, stats);
  assert.deepEqual(evaluation.issues, issues);
  assert.equal(evaluation.rating, null);
});

test("deleting a fit cascades to its votes, comments and evaluations", async () => {
  const fit = await published();
  await setVote(db, { fitId: fit.id, userId: "u1", voted: true });
  await createComment(db, { fitId: fit.id, authorUserId: "u1", authorName: "n", body: "x" });
  await db.query("DELETE FROM fits WHERE id = $1", [fit.id]);
  for (const table of ["fit_votes", "fit_comments", "fit_evaluations", "fit_revisions"]) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(rows[0].n, 0, table);
  }
});

test("anonymous viewers are the default everywhere", () => {
  assert.deepEqual(ANONYMOUS, { userId: null, isAdmin: false });
});

test("getFitForEvaluation returns stored content and a revision that changes on edit", async () => {
  const d = await draft();
  const before = await getFitForEvaluation(db, d.id);
  assert.equal(before.id, d.id);
  assert.equal(before.hullItem, "1000");
  assert.deepEqual(before.fit, d.fit);
  await updateFit(db, { id: d.id, authorUserId: ALICE.userId, content: sampleFit("1000") });
  const after = await getFitForEvaluation(db, d.id);
  assert.notEqual(after.revision, before.revision);
  // a verdict recorded against the old revision is refused
  assert.equal(await recordEvaluation(db, d.id, good, { revision: before.revision }), false);
  assert.equal(await recordEvaluation(db, d.id, good, { revision: after.revision }), true);
  assert.equal(await getFitForEvaluation(db, "nope"), null);
  assert.equal(await getFitForEvaluation(db, "AAAAAAAAAA"), null);
});

// --- manage your own fits and comments ------------------------------------------------------------

test("unpublish keeps published_at, so a re-publish restores the original publication time", async () => {
  const fit = await published();
  const { rows: before } = await db.query("SELECT published_at FROM fits WHERE id = $1", [fit.id]);
  await setVote(db, { fitId: fit.id, userId: "user_bob", voted: true });
  assert.equal(await unpublishFit(db, { id: fit.id, authorUserId: "user_alice" }), true);
  const { rows: mid } = await db.query("SELECT status, published_at FROM fits WHERE id = $1", [fit.id]);
  assert.equal(mid[0].status, "draft");
  assert.deepEqual(mid[0].published_at, before[0].published_at);
  assert.equal(await unpublishFit(db, { id: fit.id, authorUserId: "user_alice" }), false, "a draft can't be unpublished again");
  await publishFit(db, { id: fit.id, authorUserId: "user_alice", buildSha: SHA });
  const { rows: after } = await db.query("SELECT published_at FROM fits WHERE id = $1", [fit.id]);
  assert.deepEqual(after[0].published_at, before[0].published_at);
  assert.equal((await getFit(db, fit.id, { viewer: ALICE })).votes, 1, "votes were kept");
});

test("a hidden fit can't be unpublished by its author", async () => {
  const fit = await published();
  await setFitHidden(db, fit.id, true);
  assert.equal(await unpublishFit(db, { id: fit.id, authorUserId: "user_alice" }), false);
  assert.equal((await getFit(db, fit.id, { viewer: ADMIN })).status, "hidden");
});

test("deleting a fit takes its votes, comments, evaluations and every report about it or its comments", async () => {
  const fit = await published();
  const other = await published(BOB);
  await setVote(db, { fitId: fit.id, userId: "user_bob", voted: true });
  const top = await createComment(db, { fitId: fit.id, authorUserId: "user_bob", authorName: "bob", body: "hi" });
  const reply = await createComment(db, { fitId: fit.id, parentId: top.id, authorUserId: "user_alice", authorName: "alice", body: "yo" });
  await createReport(db, { targetKind: "fit", targetId: fit.id, reporterUserId: "user_bob", reason: "x" });
  await createReport(db, { targetKind: "comment", targetId: reply.id, reporterUserId: "user_carol", reason: "x" });
  await createReport(db, { targetKind: "fit", targetId: other.id, reporterUserId: "user_alice", reason: "keep" });
  assert.equal(await deleteFit(db, { id: fit.id, authorUserId: "user_alice" }), true);
  assert.equal(await getFit(db, fit.id, { viewer: ADMIN }), null);
  for (const table of ["fit_votes", "fit_comments", "fit_evaluations", "fit_revisions"]) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE fit_id = $1`, [fit.id]);
    assert.equal(rows[0].n, 0, table);
  }
  const { reports } = await listOpenReports(db);
  assert.deepEqual(reports.map((r) => r.targetId), [other.id], "only the other fit's report is left");
  assert.equal((await getFit(db, other.id)).id, other.id);
});

test("only the author deletes a fit, and a draft or hidden fit can be deleted", async () => {
  const fit = await published();
  assert.equal(await deleteFit(db, { id: fit.id, authorUserId: "user_bob" }), false);
  assert.equal(await deleteFit(db, { id: fit.id, authorUserId: "" }), false);
  assert.equal(await deleteFit(db, { id: "../../x", authorUserId: "user_alice" }), false);
  assert.ok(await getFit(db, fit.id));
  await setFitHidden(db, fit.id, true);
  assert.equal(await getFit(db, fit.id, { viewer: BOB }), null);
  assert.equal(await deleteFit(db, { id: fit.id, authorUserId: "user_alice" }), true);
  const d = await draft();
  assert.equal(await deleteFit(db, { id: d.id, authorUserId: "user_alice" }), true);
  assert.equal(await deleteFit(db, { id: d.id, authorUserId: "user_alice" }), false, "already gone");
});

test("deleting a comment with replies leaves a tombstone that never shows its text; without replies it is removed", async () => {
  const fit = await published();
  const top = await createComment(db, { fitId: fit.id, authorUserId: "user_bob", authorName: "bob", body: "secret words" });
  const reply = await createComment(db, { fitId: fit.id, parentId: top.id, authorUserId: "user_alice", authorName: "alice", body: "answer" });
  await createReport(db, { targetKind: "comment", targetId: top.id, reporterUserId: "user_carol", reason: "x" });
  assert.equal(await deleteComment(db, { id: top.id, authorUserId: "user_alice" }), null, "not theirs");
  assert.equal(await deleteComment(db, { id: top.id, authorUserId: "user_bob" }), "tombstoned");
  const [thread] = await listComments(db, fit.id);
  assert.equal(thread.id, top.id);
  assert.equal(thread.body, "");
  assert.ok(thread.deletedAt);
  assert.equal(thread.replies.length, 1);
  assert.equal((await listOpenReports(db)).reports.length, 0, "its open report is resolved");
  assert.equal(await deleteComment(db, { id: top.id, authorUserId: "user_bob" }), null, "a tombstone can't be deleted again");
  await rejects(editComment(db, { id: top.id, authorUserId: "user_bob", body: "back" }), "forbidden");
  await rejects(createReport(db, { targetKind: "comment", targetId: top.id, reporterUserId: "user_carol", reason: "x" }), "not_found");
  // Deleting the last reply takes the tombstone with it.
  assert.equal(await deleteComment(db, { id: reply.id, authorUserId: "user_alice" }), "removed");
  assert.deepEqual(await listComments(db, fit.id), []);
});

test("a comment without replies is removed and its reports are resolved", async () => {
  const fit = await published();
  const top = await createComment(db, { fitId: fit.id, authorUserId: "user_bob", authorName: "bob", body: "oops" });
  await createReport(db, { targetKind: "comment", targetId: top.id, reporterUserId: "user_carol", reason: "x" });
  assert.equal(await deleteComment(db, { id: top.id, authorUserId: "user_bob" }), "removed");
  assert.deepEqual(await listComments(db, fit.id), []);
  const { rows } = await db.query("SELECT resolved_at FROM fit_reports");
  assert.ok(rows[0].resolved_at);
  assert.equal(await deleteComment(db, { id: "abc", authorUserId: "user_bob" }), null);
});

test("a deleted comment can't be replied to and isn't counted", async () => {
  const fit = await published();
  const keep = await createComment(db, { fitId: fit.id, authorUserId: "user_bob", authorName: "bob", body: "stays" });
  const top = await createComment(db, { fitId: fit.id, authorUserId: "user_bob", authorName: "bob", body: "goes" });
  await createComment(db, { fitId: fit.id, parentId: top.id, authorUserId: "user_alice", authorName: "alice", body: "reply" });
  assert.equal((await getFit(db, fit.id)).comments, 3);
  assert.equal(await deleteComment(db, { id: top.id, authorUserId: "user_bob" }), "tombstoned");
  await rejects(createComment(db, { fitId: fit.id, parentId: top.id, authorUserId: "user_carol", authorName: "carol", body: "late" }), "invalid");
  assert.equal((await getFit(db, fit.id)).comments, 2, "the tombstone isn't counted, its reply is");
  await createComment(db, { fitId: fit.id, parentId: keep.id, authorUserId: "user_carol", authorName: "carol", body: "fine" });
});

// ---------------------------------------------------------------------------------------------------
// Fit history

const revisionsOf = async (id) => (await listRevisions(db, id)).map((r) => r.revision);

test("publishing appends revision 1 with the words, content and build; a draft's saves leave no history", async () => {
  const fit = await draft(ALICE, { title: "First words", tags: ["pvp"], description: "d" });
  await updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "Still a draft" });
  assert.deepEqual(await revisionsOf(fit.id), []);
  await publishFit(db, { id: fit.id, authorUserId: "user_alice", buildSha: SHA });
  const revision = await getRevision(db, fit.id, 1);
  assert.equal(revision.title, "Still a draft");
  assert.equal(revision.description, "d");
  assert.deepEqual(revision.tags, ["pvp"]);
  assert.equal(revision.buildSha, SHA);
  assert.equal(revision.note, null);
  assert.equal(revision.hullItem, "1000");
  assert.deepEqual(revision.fit, (await getFit(db, fit.id, { viewer: ALICE })).fit);
  assert.equal(revision.matchesCurrent, true);
});

test("every save of a published fit appends the next revision with a trimmed note, empty stored as null", async () => {
  const fit = await published();
  const other = sampleFit("2000");
  await updateFit(db, { id: fit.id, authorUserId: "user_alice", content: other, evaluation: { ...good, buildSha: SHA2 }, note: "  Swapped the hull  " });
  await updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "Renamed", note: "   " });
  await updateFit(db, { id: fit.id, authorUserId: "user_alice", description: "more" });
  assert.deepEqual(await revisionsOf(fit.id), [4, 3, 2, 1]);
  const [r4, r3, r2, r1] = await Promise.all([4, 3, 2, 1].map((n) => getRevision(db, fit.id, n)));
  assert.equal(r2.note, "Swapped the hull");
  assert.equal(r2.buildSha, SHA2, "the build the new content was checked against");
  assert.equal(r2.hullItem, "2000");
  assert.equal(r3.note, null);
  assert.equal(r3.buildSha, SHA2, "a words-only save keeps the previous revision's build");
  assert.equal(r3.title, "Renamed");
  assert.equal(r4.description, "more");
  assert.equal(r1.hullItem, "1000", "an old revision keeps its own content");
  assert.equal(r1.matchesCurrent, false);
  assert.equal(r4.matchesCurrent, true);
});

test("the note is limited to 200 characters and one line, and a refused note changes nothing", async () => {
  const fit = await published();
  await rejects(updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "Nope", note: "x".repeat(201) }), "invalid");
  await rejects(updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "Nope", note: "a\nb" }), "invalid");
  await updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "Fine", note: "x".repeat(200) });
  assert.deepEqual(await revisionsOf(fit.id), [2, 1]);
  assert.equal((await getFit(db, fit.id)).title, "Fine");
});

test("a refused save of a published fit leaves neither the change nor a revision", async () => {
  const fit = await published();
  await rejects(updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "Broken", content: sampleFit("2000"), evaluation: bad }), "not_valid");
  await rejects(updateFit(db, { id: fit.id, authorUserId: "user_bob", title: "Mine now" }), "forbidden");
  assert.deepEqual(await revisionsOf(fit.id), [1]);
  assert.equal((await getFit(db, fit.id)).title, "A fit");
});

test("publishing a published fit again adds nothing; publishing again after an unpublish appends a revision", async () => {
  const fit = await published();
  await publishFit(db, { id: fit.id, authorUserId: "user_alice", buildSha: SHA });
  assert.deepEqual(await revisionsOf(fit.id), [1]);
  assert.equal(await unpublishFit(db, { id: fit.id, authorUserId: "user_alice" }), true);
  await updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "Edited as a draft" });
  assert.deepEqual(await revisionsOf(fit.id), [1], "draft saves still leave nothing");
  await publishFit(db, { id: fit.id, authorUserId: "user_alice", buildSha: SHA, note: "Back again" });
  assert.deepEqual(await revisionsOf(fit.id), [2, 1]);
  assert.equal((await getRevision(db, fit.id, 2)).title, "Edited as a draft");
  assert.equal((await getRevision(db, fit.id, 2)).note, "Back again");
});

test("a fit published before history existed starts its history at its next save", async () => {
  const fit = await published();
  await db.query("DELETE FROM fit_revisions WHERE fit_id = $1", [fit.id]);
  assert.deepEqual(await revisionsOf(fit.id), []);
  await updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "Next" });
  assert.deepEqual(await revisionsOf(fit.id), [1]);
  assert.equal((await getRevision(db, fit.id, 1)).buildSha, SHA, "falls back to the fit's own build");
});

test("getRevision refuses numbers that are not revisions of the fit", async () => {
  const fit = await published();
  const other = await published(BOB);
  for (const n of [0, -1, 2, 1.5, Number.NaN, 2 ** 40]) assert.equal(await getRevision(db, fit.id, n), null, String(n));
  assert.equal(await getRevision(db, "../../x", 1), null);
  assert.deepEqual(await listRevisions(db, "../../x"), []);
  assert.equal((await getRevision(db, other.id, 1)).title, "A fit");
});

test("deleting a fit deletes its revisions and only its own", async () => {
  const fit = await published();
  const other = await published(BOB);
  await updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "v2" });
  assert.equal(await deleteFit(db, { id: fit.id, authorUserId: "user_alice" }), true);
  assert.deepEqual(await revisionsOf(fit.id), []);
  assert.deepEqual(await revisionsOf(other.id), [1]);
});

test("a draft's save ignores a note it won't store, even one that would be refused on a published fit", async () => {
  const fit = await draft();
  await updateFit(db, { id: fit.id, authorUserId: "user_alice", title: "Still a draft", note: "x".repeat(500) });
  assert.equal((await getFit(db, fit.id, { viewer: ALICE })).title, "Still a draft");
  assert.deepEqual(await revisionsOf(fit.id), []);
});
