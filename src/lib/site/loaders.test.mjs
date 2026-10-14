// Route-level reads on pglite with a stub engine, a dead one, and one that dies mid-session
// (Review Focus #2 and #4: removed items and an engine that is down).
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createCatalogCache } from "../engine/catalog-cache.ts";
import { createEngineClient } from "../engine/client.ts";
import { createEngineMonitor } from "../engine/engine-state.ts";
import { deadEngineUrl, startStubEngine } from "../engine/stub-engine.mjs";
import { ANONYMOUS, createFit, publishFit, setFitHidden, unpublishFit, updateFit } from "../fits/queries.ts";
import { toEvaluationInput } from "../fits/service.ts";
import { FIXTURES } from "../engine/stub-engine.mjs";
import { createTestDb } from "../fits/test-db.mjs";
import { loadAuthor, loadBrowse, loadBuilder, loadFitPage, loadReports } from "./loaders.ts";
import { ALICE, BOB, CURRENT_SHA, seedSite } from "./seed.mjs";
import { setFollow } from "../fits/pilots.ts";

let db;
let ids;
let stub;
let deadUrl;
before(async () => {
  db = await createTestDb();
  ids = await seedSite(db);
  stub = await startStubEngine();
  deadUrl = await deadEngineUrl();
});
after(async () => {
  await stub.close();
  await db.close();
});

function depsFor(url, database = () => ({ status: "ready", db })) {
  const client = createEngineClient({ baseUrl: url });
  return { database, engine: createEngineMonitor(client, { ttlMs: 0 }), catalog: createCatalogCache(client, { recheckMs: 0, retryMs: 0 }) };
}

test("browse lists published fits with hull, author, counts and where each stands on the current build", async () => {
  const data = await loadBrowse(depsFor(stub.url), {}, ANONYMOUS);
  assert.equal(data.status, "ok");
  assert.equal(data.engine.state.status, "up");
  const byId = new Map(data.cards.map((card) => [card.id, card]));
  assert.deepEqual([...byId.keys()].sort(), [ids.showcase, ids.removed, ids.pending].sort(), "drafts stay private");
  const showcase = byId.get(ids.showcase);
  assert.equal(showcase.hullName, "SCARAB");
  assert.equal(showcase.authorName, "ALICE");
  assert.equal(showcase.votes, 2);
  assert.equal(showcase.comments, 2);
  assert.equal(showcase.standing, "current");
  assert.equal(typeof showcase.rating, "number");
  assert.equal(byId.get(ids.removed).standing, "outdated");
  assert.equal(byId.get(ids.pending).standing, "pending");
});

test("browse filters by role, class, tag and the current build", async () => {
  const deps = depsFor(stub.url);
  const ids_ = async (params) => (await loadBrowse(deps, params, ANONYMOUS)).cards.map((card) => card.id).sort();
  assert.equal((await ids_({ role: "Destroyer" })).length, 3, "every seeded fit is a SCARAB, a Destroyer");
  assert.deepEqual(await ids_({ role: "Interceptor" }), []);
  assert.equal((await ids_({ class: "Cruiser" })).length, 3);
  assert.deepEqual(await ids_({ tag: "regalia" }), [ids.removed]);
  assert.deepEqual(await ids_({ current: "1" }), [ids.showcase]);
});

test("a fit page draws its grid from the catalog and its stats from the stored verdict", async () => {
  const data = await loadFitPage(depsFor(stub.url), ids.showcase, ANONYMOUS);
  assert.equal(data.status, "ok");
  assert.equal(data.shown.standing, "current");
  assert.equal(data.shown.referenceIsOld, false);
  assert.ok(data.shown.result.stats.length > 0);
  assert.equal(data.grid.status, "ready");
  const scanner = data.grid.model.modules[3];
  assert.deepEqual(scanner.expansions, [{ row: 6, col: 7 }], "the cipher's cell");
  assert.equal(data.grid.model.modules[10].conduitConnections, 1);
  assert.equal(data.grid.model.modules[11].regalia.setName, "KASSIK'S SEVERANCE");
  assert.equal(data.comments.length, 1);
  assert.equal(data.comments[0].replies.length, 1);
});

