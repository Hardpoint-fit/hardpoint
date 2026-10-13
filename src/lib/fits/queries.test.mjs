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
  editComment,
  fitsNeedingEvaluation,
  generateFitId,
  getFit,
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

const good = { buildSha: SHA, valid: true, rating: 10, stats: { speed: 3 }, issues: [] };
const bad = { buildSha: SHA, valid: false, rating: null, stats: {}, issues: [{ code: "removed_item" }] };

let db;
before(async () => {
  db = await createTestDb();
});
after(() => db.close());
beforeEach(async () => {
  await db.exec("TRUNCATE fits, fit_reports CASCADE");
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

test("applying the schema again is a no-op, and schema_version records version 1 once", async () => {
  const { applySchema } = await import("./migrate.mjs");
  await applySchema(db);
  await applySchema(db);
  const { rows } = await db.query("SELECT version FROM schema_version");
  assert.deepEqual(rows, [{ version: 1 }]);
});

test("concurrent applies on a fresh database all succeed", async () => {
  const { applySchema } = await import("./migrate.mjs");
  const { PGlite } = await import("@electric-sql/pglite");
  const fresh = await PGlite.create();
  await Promise.all([applySchema(fresh), applySchema(fresh), applySchema(fresh)]);
  const { rows } = await fresh.query("SELECT count(*)::int AS n FROM schema_version");
  assert.equal(rows[0].n, 1);
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
  assert.equal(await getFit(db, fit.id, { viewer: ALICE }), null);
  assert.equal((await getFit(db, fit.id, { viewer: ADMIN })).status, "hidden");
  assert.equal((await browse()).fits.length, 0);
  assert.equal((await browse(`author=user_alice`, { viewer: ALICE })).fits.length, 0);
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
  assert.deepEqual(onFit.target, { fitId: fit.id, preview: "Reported fit", hidden: false });
  assert.deepEqual(onComment.target, { fitId: fit.id, preview: "bad words here", hidden: false });
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
  for (const table of ["fit_votes", "fit_comments", "fit_evaluations"]) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(rows[0].n, 0, table);
  }
});

test("anonymous viewers are the default everywhere", () => {
  assert.deepEqual(ANONYMOUS, { userId: null, isAdmin: false });
});
