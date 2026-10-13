// Builder smoke test, below the browser: what the pages load (pglite), the workspace's first render, and
// a fit taken from an empty hull through the reducer, the live evaluation and the save and publish
// actions against the stub engine, with sign-in off (503 and its note) and on (saved, published).
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SIGN_IN_UNAVAILABLE_MESSAGE } from "../../lib/auth-errors.ts";
import { createAuth } from "../../lib/auth-core.ts";
import { createEngineClient } from "../../lib/engine/client.ts";
import { FIXTURES, deadEngineUrl, startStubEngine } from "../../lib/engine/stub-engine.mjs";
import { getFit } from "../../lib/fits/queries.ts";
import { createTestDb } from "../../lib/fits/test-db.mjs";
import { PublicConfigProvider } from "../../lib/public-config.tsx";
import { publishFit, saveFit } from "../../lib/site/actions-core.ts";
import { COPY_UNAVAILABLE, loadBuilder } from "../../lib/site/loaders.ts";
import { ALICE, BOB, seedSite } from "../../lib/site/seed.mjs";
import { createLiveEvaluator } from "./live-evaluation.ts";
import { indexCatalog } from "./rules.ts";
import { initialState, reduce } from "./state.ts";
import { SCARAB, itemNamed } from "./test-catalog.mjs";
import { Workspace } from "./workspace.tsx";

let db;
let ids;
let stub;
let deadUrl;
before(async () => {
  db = await createTestDb();
  stub = await startStubEngine();
  deadUrl = await deadEngineUrl();
});
after(async () => {
  await stub.close();
  await db.close();
});
beforeEach(async () => {
  await db.exec("TRUNCATE fits, fit_reports CASCADE");
  ids = await seedSite(db);
});

const cat = indexCatalog(FIXTURES.catalog);
const ready = () => ({ database: () => ({ status: "ready", db }) });
const viewer = (user) => ({ userId: user?.userId ?? null, isAdmin: false });
const profiles = { [ALICE.userId]: ALICE, [BOB.userId]: BOB };
const authAs = (userId, enabled = true) =>
  createAuth(
    { authEnabled: enabled, adminUserIds: [] },
    { sessionUserId: async () => userId, profile: async (id) => (profiles[id] ? { username: profiles[id].name, firstName: null, lastName: null, publicMetadata: {} } : null) },
  );
const HELD_BUILD = "held0build";
const actionDeps = (auth, engineUrl = stub.url) => ({ database: () => ({ status: "ready", db }), auth, engine: createEngineClient({ baseUrl: engineUrl }), currentBuild: () => HELD_BUILD });

test("the builder pages load a new fit, a copy, and an edit for its author only", async () => {
  const fresh = await loadBuilder(ready(), {}, viewer(null));
  assert.equal(fresh.status, "ok");
  assert.equal(fresh.start.fit, null);

  const copy = await loadBuilder(ready(), { copyFrom: ids.showcase }, viewer(BOB));
  assert.deepEqual(copy.start.fit, FIXTURES.fitShowcase);
  assert.deepEqual(copy.start.copiedFrom, { id: ids.showcase, title: "Scarab cipher brawler" });
  assert.equal(copy.start.fitId, null, "a copy saves as a new fit");
  assert.equal(copy.start.meta.title, "");
  assert.equal((await loadBuilder(ready(), { copyFrom: ids.draft }, viewer(BOB))).start.note, COPY_UNAVAILABLE, "someone else's draft can't be copied");
  assert.equal((await loadBuilder({ database: () => ({ status: "missing" }) }, { copyFrom: ids.showcase }, viewer(BOB))).start.note, COPY_UNAVAILABLE);

  const edit = await loadBuilder(ready(), { fitId: ids.showcase }, viewer(ALICE));
  assert.equal(edit.start.fitId, ids.showcase);
  assert.equal(edit.start.status, "published");
  assert.ok(edit.start.updatedAt);
  assert.equal((await loadBuilder(ready(), { fitId: ids.showcase }, viewer(BOB))).status, "forbidden");
  assert.equal((await loadBuilder(ready(), { fitId: ids.draft }, viewer(BOB))).status, "not_found");
  assert.equal((await loadBuilder(ready(), { fitId: "nosuchfit0" }, viewer(ALICE))).status, "not_found");
  assert.equal((await loadBuilder({ database: () => ({ status: "missing" }) }, { fitId: ids.showcase }, viewer(ALICE))).status, "unavailable");
});

function render(start, auth) {
  const config = { engineUrl: stub.url, clerkPublishableKey: null, authEnabled: auth.enabled };
  return renderToStaticMarkup(h(PublicConfigProvider, { config }, h(Workspace, { cat, start, auth, navigate: { replace() {}, push() {} } })));
}
const NEW = { fitId: null, fit: null, meta: { title: "", description: "", tags: [] }, status: null, updatedAt: null, copiedFrom: null, note: null };

