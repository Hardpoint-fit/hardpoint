import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createEngineClient } from "../engine/client.ts";
import { FIXTURES, deadEngineUrl, startStubEngine } from "../engine/stub-engine.mjs";
import { getFit, updateFit } from "./queries.ts";
import { publish, reevaluate, saveDraft, toEvaluationInput } from "./service.ts";
import { createTestDb } from "./test-db.mjs";

const SHA = FIXTURES.evaluateValid.buildSha;
const ALICE = { authorUserId: "user_alice", authorName: "alice" };
const AS_ALICE = { userId: "user_alice", isAdmin: false };
const FIT = FIXTURES.fit;
const OVERLAPPING = { ...FIT, modules: [FIT.modules[0], FIT.modules[0]] };

let db;
let stub;
let up;
let down;
before(async () => {
  db = await createTestDb();
  stub = await startStubEngine();
  up = createEngineClient({ baseUrl: stub.url });
  down = createEngineClient({ baseUrl: await deadEngineUrl() });
});
after(async () => {
  await stub.close();
  await db.close();
});
beforeEach(async () => {
  await db.exec("TRUNCATE fits, fit_reports CASCADE");
  stub.requests.length = 0;
});

const read = (id, buildSha = SHA) => getFit(db, id, { viewer: AS_ALICE, buildSha });
const draft = async (fit = FIT, engine = up) => {
  const result = await saveDraft({ db, engine }, { ...ALICE, title: "A fit", fit });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};

test("toEvaluationInput keeps the verdict and the computed stats, and drops the rating of an invalid fit", () => {
  const valid = toEvaluationInput(FIXTURES.evaluateValid);
  assert.equal(valid.valid, true);
  assert.equal(valid.rating, FIXTURES.evaluateValid.rating);
  assert.deepEqual(Object.keys(valid.stats).sort(), ["conduits", "regaliaSets", "sections", "stats"]);
  assert.deepEqual(valid.stats.sections, FIXTURES.evaluateValid.sections, "hull specs are kept for the fit page");
  assert.ok(valid.stats.sections.length > 0);
  const invalid = toEvaluationInput(FIXTURES.evaluateInvalid);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.rating, null);
  assert.equal(invalid.issues[0].kind, "Overlap");
  assert.deepEqual(invalid.stats.sections, [], "an invalid fit has none, and still records that it was asked");
});

test("saveDraft stores the fit with the engine's verdict", async () => {
  const result = await draft();
  assert.equal(result.evaluation, "stored");
  assert.equal(result.engineError, null);
  assert.equal(result.fit.status, "draft");
  assert.equal(result.fit.hullItem, FIT.hull.def);
  assert.equal(result.fit.createdBuildSha, SHA);
  assert.equal(result.fit.evaluation.valid, true);
  assert.equal(result.fit.evaluation.rating, FIXTURES.evaluateValid.rating);
  assert.equal(result.fit.evaluation.stats.stats.length, FIXTURES.evaluateValid.stats.length);
  assert.deepEqual(result.fit.fit, FIT);
});

test("saveDraft with the engine down still stores the fit, with no evaluation", async () => {
  const result = await saveDraft({ db, engine: down }, { ...ALICE, title: "Offline", fit: FIT, buildSha: "catalog-build" });
  assert.equal(result.ok, true);
  assert.equal(result.evaluation, "skipped");
  assert.equal(result.engineError.kind, "unavailable");
  assert.equal(result.fit.status, "draft");
  assert.equal(result.fit.createdBuildSha, "catalog-build");
  const stored = await read(result.fit.id, "catalog-build");
  assert.equal(stored.evaluation, null);
  assert.equal(stored.lastValidEvaluation, null);
  assert.deepEqual(stored.fit, FIT);
});

test("saveDraft with the engine down and no build still saves", async () => {
  const result = await saveDraft({ db, engine: down }, { ...ALICE, title: "Offline", fit: FIT });
  assert.equal(result.ok, true);
  assert.equal(result.fit.createdBuildSha, "unknown");
});

