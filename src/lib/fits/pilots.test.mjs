import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { applySchema } from "./migrate.mjs";
import { createTestDb, sampleFit } from "./test-db.mjs";
import { browseFits, createComment, createFit, getFit, listComments, publishFit, setFitHidden, setVote, FitDataError } from "./queries.ts";
import { getPilotProfile, safeAvatarUrl, setBio, setFollow, upsertPilotAtSignIn, validateBio } from "./pilots.ts";
import { parseBrowseParams } from "./filters.ts";

const SHA = "build-a";
const good = { buildSha: SHA, valid: true, rating: 10, stats: { sections: [] }, issues: [] };
const ALICE = { userId: "user_alice", name: "ALICE" };
const BOB = { userId: "user_bob", name: "BOB" };
const CAROL = { userId: "user_carol", name: "CAROL" };
const viewer = (pilot) => ({ userId: pilot?.userId ?? null, isAdmin: false });

let db;
before(async () => {
  db = await createTestDb();
});
after(() => db.close());
beforeEach(async () => {
  await db.exec("TRUNCATE fits, fit_reports, pilots CASCADE");
});

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => error instanceof FitDataError && error.code === code);
}

async function published(author, title = "A fit") {
  const fit = await createFit(db, { authorUserId: author.userId, authorName: author.name, title, content: sampleFit(), buildSha: SHA, evaluation: good });
  await publishFit(db, { id: fit.id, authorUserId: author.userId, buildSha: SHA });
  return fit;
}

const nameOfIn = async (target, userId) => (await target.query("SELECT name FROM pilots WHERE user_id = $1", [userId])).rows[0]?.name;
const nameOf = (userId) => nameOfIn(db, userId);

// --- migration from copied names ---------------------------------------------------------------

// Puts a database back the way schema 3 left it: names copied onto rows (NOT NULL), no pilots, no foreign keys.
async function rewindToCopiedNames(target) {
  await target.exec(`
    ALTER TABLE fits DROP CONSTRAINT fits_author_pilot_fk;
    ALTER TABLE fit_comments DROP CONSTRAINT fit_comments_author_pilot_fk;
    DROP TABLE pilot_follows;
    DROP TABLE pilot_bans;
    TRUNCATE pilots;
    DELETE FROM schema_version WHERE version >= 4;
    ALTER TABLE fits ADD COLUMN author_name text NOT NULL DEFAULT '';
    ALTER TABLE fit_comments ADD COLUMN author_name text NOT NULL DEFAULT '';
    ALTER TABLE fits ALTER COLUMN author_name DROP DEFAULT;
    ALTER TABLE fit_comments ALTER COLUMN author_name DROP DEFAULT;
  `);
}

// Schema 9 as production has it: pilots and foreign keys exist, the copied names are nullable and NULL.
async function rewindToSchema9(target) {
  await target.exec(`
    DELETE FROM schema_version WHERE version >= 10;
    ALTER TABLE fits ADD COLUMN author_name text;
    ALTER TABLE fit_comments ADD COLUMN author_name text;
  `);
}

const copiedNameColumns = async (target) =>
  (
    await target.query(
      "SELECT table_name, is_nullable FROM information_schema.columns WHERE column_name = 'author_name' AND table_name IN ('fits', 'fit_comments') ORDER BY table_name",
    )
  ).rows;

