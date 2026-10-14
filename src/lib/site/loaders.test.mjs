// Route-level reads on pglite with a stub engine, a dead one, and one that dies mid-session
// (Review Focus #2 and #4: removed items and an engine that is down).
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createCatalogCache } from "../engine/catalog-cache.ts";
import { createEngineClient } from "../engine/client.ts";
import { createEngineMonitor } from "../engine/engine-state.ts";
import { deadEngineUrl, startStubEngine } from "../engine/stub-engine.mjs";
import { ANONYMOUS } from "../fits/queries.ts";
import { createTestDb } from "../fits/test-db.mjs";
import { loadAuthor, loadBrowse, loadFitPage, loadReports } from "./loaders.ts";
import { ALICE, CURRENT_SHA, seedSite } from "./seed.mjs";

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
  assert.equal(publicView.authorName, "ALICE");
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