test("the workspace opens on the hull picker, and on a fit draws the grid, palette, inspector and panels", () => {
  const picker = render(NEW, { enabled: false, signedIn: false });
  assert.match(picker, /CHOOSE A HULL/);
  assert.match(picker, /SCARAB/);
  assert.match(picker, /IMPORT A FIT STRING/);

  const html = render({ ...NEW, fit: FIXTURES.fit }, { enabled: false, signedIn: false });
  for (const text of ["ITEMS", "SCARAB fitting grid", "AFFINITY", "INSPECTOR", "STATS", "FIT DETAILS", "EXPORT FIT STRING", "CHECKING"]) assert.ok(html.includes(text), text);
  assert.equal(html.split('data-module="').length - 1, FIXTURES.fit.modules.length);
  assert.ok(html.includes(SIGN_IN_UNAVAILABLE_MESSAGE.replace("'", "&#x27;")), "sign-in off: the save controls give way to the note");
  assert.ok(!html.includes("SAVE DRAFT"));

  const signedOut = render({ ...NEW, fit: FIXTURES.fit }, { enabled: true, signedIn: false });
  assert.match(signedOut, /SIGN IN TO SAVE AND PUBLISH/);
  const signedIn = render({ ...NEW, fit: FIXTURES.fit }, { enabled: true, signedIn: true });
  assert.match(signedIn, /SAVE DRAFT/);
  assert.match(signedIn, />PUBLISH</);
  const editing = render({ ...NEW, fitId: ids.showcase, status: "published", fit: FIXTURES.fitShowcase }, { enabled: true, signedIn: true });
  assert.match(editing, /SAVE CHANGES/);
  assert.doesNotMatch(editing, />PUBLISH</);
});

/** Picks a hull, places a turret by the drag path and evaluates the result with the stub engine. */
async function buildAFit() {
  let state = reduce(cat, initialState(), { type: "start", hull: SCARAB });
  for (const action of [
    { type: "pickUp", def: itemNamed(FIXTURES.catalog, "OMNI REPAIRER TURRET").def },
    { type: "hover", cell: { row: 3, col: 6 } },
    { type: "release" },
    { type: "meta", patch: { title: "Repair picket", tags: ["support"] } },
  ])
    state = reduce(cat, state, action);
  assert.equal(state.fit.modules.length, 1);
  const client = createEngineClient({ baseUrl: stub.url });
  const evaluator = createLiveEvaluator({ onChange() {}, delayMs: 0, evaluate: (fit, signal) => client.evaluate(fit, { signal }) });
  evaluator.request(state.fit);
  for (let i = 0; i < 100 && evaluator.current().status !== "ready"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(evaluator.current().status, "ready");
  assert.equal(evaluator.current().result.response.valid, true);
  evaluator.dispose();
  return state;
}

test("save refuses with 503 while sign-in is off, then saves and publishes for a signed-in author", async () => {
  const state = await buildAFit();
  const input = { fitId: null, ...state.meta, fit: state.fit };

  const off = await saveFit(actionDeps(authAs(ALICE.userId, false)), input);
  assert.deepEqual(off, { ok: false, reason: "auth_unavailable", status: 503, message: SIGN_IN_UNAVAILABLE_MESSAGE });
  assert.equal((await saveFit(actionDeps(authAs(null)), input)).status, 401);

  const saved = await saveFit(actionDeps(authAs(ALICE.userId)), input);
  assert.equal(saved.ok, true);
  assert.equal(saved.fit.status, "draft");
  assert.equal(saved.fit.evaluation, "stored");
  const stored = await getFit(db, saved.fit.fitId, { viewer: viewer(ALICE) });
  assert.deepEqual(stored.fit, state.fit);
  assert.equal(stored.title, "Repair picket");
  assert.deepEqual(stored.tags, ["support"]);

  assert.equal((await saveFit(actionDeps(authAs(BOB.userId)), { ...input, fitId: saved.fit.fitId })).status, 403, "only the author edits");
  const published = await publishFit(actionDeps(authAs(ALICE.userId)), { fitId: saved.fit.fitId });
  assert.deepEqual(published, { ok: true, fitId: saved.fit.fitId });
  assert.equal((await getFit(db, saved.fit.fitId)).status, "published");
});

test("publish is refused with the engine's reasons for an invalid fit, and saving still works with the engine down", async () => {
  const state = await buildAFit();
  // Two modules on one anchor: the stub engine (like the real one) answers Overlap.
  const overlapping = { ...state.fit, modules: [...state.fit.modules, state.fit.modules[0]] };
  const draft = await saveFit(actionDeps(authAs(ALICE.userId)), { fitId: null, ...state.meta, fit: overlapping });
  assert.equal(draft.ok, true, "an invalid fit saves as a draft");
  const refused = await publishFit(actionDeps(authAs(ALICE.userId)), { fitId: draft.fit.fitId });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "invalid_fit");
  assert.equal(refused.status, 409);
  assert.ok(refused.issues.some((issue) => issue.kind === "Overlap"));

  const offline = await saveFit(actionDeps(authAs(ALICE.userId), deadUrl), { fitId: null, ...state.meta, fit: state.fit });
  assert.equal(offline.ok, true);
  assert.equal(offline.fit.evaluation, "skipped");
  assert.equal((await getFit(db, offline.fit.fitId, { viewer: viewer(ALICE) })).createdBuildSha, HELD_BUILD, "the build is the server's, never the browser's");
  const notNow = await publishFit(actionDeps(authAs(ALICE.userId), deadUrl), { fitId: offline.fit.fitId });
  assert.deepEqual([notNow.ok, notNow.reason, notNow.status], [false, "engine", 503]);
});