test("the schema backfills pilots from the names copied onto fits and comments, and drops the copies", async () => {
  const old = await PGlite.create();
  await applySchema(old);
  await rewindToCopiedNames(old);
  await old.exec(`
    INSERT INTO fits (id, author_user_id, author_name, title, hull_item, fit, created_build_sha, status, published_at, created_at)
      VALUES ('aaaaaaaaaa', 'user_alice', 'alice-old', 'Old fit', '1000', '{}', 'sha', 'published', now(), '2026-01-01'),
             ('bbbbbbbbbb', 'user_alice', 'alice-new', 'Newer fit', '1000', '{}', 'sha', 'draft', NULL, '2026-03-01'),
             ('cccccccccc', 'user_bob', 'bob', 'Bob fit', '1000', '{}', 'sha', 'published', now(), '2026-01-01'),
             ('dddddddddd', 'user_dave', 'dave', 'Dave fit', '1000', '{}', 'sha', 'published', now(), '2026-01-01');
    INSERT INTO fit_comments (fit_id, author_user_id, author_name, body, created_at)
      VALUES ('cccccccccc', 'user_alice', 'alice-mid', 'hi', '2026-02-01'),
             ('aaaaaaaaaa', 'user_bob', 'bob-latest', 'yo', '2026-05-01'),
             ('aaaaaaaaaa', 'user_carol', 'carol', 'only commented', '2026-04-01'),
             ('aaaaaaaaaa', 'user_dave', '  ', 'a later blank copy is skipped', '2026-06-01'),
             ('aaaaaaaaaa', 'user_erin', '', 'only blank copies', '2026-06-01');
  `);
  await applySchema(old);
  const { rows } = await old.query("SELECT user_id, name FROM pilots ORDER BY user_id");
  assert.deepEqual(rows, [
    { user_id: "user_alice", name: "alice-new" },
    { user_id: "user_bob", name: "bob-latest" },
    { user_id: "user_carol", name: "carol" },
    { user_id: "user_dave", name: "dave" },
    { user_id: "user_erin", name: "PILOT" },
  ]);
  assert.deepEqual(await copiedNameColumns(old), [], "the copies are gone once the pilots are backfilled");

  // Old rows read through the pilots join.
  const shaped = {
    query: (text, params) => old.query(text, params ? [...params] : undefined),
    transaction: (work) => old.transaction((tx) => work({ query: (text, params) => tx.query(text, params ? [...params] : undefined) })),
  };
  assert.equal((await getFit(shaped, "aaaaaaaaaa")).authorName, "alice-new");
  const comments = await listComments(shaped, "aaaaaaaaaa");
  assert.deepEqual(comments.map((c) => c.authorName).sort(), ["PILOT", "bob-latest", "carol", "dave"]);

  const fresh = await createFit(shaped, { authorUserId: "user_frank", authorName: "FRANK", title: "New code", content: sampleFit(), buildSha: SHA });
  await createComment(shaped, { fitId: "cccccccccc", authorUserId: "user_alice", authorName: "ALICE", body: "new comment" });
  assert.ok(fresh.id);

  // Later starts don't backfill again: renamed pilots keep their names.
  await old.query("UPDATE pilots SET name = 'ALICE' WHERE user_id = 'user_alice'");
  await applySchema(old);
  assert.equal(await nameOfIn(old, "user_alice"), "ALICE");
  assert.equal(await nameOfIn(old, "user_frank"), "FRANK");
  assert.equal((await old.query("SELECT count(*)::int AS n FROM schema_version WHERE version = 4")).rows[0].n, 1);
  assert.deepEqual(await copiedNameColumns(old), []);
  await old.close();
});

test("a schema 9 database (nullable, NULL copies) migrates to 10 and drops them; applying again is a no-op", async () => {
  const target = await PGlite.create();
  await applySchema(target);
  await rewindToSchema9(target);
  await target.exec("INSERT INTO pilots (user_id, name) VALUES ('user_alice', 'ALICE')");
  await target.exec(
    "INSERT INTO fits (id, author_user_id, title, hull_item, fit, created_build_sha) VALUES ('aaaaaaaaaa', 'user_alice', 'Nine', '1000', '{}', 'sha')",
  );
  assert.equal((await copiedNameColumns(target)).length, 2);
  await applySchema(target);
  assert.deepEqual(await copiedNameColumns(target), []);
  assert.equal((await target.query("SELECT count(*)::int AS n FROM fits")).rows[0].n, 1, "rows survive the drop");
  assert.equal(await nameOfIn(target, "user_alice"), "ALICE");
  assert.equal((await target.query("SELECT count(*)::int AS n FROM schema_version WHERE version = 10")).rows[0].n, 1);
  await applySchema(target);
  assert.deepEqual(await copiedNameColumns(target), []);
  assert.deepEqual((await target.query("SELECT max(version)::int AS v FROM schema_version")).rows, [{ v: 10 }]);
  await target.close();
});

test("the backfill holds writes to fits and comments only in the start that records schema 4", async () => {
  const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  // Whether the schema holds writes to fits and fit_comments, seen from inside its transaction.
  const lockModes = async (target) => {
    await target.exec(`BEGIN;\n${schema}`);
    const { rows } = await target.query(
      "SELECT DISTINCT mode FROM pg_locks WHERE relation IN ('fits'::regclass, 'fit_comments'::regclass) AND mode = 'ShareRowExclusiveLock'",
    );
    await target.exec("ROLLBACK");
    return rows.map((row) => row.mode);
  };
  const target = await PGlite.create();
  await applySchema(target);
  assert.deepEqual(await lockModes(target), [], "a database this schema created: no lock on writes");

  await rewindToCopiedNames(target);
  assert.deepEqual(
    await lockModes(target),
    ["ShareRowExclusiveLock"],
    "the first start: the backfill holds writes until the migration commits",
  );
  await applySchema(target);
  assert.deepEqual(await lockModes(target), [], "later starts: no lock on writes");
  await target.close();
});