test("a fit with a removed item renders, marks that module and shows as outdated (Review Focus #2)", async () => {
  const data = await loadFitPage(depsFor(stub.url), ids.removed, ANONYMOUS);
  assert.equal(data.status, "ok");
  assert.equal(data.shown.standing, "outdated");
  assert.equal(data.shown.referenceIsOld, true, "stats are the last valid build's, for reference");
  assert.ok(data.shown.result.stats.length > 0);
  const removed = data.grid.model.modules[2];
  assert.equal(removed.known, false);
  assert.equal(removed.name, "UNKNOWN ITEM");
  assert.deepEqual(removed.cells, [{ row: 4, col: 6 }]);
  assert.deepEqual(removed.issues.map((issue) => issue.kind), ["UnknownItem"]);
  assert.ok(data.grid.model.modules.filter((m) => m.index !== 2).every((m) => m.known));
});

test("with the engine down after it answered once, pages render from stored verdicts and the held catalog (Review Focus #4)", async () => {
  const flaky = await startStubEngine();
  try {
    const deps = depsFor(flaky.url);
    assert.equal((await loadFitPage(deps, ids.showcase, ANONYMOUS)).engine.state.status, "up");
    flaky.fail(503);
    const page = await loadFitPage(deps, ids.showcase, ANONYMOUS);
    assert.equal(page.status, "ok");
    assert.deepEqual(page.engine.state, { status: "down", buildSha: CURRENT_SHA });
    assert.equal(page.shown.standing, "current", "the last build the engine reported still counts");
    assert.ok(page.shown.result.stats.length > 0);
    assert.equal(page.grid.status, "ready");
    const browse = await loadBrowse(deps, {}, ANONYMOUS);
    assert.equal(browse.status, "ok");
    assert.equal(browse.cards.find((card) => card.id === ids.removed).standing, "outdated");
  } finally {
    await flaky.close();
  }
});

test("with an engine that never answered, a fit page still shows its last valid stats", async () => {
  const page = await loadFitPage(depsFor(deadUrl), ids.showcase, ANONYMOUS);
  assert.equal(page.status, "ok");
  assert.deepEqual(page.engine.state, { status: "down", buildSha: null });
  assert.equal(page.shown.standing, "unknown");
  assert.ok(page.shown.result.stats.length > 0);
  assert.equal(page.grid.status, "no_catalog");
  const browse = await loadBrowse(depsFor(deadUrl), {}, ANONYMOUS);
  assert.equal(browse.status, "ok");
  assert.equal(browse.cards.length, 3);
  assert.equal(browse.cards[0].hullName, "UNKNOWN HULL");
});

test("drafts are their author's; a missing fit is not found", async () => {
  const deps = depsFor(stub.url);
  assert.equal((await loadFitPage(deps, ids.draft, ANONYMOUS)).status, "not_found");
  assert.equal((await loadFitPage(deps, ids.draft, { userId: ALICE.userId, isAdmin: false })).status, "ok");
  assert.equal((await loadFitPage(deps, "nosuchfit0", ANONYMOUS)).status, "not_found");
  assert.equal((await loadFitPage(deps, "../../etc", ANONYMOUS)).status, "not_found");
});

test("an author page lists that author's fits, and their drafts only to them", async () => {
  const deps = depsFor(stub.url);
  const publicView = await loadAuthor(deps, ALICE.userId, {}, ANONYMOUS);
  assert.equal(publicView.status, "ok");
  assert.equal(publicView.pilot.name, "ALICE");
  assert.deepEqual(publicView.cards.map((card) => card.id), [ids.showcase]);
  const own = await loadAuthor(deps, ALICE.userId, {}, { userId: ALICE.userId, isAdmin: false });
  assert.deepEqual(own.cards.map((card) => card.id).sort(), [ids.showcase, ids.draft].sort());
  await db.query("UPDATE fits SET status = 'hidden' WHERE id = $1", [ids.showcase]);
  try {
    const ownHidden = await loadAuthor(deps, ALICE.userId, {}, { userId: ALICE.userId, isAdmin: false });
    assert.deepEqual(ownHidden.cards.map((card) => [card.id, card.status]).sort(), [[ids.draft, "draft"], [ids.showcase, "hidden"]].sort());
    assert.equal((await loadFitPage(deps, ids.showcase, { userId: ALICE.userId, isAdmin: false })).status, "ok", "the author opens their hidden fit");
    assert.equal((await loadFitPage(deps, ids.showcase, ANONYMOUS)).status, "not_found");
    assert.deepEqual((await loadAuthor(deps, ALICE.userId, {}, ANONYMOUS)).cards, []);
  } finally {
    await db.query("UPDATE fits SET status = 'published' WHERE id = $1", [ids.showcase]);
  }
});

