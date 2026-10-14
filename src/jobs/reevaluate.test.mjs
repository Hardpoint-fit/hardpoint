import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createEngineClient } from "../lib/engine/client.ts";
import { FIXTURES, deadEngineUrl, startStubEngine } from "../lib/engine/stub-engine.mjs";
import { createFit, publishFit, updateFit } from "../lib/fits/queries.ts";
import { createTestDb, sampleFit } from "../lib/fits/test-db.mjs";
import { describe, runReevaluation } from "./reevaluate.ts";

const OLD = FIXTURES.evaluateValid.buildSha;
const NEW = "feedfacefeedface";
const ALICE = "user_alice";

let db;
let stub;
let engine;
before(async () => {
  db = await createTestDb();
  stub = await startStubEngine();
  engine = createEngineClient({ baseUrl: stub.url });
});
after(async () => {
  await stub.close();
  await db.close();
});
beforeEach(async () => {
  await db.exec("TRUNCATE fits, fit_reports CASCADE");
  stub.requests.length = 0;
  for (const key of ["GET /v1/status", "POST /v1/fits/evaluate"]) stub.route(key, null);
});

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const refusal = (message) => ({ error: { code: "bad_request", message } });

/** The engine at build NEW: /v1/status says so, and every verdict is stamped with it. */
function engineAt(sha, evaluate) {
  stub.route("GET /v1/status", (req, res) => json(res, 200, { ...FIXTURES.status, build: sha }));
  stub.route("POST /v1/fits/evaluate", evaluate ?? ((req, res) => json(res, 200, { ...FIXTURES.evaluateValid, buildSha: sha })));
}

async function publishedFit(title = "A fit", extra = {}) {
  const content = sampleFit();
  Object.assign(content.fit, extra);
  const fit = await createFit(db, {
    authorUserId: ALICE,
    authorName: "alice",
    title,
    content,
    buildSha: OLD,
    evaluation: { buildSha: OLD, valid: true, rating: 5, stats: {}, issues: [] },
  });
  await publishFit(db, { id: fit.id, authorUserId: ALICE, buildSha: OLD });
  return fit;
}

const rows = async (sha) =>
  (await db.query(`SELECT fit_id, valid, rating FROM fit_evaluations WHERE build_sha = $1 ORDER BY fit_id`, [sha])).rows;
const run = (extra = {}) => runReevaluation({ db, engine, log: () => {}, sleep: async () => {}, ...extra });

test("a new build re-evaluates every published fit, and only those", async () => {
  engineAt(NEW);
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push((await publishedFit(`Fit ${i}`)).id);
  const draft = await createFit(db, { authorUserId: ALICE, authorName: "alice", title: "Draft", content: sampleFit(), buildSha: OLD });
  const hidden = await publishedFit("Hidden");
  await db.query(`UPDATE fits SET status = 'hidden' WHERE id = $1`, [hidden.id]);

  const summary = await run({ batchSize: 3 });
  assert.equal(summary.outcome, "done");
  assert.equal(summary.buildSha, NEW);
  assert.equal(summary.evaluated, 7);
  const done = await rows(NEW);
  assert.deepEqual(done.map((r) => r.fit_id).sort(), [...ids].sort());
  assert.ok(!done.some((r) => r.fit_id === draft.id || r.fit_id === hidden.id));
  assert.match(describe(summary), /evaluated 7/);
});

test("a fit whose verdict on this build predates hull specs is checked again, and its specs are stored", async () => {
  engineAt(OLD);
  const fit = await publishedFit("Before hull specs");
  const summary = await run();
  assert.equal(summary.evaluated, 1);
  const { rows: stored } = await db.query(`SELECT stats FROM fit_evaluations WHERE fit_id = $1 AND build_sha = $2`, [fit.id, OLD]);
  assert.deepEqual(stored[0].stats.sections, FIXTURES.evaluateValid.sections);
  assert.equal((await run()).evaluated, 0, "filled in: not asked again");
});

test("a second run for the same build does nothing", async () => {
  engineAt(NEW);
  await publishedFit();
  await publishedFit();
  assert.equal((await run()).evaluated, 2);
  stub.requests.length = 0;
  const again = await run();
  assert.equal(again.outcome, "done");
  assert.equal(again.evaluated, 0);
  assert.deepEqual(stub.requests.map((r) => r.path), ["/v1/status"]);
});