test("applySchema bounds every lock wait after the advisory lock, for that transaction only", async () => {
  const scripts = [];
  const target = await PGlite.create();
  await applySchema({ exec: (sql) => (scripts.push(sql), target.exec(sql)) });
  assert.match(scripts[0], /^BEGIN;\nSELECT pg_advisory_xact_lock\(\d+\);\nSET LOCAL lock_timeout = '5s';\n/);
  assert.equal((await target.query("SHOW lock_timeout")).rows[0].lock_timeout, "0", "SET LOCAL ends with the migration");
  await target.close();
});

// --- sign-in and the write guard ---------------------------------------------------------------

test("sign-in creates the pilot, then refreshes name and avatar but never the bio", async () => {
  await upsertPilotAtSignIn(db, { userId: ALICE.userId, name: " ALICE ", avatarUrl: "https://img.clerk.com/a.png" });
  let profile = await getPilotProfile(db, ALICE.userId, viewer(null));
  assert.equal(profile.name, "ALICE");
  assert.equal(profile.avatarUrl, "https://img.clerk.com/a.png");
  await setBio(db, { pilot: ALICE, bio: "I fly frigates." });
  await upsertPilotAtSignIn(db, { userId: ALICE.userId, name: "ALICE2", avatarUrl: null });
  profile = await getPilotProfile(db, ALICE.userId, viewer(null));
  assert.equal(profile.name, "ALICE2");
  assert.equal(profile.avatarUrl, null);
  assert.equal(profile.bio, "I fly frigates.");
  await upsertPilotAtSignIn(db, { userId: ALICE.userId, name: "ALICE2", avatarUrl: "javascript:alert(1)" });
  assert.equal((await getPilotProfile(db, ALICE.userId, viewer(null))).avatarUrl, null, "only https is stored");
  await assert.rejects(upsertPilotAtSignIn(db, { userId: "bad id!", name: "x", avatarUrl: null }));
  await assert.rejects(upsertPilotAtSignIn(db, { userId: "user_x", name: "  ", avatarUrl: null }));
});