test("saveDraft keeps an illegal fit as a draft, with its issues", async () => {
  const result = await draft(OVERLAPPING);
  assert.equal(result.evaluation, "stored");
  assert.equal(result.fit.evaluation.valid, false);
  assert.equal(result.fit.evaluation.rating, null);
  assert.equal(result.fit.evaluation.issues[0].kind, "Overlap");
});

test("saveDraft refuses bad metadata with the data layer's message instead of throwing", async () => {
  const result = await saveDraft({ db, engine: up }, { ...ALICE, title: "x".repeat(81), fit: FIT });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  const noContent = await saveDraft({ db, engine: up }, { ...ALICE, title: "No loadout" });
  assert.equal(noContent.ok, false);
  assert.equal(noContent.reason, "invalid");
});

test("editing a draft: new content replaces the old verdict, a metadata edit keeps it", async () => {
  const { fit } = await draft();
  const meta = await saveDraft({ db, engine: up }, { ...ALICE, fitId: fit.id, title: "Renamed" });
  assert.equal(meta.ok, true);
  assert.equal(meta.evaluation, "skipped");
  assert.equal(meta.fit.title, "Renamed");
  assert.equal((await read(fit.id)).evaluation.valid, true, "same content, same verdict");
  assert.equal(stub.requests.filter((r) => r.path === "/v1/fits/evaluate").length, 1, "no API call without new content");

  const changed = await saveDraft({ db, engine: down }, { ...ALICE, fitId: fit.id, title: "Renamed", fit: OVERLAPPING });
  assert.equal(changed.ok, true);
  assert.equal(changed.evaluation, "skipped");
  assert.equal(changed.fit.evaluation, null, "the old verdict belonged to the old content");
  assert.deepEqual(changed.fit.fit, OVERLAPPING);
});

test("saveDraft refuses someone else's fit and a missing one", async () => {
  const { fit } = await draft();
  const stolen = await saveDraft({ db, engine: up }, { authorUserId: "user_bob", authorName: "bob", fitId: fit.id, title: "Mine now" });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.reason, "forbidden");
  const missing = await saveDraft({ db, engine: up }, { ...ALICE, fitId: "AAAAAAAAAA", title: "Ghost" });
  assert.equal(missing.reason, "not_found");
});

test("publish checks the fit with the engine and publishes a valid one", async () => {
  const { fit } = await draft();
  stub.requests.length = 0;
  const result = await publish({ db, engine: up }, { fitId: fit.id, authorUserId: ALICE.authorUserId });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.fit.status, "published");
  assert.equal(result.fit.evaluation.buildSha, SHA);
  assert.equal(stub.requests.filter((r) => r.path === "/v1/fits/evaluate").length, 1, "evaluated again, not trusted from the draft");
});

test("publish refuses cleanly when the engine is down, even if the draft has a valid verdict", async () => {
  const { fit } = await draft(); // stored with a valid verdict from a working engine
  const result = await publish({ db, engine: down }, { fitId: fit.id, authorUserId: ALICE.authorUserId });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "engine");
  assert.equal(result.engineError.kind, "unavailable");
  assert.match(result.message, /engine/i);
  assert.match(result.message, /draft is saved/i);
  assert.equal((await read(fit.id)).status, "draft");
});

test("publish refuses a draft saved while the engine was down, then works once it is back", async () => {
  const { fit } = await draft(FIT, down);
  assert.equal(fit.evaluation, null);
  const refused = await publish({ db, engine: down }, { fitId: fit.id, authorUserId: ALICE.authorUserId });
  assert.equal(refused.reason, "engine");
  assert.equal((await read(fit.id)).status, "draft");
  const published = await publish({ db, engine: up }, { fitId: fit.id, authorUserId: ALICE.authorUserId });
  assert.equal(published.ok, true);
  assert.equal(published.fit.evaluation.valid, true);
});