test("no database, or one that fails, is an unavailable state, not an error", async () => {
  const none = depsFor(stub.url, () => ({ status: "unavailable" }));
  assert.equal((await loadBrowse(none, {}, ANONYMOUS)).status, "unavailable");
  assert.equal((await loadFitPage(none, ids.showcase, ANONYMOUS)).status, "unavailable");
  assert.equal((await loadReports(none)).status, "unavailable");
  const failing = { query: async () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) };
  const broken = depsFor(stub.url, () => ({ status: "ready", db: failing }));
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    assert.equal((await loadBrowse(broken, {}, ANONYMOUS)).status, "unavailable");
    assert.equal((await loadFitPage(broken, ids.showcase, ANONYMOUS)).status, "unavailable");
    assert.equal((await loadAuthor(broken, ALICE.userId, {}, ANONYMOUS)).status, "unavailable");
  } finally {
    console.error = original;
  }
  assert.ok(errors.every((line) => line.includes("ECONNREFUSED")), "only the error code is logged");
});

test("the admin queue lists open reports with what they point at", async () => {
  const data = await loadReports(depsFor(stub.url));
  assert.equal(data.status, "ok");
  assert.deepEqual(data.reports.map((report) => report.targetKind).sort(), ["comment", "fit"]);
  assert.equal(data.reports.find((report) => report.targetKind === "fit").target.fitId, ids.removed);
});

test("the builder refuses to open a hidden fit", async () => {
  const deps = depsFor(stub.url);
  const alice = { userId: ALICE.userId, isAdmin: false };
  assert.equal((await loadBuilder(deps, { fitId: ids.showcase }, alice)).status, "ok");
  await db.query("UPDATE fits SET status = 'hidden' WHERE id = $1", [ids.showcase]);
  try {
    assert.equal((await loadBuilder(deps, { fitId: ids.showcase }, alice)).status, "forbidden");
  } finally {
    await db.query("UPDATE fits SET status = 'published' WHERE id = $1", [ids.showcase]);
  }
});

test("a pilot page carries the pilot's header; an unknown pilot is not found, except to themself", async () => {
  const deps = depsFor(stub.url);
  const alice = await loadAuthor(deps, ALICE.userId, {}, ANONYMOUS);
  assert.equal(alice.pilot.name, "ALICE");
  assert.equal(alice.pilot.publishedFits, 1);
  assert.equal(alice.pilot.upvotesReceived, 2);
  assert.equal(alice.pilot.topFit.id, ids.showcase);
  assert.equal((await loadAuthor(deps, "user_nobody", {}, ANONYMOUS)).status, "not_found");
  const fresh = await loadAuthor(deps, "user_new", {}, { userId: "user_new", isAdmin: false, name: "NEWBIE" });
  assert.equal(fresh.status, "ok");
  assert.equal(fresh.pilot.name, "NEWBIE");
  assert.deepEqual(fresh.cards, []);
});

test("browse keeps 'from pilots I follow' only for a signed-in reader", async () => {
  const deps = depsFor(stub.url);
  await setFollow(db, { follower: BOB, followeeUserId: ALICE.userId, following: true });
  try {
    const signedOut = await loadBrowse(deps, { following: "1" }, ANONYMOUS);
    assert.equal(signedOut.query.following, false, "dropped, so the form and links don't carry it");
    assert.equal(signedOut.cards.length, 3);
    const bob = await loadBrowse(deps, { following: "1" }, { userId: BOB.userId, isAdmin: false });
    assert.equal(bob.query.following, true);
    assert.deepEqual(bob.cards.map((card) => card.id), [ids.showcase]);
    const own = await loadAuthor(deps, BOB.userId, { following: "1" }, { userId: BOB.userId, isAdmin: false });
    assert.equal(own.query.following, false, "a pilot page lists that pilot's fits whatever the reader follows");
  } finally {
    await setFollow(db, { follower: BOB, followeeUserId: ALICE.userId, following: false });
  }
});