test("avatar URLs: https only, no credentials, bounded", () => {
  assert.equal(safeAvatarUrl("https://img.clerk.com/eyJ.png?x=1"), "https://img.clerk.com/eyJ.png?x=1");
  for (const bad of ["http://img.clerk.com/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "//img.clerk.com/a.png", "https://u:p@img.clerk.com/a.png", `https://a.com/${"a".repeat(3000)}`, "", null, 42]) {
    assert.equal(safeAvatarUrl(bad), null, String(bad).slice(0, 40));
  }
});

test("a write by a pilot without a row creates it from the session name; names are read from pilots only", async () => {
  const fit = await published(ALICE, "First");
  assert.equal(await nameOf(ALICE.userId), "ALICE");
  // A later write with another session name doesn't rename: sign-in owns the name.
  await createComment(db, { fitId: fit.id, authorUserId: ALICE.userId, authorName: "STALE", body: "note" });
  assert.equal(await nameOf(ALICE.userId), "ALICE");
  // A rename at sign-in shows on every fit and comment at once.
  await upsertPilotAtSignIn(db, { userId: ALICE.userId, name: "ALICE PRIME", avatarUrl: null });
  assert.equal((await getFit(db, fit.id)).authorName, "ALICE PRIME");
  assert.equal((await listComments(db, fit.id))[0].authorName, "ALICE PRIME");
  const page = await browseFits(db, { query: parseBrowseParams({}) });
  assert.equal(page.fits[0].authorName, "ALICE PRIME");
});

// --- profile -----------------------------------------------------------------------------------

test("the profile counts published fits and their upvotes, and names the top fit", async () => {
  assert.equal(await getPilotProfile(db, "user_nobody", viewer(null)), null);
  assert.equal(await getPilotProfile(db, "bad id!", viewer(null)), null);
  const first = await published(ALICE, "First");
  const second = await published(ALICE, "Second");
  const hidden = await published(ALICE, "Hidden");
  await createFit(db, { authorUserId: ALICE.userId, authorName: ALICE.name, title: "Draft", content: sampleFit(), buildSha: SHA });
  let profile = await getPilotProfile(db, ALICE.userId, viewer(null));
  assert.equal(profile.publishedFits, 3);
  assert.equal(profile.upvotesReceived, 0);
  assert.equal(profile.topFit, null, "no top fit until one is upvoted");

  for (const voter of ["u1", "u2"]) await setVote(db, { fitId: second.id, userId: voter, voted: true });
  await setVote(db, { fitId: first.id, userId: "u1", voted: true });
  for (const voter of ["u1", "u2", "u3"]) await setVote(db, { fitId: hidden.id, userId: voter, voted: true });
  await setFitHidden(db, hidden.id, true);
  profile = await getPilotProfile(db, ALICE.userId, viewer(null));
  assert.equal(profile.publishedFits, 2, "hidden fits and drafts don't count");
  assert.equal(profile.upvotesReceived, 3, "upvotes on the hidden fit don't count");
  assert.deepEqual(profile.topFit, { id: second.id, title: "Second", votes: 2 });

  // A tie goes to the earlier published fit.
  await setVote(db, { fitId: first.id, userId: "u2", voted: true });
  assert.equal((await getPilotProfile(db, ALICE.userId, viewer(null))).topFit.id, first.id);
});

// --- follows -----------------------------------------------------------------------------------

test("following is idempotent, counted from rows, and refused for yourself or a pilot who doesn't exist", async () => {
  await published(ALICE);
  const result = await setFollow(db, { follower: BOB, followeeUserId: ALICE.userId, following: true });
  assert.deepEqual(result, { following: true, followers: 1 });
  assert.equal(await nameOf(BOB.userId), "BOB", "the follower's row is created from their session");
  assert.deepEqual(await setFollow(db, { follower: BOB, followeeUserId: ALICE.userId, following: true }), { following: true, followers: 1 });
  await setFollow(db, { follower: CAROL, followeeUserId: ALICE.userId, following: true });

  const seenByBob = await getPilotProfile(db, ALICE.userId, viewer(BOB));
  assert.equal(seenByBob.followers, 2);
  assert.equal(seenByBob.following, 0);
  assert.equal(seenByBob.viewerFollows, true);
  assert.equal((await getPilotProfile(db, ALICE.userId, viewer(null))).viewerFollows, false);
  assert.equal((await getPilotProfile(db, BOB.userId, viewer(null))).following, 1);

  assert.deepEqual(await setFollow(db, { follower: BOB, followeeUserId: ALICE.userId, following: false }), { following: false, followers: 1 });
  assert.deepEqual(await setFollow(db, { follower: BOB, followeeUserId: ALICE.userId, following: false }), { following: false, followers: 1 });

  await rejects(setFollow(db, { follower: ALICE, followeeUserId: ALICE.userId, following: true }), "invalid");
  await rejects(setFollow(db, { follower: BOB, followeeUserId: "user_nobody", following: true }), "not_found");
  await rejects(setFollow(db, { follower: BOB, followeeUserId: "x'; DROP TABLE pilots;--", following: true }), "not_found");
  await assert.rejects(db.query("INSERT INTO pilot_follows (follower_user_id, followee_user_id) VALUES ('user_alice', 'user_alice')"), "the CHECK holds too");
});

test("browse 'from pilots I follow' lists only followed pilots' fits, and is ignored signed out", async () => {
  const alices = await published(ALICE, "Alice fit");
  await published(CAROL, "Carol fit");
  await setFollow(db, { follower: BOB, followeeUserId: ALICE.userId, following: true });
  const query = parseBrowseParams({ following: "1" });
  const signedIn = await browseFits(db, { query, viewer: viewer(BOB) });
  assert.deepEqual(signedIn.fits.map((fit) => fit.id), [alices.id]);
  const nobody = await browseFits(db, { query, viewer: viewer(CAROL) });
  assert.deepEqual(nobody.fits, [], "following no one lists nothing");
  const signedOut = await browseFits(db, { query, viewer: viewer(null) });
  assert.equal(signedOut.fits.length, 2);
});

// --- bio ---------------------------------------------------------------------------------------

test("a bio is plain text up to 500 characters, set only on the pilot's own row", async () => {
  await published(ALICE);
  await published(BOB);
  assert.equal(await setBio(db, { pilot: BOB, bio: "  Line one\r\nline two  " }), "Line one\nline two");
  assert.equal((await getPilotProfile(db, ALICE.userId, viewer(null))).bio, "", "nobody else's bio changes");
  assert.equal(await setBio(db, { pilot: BOB, bio: "é".repeat(500) }), "é".repeat(500));
  await rejects(setBio(db, { pilot: BOB, bio: "x".repeat(501) }), "invalid");
  await rejects(setBio(db, { pilot: BOB, bio: "bell\u0007" }), "invalid");
  assert.equal(await setBio(db, { pilot: BOB, bio: "" }), "", "an empty bio clears it");
  assert.equal(validateBio("<b>hi</b>"), "<b>hi</b>", "kept as text; the view never renders it as HTML");
  // A pilot without a row (a session from before pilots) gets one with the bio.
  assert.equal(await setBio(db, { pilot: CAROL, bio: "new here" }), "new here");
  assert.equal(await nameOf(CAROL.userId), "CAROL");
});