test("an engine that is down leaves the fits and their old verdicts untouched", async () => {
  const fit = await publishedFit();
  const before = await rows(OLD);

  const unreachable = await run({ engine: createEngineClient({ baseUrl: await deadEngineUrl() }) });
  assert.equal(unreachable.outcome, "engine");

  engineAt(NEW, (req, res) => json(res, 500, { error: { code: "internal", message: "boom" } }));
  const failing = await run();
  assert.equal(failing.outcome, "engine");
  assert.equal(failing.evaluated, 0);
  assert.deepEqual(await rows(NEW), []);
  assert.deepEqual(await rows(OLD), before);
  assert.equal((await db.query(`SELECT status FROM fits WHERE id = $1`, [fit.id])).rows[0].status, "published");

  // The next run, with the engine back, finishes the work.
  engineAt(NEW);
  assert.equal((await run()).evaluated, 1);
});

test("an engine that breaks half way keeps what was stored and stops", async () => {
  for (let i = 0; i < 4; i++) await publishedFit(`Fit ${i}`);
  let calls = 0;
  engineAt(NEW, (req, res) => (++calls <= 2 ? json(res, 200, { ...FIXTURES.evaluateValid, buildSha: NEW }) : json(res, 503, {})));
  const summary = await run({ maxInFlight: 1 });
  assert.equal(summary.outcome, "engine");
  assert.equal(summary.evaluated, 2);
  assert.equal((await rows(NEW)).length, 2);
});

test("at most four evaluations are in flight, and four are used", async () => {
  let active = 0;
  let peak = 0;
  engineAt(NEW, async (req, res) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    json(res, 200, { ...FIXTURES.evaluateValid, buildSha: NEW });
  });
  for (let i = 0; i < 12; i++) await publishedFit(`Fit ${i}`);
  const summary = await run({ batchSize: 6 });
  assert.equal(summary.evaluated, 12);
  assert.equal(peak, 4);
});

test("a rate limit waits for Retry-After, then carries on", async () => {
  await publishedFit();
  let limited = 2;
  engineAt(NEW, (req, res) =>
    limited-- > 0 ? json(res, 429, {}, { "retry-after": "3" }) : json(res, 200, { ...FIXTURES.evaluateValid, buildSha: NEW }),
  );
  const waits = [];
  const summary = await run({ sleep: async (ms) => void waits.push(ms) });
  assert.equal(summary.outcome, "done");
  assert.equal(summary.evaluated, 1);
  assert.deepEqual(waits, [3000, 3000]);
});

test("a rate limit that does not lift ends the run after a bounded number of waits", async () => {
  await publishedFit();
  engineAt(NEW, (req, res) => json(res, 429, {}, { "retry-after": "1" }));
  const waits = [];
  const summary = await run({ maxRateLimitWaits: 3, sleep: async (ms) => void waits.push(ms) });
  assert.equal(summary.outcome, "engine");
  assert.equal(waits.length, 3);
  assert.deepEqual(await rows(NEW), []);
});

test("a fit the engine refuses is stored as invalid and does not come back", async () => {
  const bad = await publishedFit("Bad", { Unreadable: true });
  await publishedFit("Good");
  engineAt(NEW, (req, res, body) =>
    body.fit.Unreadable ? json(res, 400, refusal("unreadable")) : json(res, 200, { ...FIXTURES.evaluateValid, buildSha: NEW }),
  );
  const summary = await run();
  assert.equal(summary.outcome, "done");
  assert.equal(summary.rejected, 1);
  assert.equal(summary.evaluated, 1);
  const stored = (await rows(NEW)).find((r) => r.fit_id === bad.id);
  assert.equal(stored.valid, false);
  assert.equal(stored.rating, null);
  assert.equal((await run()).evaluated, 0);
});

test("a fit edited while the engine was checking it is not given the verdict for its old content", async () => {
  const fit = await publishedFit();
  const edited = sampleFit();
  edited.fit.Edited = true;
  let first = true;
  engineAt(NEW, async (req, res) => {
    if (first) {
      first = false;
      // The author saves a new version while this verdict is being computed.
      await updateFit(db, {
        id: fit.id,
        authorUserId: ALICE,
        content: edited,
        evaluation: { buildSha: OLD, valid: true, rating: 9, stats: {}, issues: [] },
      });
    }
    json(res, 200, { ...FIXTURES.evaluateValid, buildSha: NEW, rating: first ? 1 : 2 });
  });
  const summary = await run();
  assert.equal(summary.superseded, 1);
  assert.equal(summary.evaluated, 0);
  assert.deepEqual(await rows(NEW), []);

  // The next run evaluates the new content.
  assert.equal((await run()).evaluated, 1);
  assert.equal(stub.requests.at(-1).body.fit.Edited, true);
  assert.equal((await rows(NEW)).length, 1);
});