// A published fit of ALICE's with three revisions: its first hull, then a rename, then new content.
async function fitWithHistory() {
  const verdict = { ...toEvaluationInput(FIXTURES.evaluateValid), buildSha: CURRENT_SHA };
  const made = await createFit(db, {
    authorUserId: ALICE.userId,
    authorName: ALICE.name,
    title: "Version one",
    description: "first words",
    tags: ["one"],
    content: { hullItem: FIXTURES.fit.hull.def, fit: FIXTURES.fit },
    buildSha: CURRENT_SHA,
    evaluation: verdict,
  });
  await publishFit(db, { id: made.id, authorUserId: ALICE.userId, buildSha: CURRENT_SHA });
  await updateFit(db, { id: made.id, authorUserId: ALICE.userId, title: "Version two", description: "second words", tags: ["two"], note: "Renamed" });
  const changed = { ...FIXTURES.fit, modules: FIXTURES.fit.modules.slice(0, 1) };
  await updateFit(db, { id: made.id, authorUserId: ALICE.userId, title: "Version three", content: { hullItem: FIXTURES.fit.hull.def, fit: changed }, evaluation: verdict, note: "Dropped modules" });
  return { id: made.id, changed };
}

test("a fit page lists its revisions newest first and shows the latest with stats", async () => {
  const { id } = await fitWithHistory();
  const data = await loadFitPage(depsFor(stub.url), id, ANONYMOUS);
  assert.equal(data.status, "ok");
  assert.deepEqual(data.revisions.map((r) => [r.revision, r.note]), [[3, "Dropped modules"], [2, "Renamed"], [1, null]]);
  assert.equal(data.revision, null);
  assert.equal(data.fit.title, "Version three");
  assert.ok(data.shown.result.stats.length > 0);
});

test("?rev=N shows that revision's words, grid and no stats, and the latest revision keeps its stats", async () => {
  const { id, changed } = await fitWithHistory();
  const old = await loadFitPage(depsFor(stub.url), id, ANONYMOUS, "1");
  assert.equal(old.status, "ok");
  assert.deepEqual(old.revision, { number: 1, of: 3, statsShown: false, note: null, createdAt: old.revisions[2].createdAt });
  assert.equal(old.fit.title, "Version one");
  assert.equal(old.fit.description, "first words");
  assert.deepEqual(old.fit.tags, ["one"]);
  assert.equal(old.shown.reference, null);
  assert.equal(old.grid.status, "ready");
  assert.equal(old.grid.model.modules.length, FIXTURES.fit.modules.length, "the grid draws the revision's own modules");
  const latest = await loadFitPage(depsFor(stub.url), id, ANONYMOUS, "3");
  assert.equal(latest.revision.statsShown, true);
  assert.equal(latest.grid.model.modules.length, changed.modules.length);
  assert.ok(latest.shown.result.stats.length > 0);
});

test("an unknown or malformed ?rev is not found", async () => {
  const { id } = await fitWithHistory();
  const deps = depsFor(stub.url);
  for (const rev of ["4", "0", "-1", "01", "1.5", "1e0", "abc", "", " 1", "1 ", "99999999999", ["1", "2"], 1, null]) {
    assert.equal((await loadFitPage(deps, id, ANONYMOUS, rev)).status, "not_found", JSON.stringify(rev));
  }
  // A fit with no history has no revision to ask for.
  await db.query("DELETE FROM fit_revisions WHERE fit_id = $1", [ids.pending]);
  assert.equal((await loadFitPage(deps, ids.pending, ANONYMOUS)).status, "ok");
  assert.deepEqual((await loadFitPage(deps, ids.pending, ANONYMOUS)).revisions, []);
  assert.equal((await loadFitPage(deps, ids.pending, ANONYMOUS, "1")).status, "not_found");
});

test("revisions follow the fit's visibility: hidden fits and other pilots' drafts never leak them", async () => {
  const { id } = await fitWithHistory();
  const deps = depsFor(stub.url);
  const alice = { userId: ALICE.userId, isAdmin: false };
  const bob = { userId: BOB.userId, isAdmin: false };
  const admin = { userId: "user_admin", isAdmin: true };
  await setFitHidden(db, id, true);
  assert.equal((await loadFitPage(deps, id, ANONYMOUS, "1")).status, "not_found");
  assert.equal((await loadFitPage(deps, id, bob, "1")).status, "not_found");
  assert.equal((await loadFitPage(deps, id, alice, "1")).status, "ok");
  assert.equal((await loadFitPage(deps, id, admin, "2")).status, "ok");
  await setFitHidden(db, id, false);
  await unpublishFit(db, { id, authorUserId: ALICE.userId });
  assert.equal((await loadFitPage(deps, id, ANONYMOUS, "1")).status, "not_found");
  assert.equal((await loadFitPage(deps, id, bob, "1")).status, "not_found");
  const own = await loadFitPage(deps, id, alice, "3");
  assert.equal(own.status, "ok");
  assert.equal(own.revisions.length, 3);
  await publishFit(db, { id, authorUserId: ALICE.userId, buildSha: CURRENT_SHA });
});