test("publish refuses an illegal fit, stores the verdict, and returns the issues", async () => {
  const { fit } = await draft(OVERLAPPING, down);
  const result = await publish({ db, engine: up }, { fitId: fit.id, authorUserId: ALICE.authorUserId });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_fit");
  assert.equal(result.issues[0].kind, "Overlap");
  const stored = await read(fit.id);
  assert.equal(stored.status, "draft");
  assert.equal(stored.evaluation.valid, false);
});

test("publish refuses other people's fits and missing fits", async () => {
  const { fit } = await draft();
  const bob = await publish({ db, engine: up }, { fitId: fit.id, authorUserId: "user_bob" });
  assert.equal(bob.ok, false);
  assert.equal(bob.reason, "not_found", "a draft is invisible to others");
  const missing = await publish({ db, engine: up }, { fitId: "AAAAAAAAAA", authorUserId: ALICE.authorUserId });
  assert.equal(missing.reason, "not_found");
  assert.equal((await read(fit.id)).status, "draft");
});

test("publish does not store a verdict for content the author changed while the engine was thinking", async () => {
  const { fit } = await draft();
  const racing = {
    evaluate: async (sent) => {
      // the author edits the fit while this evaluation is in flight
      await updateFit(db, { id: fit.id, authorUserId: ALICE.authorUserId, content: { hullItem: FIT.hull.def, fit: OVERLAPPING } });
      return up.evaluate(sent);
    },
  };
  const result = await publish({ db, engine: racing }, { fitId: fit.id, authorUserId: ALICE.authorUserId });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_valid");
  const stored = await read(fit.id);
  assert.equal(stored.status, "draft");
  assert.equal(stored.evaluation, null);
});

test("editing a published fit needs the engine: down or illegal is refused, legal is accepted", async () => {
  const { fit } = await draft();
  await publish({ db, engine: up }, { fitId: fit.id, authorUserId: ALICE.authorUserId });
  const offline = await saveDraft({ db, engine: down }, { ...ALICE, fitId: fit.id, title: "A fit", fit: OVERLAPPING });
  assert.equal(offline.ok, false);
  assert.equal(offline.reason, "not_valid");
  const illegal = await saveDraft({ db, engine: up }, { ...ALICE, fitId: fit.id, title: "A fit", fit: OVERLAPPING });
  assert.equal(illegal.reason, "not_valid");
  const same = await saveDraft({ db, engine: up }, { ...ALICE, fitId: fit.id, title: "Retitled", fit: FIT });
  assert.equal(same.ok, true);
  assert.equal(same.fit.status, "published");
  assert.equal(same.fit.evaluation.valid, true);
});

test("reevaluate stores the engine's verdict for the current build, valid or not", async () => {
  const { fit } = await draft(OVERLAPPING, down);
  const result = await reevaluate({ db, engine: up }, fit.id);
  assert.equal(result.ok, true);
  assert.equal(result.recorded, true);
  assert.equal(result.evaluation.valid, false);
  assert.equal((await read(fit.id)).evaluation.valid, false);
});

test("reevaluate with the engine down changes nothing", async () => {
  const { fit } = await draft();
  const result = await reevaluate({ db, engine: down }, fit.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "engine");
  assert.equal((await read(fit.id)).evaluation.valid, true);
  assert.equal((await reevaluate({ db, engine: up }, "AAAAAAAAAA")).reason, "not_found");
});

test("reevaluate drops a verdict for content edited meanwhile", async () => {
  const { fit } = await draft(FIT, down);
  const racing = {
    evaluate: async (sent) => {
      await updateFit(db, { id: fit.id, authorUserId: ALICE.authorUserId, content: { hullItem: FIT.hull.def, fit: OVERLAPPING } });
      return up.evaluate(sent);
    },
  };
  const result = await reevaluate({ db, engine: racing }, fit.id);
  assert.equal(result.ok, true);
  assert.equal(result.recorded, false);
  assert.equal((await read(fit.id)).evaluation, null);
});