test("a run past its time budget stops and leaves the rest", async () => {
  engineAt(NEW);
  for (let i = 0; i < 5; i++) await publishedFit(`Fit ${i}`);
  let clock = 0;
  const summary = await run({ batchSize: 2, maxInFlight: 1, maxRunMs: 100, now: () => (clock += 30) });
  assert.equal(summary.outcome, "time");
  const done = (await rows(NEW)).length;
  assert.ok(done > 0 && done < 5, `stored ${done}`);
});

test("a uniform refusal stores nothing and ends the run as an engine problem", async () => {
  for (let i = 0; i < 8; i++) await publishedFit(`Fit ${i}`);
  engineAt(NEW, (req, res) => json(res, 400, refusal("bad request")));
  const lines = [];
  const summary = await run({ maxInFlight: 1, log: (l) => lines.push(l) });
  assert.equal(summary.outcome, "engine");
  assert.equal(summary.rejected, 0);
  assert.deepEqual(await rows(NEW), []);
  assert.ok(lines.includes("reevaluate: engine-unavailable"));
});

test("one bad fit among good ones is stored invalid with the engine's message", async () => {
  const bad = await publishedFit("Bad", { Unreadable: true });
  for (let i = 0; i < 4; i++) await publishedFit(`Good ${i}`);
  engineAt(NEW, (req, res, body) =>
    body.fit.Unreadable ? json(res, 400, refusal("module 3 is unreadable")) : json(res, 200, { ...FIXTURES.evaluateValid, buildSha: NEW }),
  );
  const summary = await run();
  assert.equal(summary.outcome, "done");
  assert.equal(summary.rejected, 1);
  const issues = (await db.query(`SELECT issues FROM fit_evaluations WHERE fit_id = $1 AND build_sha = $2`, [bad.id, NEW])).rows[0].issues;
  assert.match(issues[0].message, /module 3 is unreadable/);
});

test("workers that hit one rate limit share a single wait", async () => {
  for (let i = 0; i < 4; i++) await publishedFit(`Fit ${i}`);
  let limited = 4;
  engineAt(NEW, (req, res) =>
    limited-- > 0 ? json(res, 429, {}, { "retry-after": "1" }) : json(res, 200, { ...FIXTURES.evaluateValid, buildSha: NEW }),
  );
  const waits = [];
  const summary = await run({
    sleep: async (ms) => {
      waits.push(ms);
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  });
  assert.equal(summary.evaluated, 4);
  assert.equal(summary.rateLimitWaits, 1);
  assert.equal(waits.length, 1);
});

const brokenFor = async (fitId) =>
  (await db.query(`SELECT user_id, kind, build_sha FROM notifications WHERE fit_id = $1 ORDER BY id`, [fitId])).rows;
/** The engine at `sha` finds fits marked `Breaks` invalid and every other fit valid. */
const breaksAt = (sha) => (req, res, body) =>
  json(res, 200, { ...(body.fit.Breaks ? FIXTURES.evaluateInvalid : FIXTURES.evaluateValid), buildSha: sha });

test("a fit that was valid and is invalid on the new build tells its author once, however often the job runs", async () => {
  const broken = await publishedFit("Soon broken", { Breaks: true });
  const fine = await publishedFit("Still fine");
  engineAt(NEW, breaksAt(NEW));
  await run();
  await run();
  assert.deepEqual(await brokenFor(broken.id), [{ user_id: ALICE, kind: "fit_broken", build_sha: NEW }]);
  assert.deepEqual(await brokenFor(fine.id), []);
  // A later build that still fails it is not news; one that passes and then fails again is.
  engineAt("0badc0de", breaksAt("0badc0de"));
  await run();
  assert.equal((await brokenFor(broken.id)).length, 1);
});

test("a fit that was already invalid on the earlier build tells nobody when the next build is invalid too", async () => {
  const fit = await publishedFit("Always broken", { Breaks: true });
  await db.query(`UPDATE fit_evaluations SET valid = false WHERE fit_id = $1`, [fit.id]);
  engineAt(NEW, breaksAt(NEW));
  await run();
  assert.deepEqual(await brokenFor(fit.id), []);
});

test("a draft or hidden fit is not evaluated, so nothing is said about it", async () => {
  const hidden = await publishedFit("Hidden", { Breaks: true });
  await db.query(`UPDATE fits SET status = 'hidden' WHERE id = $1`, [hidden.id]);
  engineAt(NEW, breaksAt(NEW));
  await run();
  assert.deepEqual(await brokenFor(hidden.id), []);
});