test("the builder copies a revision's content when asked, and refuses one the fit doesn't have", async () => {
  const { id, changed } = await fitWithHistory();
  const deps = depsFor(stub.url);
  const latest = await loadBuilder(deps, { copyFrom: id }, ANONYMOUS);
  assert.equal(latest.start.fit.modules.length, changed.modules.length);
  const first = await loadBuilder(deps, { copyFrom: id, rev: "1" }, ANONYMOUS);
  assert.equal(first.start.fit.modules.length, FIXTURES.fit.modules.length);
  assert.deepEqual(first.start.meta.tags, ["one"]);
  assert.deepEqual(first.start.copiedFrom, { id, title: "Version three" }, "the credit names the fit by its id");
  for (const rev of ["9", "0", "x"]) {
    const missing = await loadBuilder(deps, { copyFrom: id, rev }, ANONYMOUS);
    assert.equal(missing.start.fit, null, rev);
    assert.ok(missing.start.note);
  }
  const hidden = await loadBuilder(deps, { copyFrom: ids.draft, rev: "1" }, ANONYMOUS);
  assert.equal(hidden.start.fit, null, "another pilot's draft is not copyable");
});

test("stats show for any revision whose content equals the current fit, and for none when the revision list fails", async () => {
  const { id } = await fitWithHistory();
  // Revision 4 restores revision 1's content: 1 and 4 both equal it, 3 no longer does.
  const verdict = { ...toEvaluationInput(FIXTURES.evaluateValid), buildSha: CURRENT_SHA };
  await updateFit(db, { id, authorUserId: ALICE.userId, content: { hullItem: FIXTURES.fit.hull.def, fit: FIXTURES.fit }, evaluation: verdict, note: "Reverted" });
  const deps = depsFor(stub.url);
  assert.equal((await loadFitPage(deps, id, ANONYMOUS, "1")).revision.statsShown, true, "an older revision equal to the current content");
  assert.equal((await loadFitPage(deps, id, ANONYMOUS, "4")).revision.statsShown, true);
  assert.equal((await loadFitPage(deps, id, ANONYMOUS, "3")).revision.statsShown, false);

  const failing = {
    ...db,
    query: (text, params) => (/FROM fit_revisions WHERE fit_id = \$1 ORDER BY/.test(text) ? Promise.reject(new Error("down")) : db.query(text, params)),
  };
  const broken = await loadFitPage(depsFor(stub.url, () => ({ status: "ready", db: failing })), id, ANONYMOUS, "4");
  assert.equal(broken.status, "ok");
  assert.equal(broken.revision.statsShown, false);
  assert.equal(broken.shown.reference, null);
});

test("the builder treats a repeated rev like the fit page does: copy unavailable, never the latest", async () => {
  const { id } = await fitWithHistory();
  const result = await loadBuilder(depsFor(stub.url), { copyFrom: id, rev: ["1", "2"] }, ANONYMOUS);
  assert.equal(result.start.fit, null);
  assert.ok(result.start.note);
});

test("browse searches by text and module, names the chosen modules, and the author page ignores both", async () => {
  const survey = FIXTURES.fitShowcase.modules[3].item.def; // SURVEY SCANNER
  const bySearch = await loadBrowse(depsFor(stub.url), { q: "scarab cipher" }, ANONYMOUS);
  assert.equal(bySearch.status, "ok");
  assert.deepEqual(bySearch.cards.map((card) => card.title), ["Scarab cipher brawler"]);
  const byModule = await loadBrowse(depsFor(stub.url), { module: [survey, "not-a-def"], q: "scarab" }, ANONYMOUS);
  assert.deepEqual(byModule.cards.map((card) => card.title), ["Scarab cipher brawler"]);
  assert.deepEqual(byModule.selectedModules, [{ def: survey, name: "SURVEY SCANNER" }]);
  const none = await loadBrowse(depsFor(stub.url), { module: "1" }, ANONYMOUS);
  assert.equal(none.cards.length, 0);
  assert.deepEqual(none.selectedModules, [{ def: "1", name: "UNKNOWN MODULE" }]);
  const author = await loadAuthor(depsFor(stub.url), ALICE.userId, { q: "zzz", module: "1" }, ANONYMOUS);
  assert.equal(author.status, "ok");
  assert.ok(author.cards.length > 0);
});
