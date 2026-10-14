import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { ENGINE_FAILED_MESSAGE, createEngineClient } from "./client.ts";
import { FIXTURES, deadEngineUrl, startStubEngine } from "./stub-engine.mjs";

let stub;
let client;
before(async () => {
  stub = await startStubEngine();
  client = createEngineClient({ baseUrl: stub.url });
});
after(() => stub.close());
beforeEach(() => {
  stub.fail(null);
  stub.route("POST /v1/evaluate", undefined);
  stub.requests.length = 0;
});

const ok = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const err = (result) => {
  assert.equal(result.ok, false, "expected an error result");
  return result.error;
};

test("health returns the build sha", async () => {
  assert.deepEqual(ok(await client.health()), FIXTURES.health);
});

test("catalog returns the catalog and its etag; a matching etag comes back not modified", async () => {
  const first = ok(await client.catalog());
  assert.equal(first.status, "ok");
  assert.equal(first.catalog.buildSha, FIXTURES.catalog.buildSha);
  assert.equal(first.etag, `"${FIXTURES.catalog.buildSha}"`);
  const again = ok(await client.catalog({ ifNoneMatch: first.etag }));
  assert.deepEqual(again, { status: "notModified" });
  assert.equal(stub.requests.at(-1).headers["if-none-match"], first.etag);
});

test("evaluate posts the fit and returns the engine's verdict; an invalid fit is still a successful call", async () => {
  const valid = ok(await client.evaluate(FIXTURES.fit));
  assert.equal(valid.valid, true);
  assert.deepEqual(stub.requests.at(-1).body, { fit: FIXTURES.fit });
  const dup = { ...FIXTURES.fit, modules: [FIXTURES.fit.modules[0], FIXTURES.fit.modules[0]] };
  const invalid = ok(await client.evaluate(dup));
  assert.equal(invalid.valid, false);
  assert.equal(invalid.issues[0].kind, "Overlap");
});

test("import and export round-trip through the engine's shapes", async () => {
  const exported = ok(await client.exportFitString(FIXTURES.fit));
  assert.equal(exported.fitString, FIXTURES.exported.fitString);
  assert.deepEqual(ok(await client.importFitString(exported.fitString)).fit, FIXTURES.imported.fit);
});

test("item facts post the rolled item and return the engine's rows; an unknown item is rejected", async () => {
  assert.deepEqual(ok(await client.itemFacts(FIXTURES.itemFactsRequest.item)), FIXTURES.itemFacts);
  assert.deepEqual(stub.requests.at(-1).body, FIXTURES.itemFactsRequest);
  const unknown = err(await client.itemFacts({ ...FIXTURES.itemFactsRequest.item, def: "1" }));
  assert.equal(unknown.kind, "rejected");
  assert.match(unknown.message, /not a fittable item/);
  const controller = new AbortController();
  controller.abort();
  assert.equal(err(await client.itemFacts(FIXTURES.itemFactsRequest.item, { signal: controller.signal })).kind, "cancelled");
});

test("grid mods post the fit and return what each grid consumable can do; an unreadable fit is rejected", async () => {
  const answer = ok(await client.gridMods(FIXTURES.fit));
  assert.deepEqual(answer, FIXTURES.gridMods);
  const sent = stub.requests.at(-1);
  assert.deepEqual([sent.method, sent.path, sent.body], ["POST", "/v1/grid-mods", { fit: FIXTURES.fit }]);
  // Each listed consumable is one the catalog names, and every target carries at least one result.
  const defs = new Set(FIXTURES.catalog.gridConsumables.map((entry) => entry.def));
  for (const option of answer.consumables) {
    assert.ok(defs.has(option.def), option.def);
    for (const target of option.targets) assert.ok(target.results.length > 0);
  }
  const rejected = err(await client.gridMods({ ...FIXTURES.fit, version: 2 }));
  assert.equal(rejected.kind, "rejected");
  assert.match(rejected.message, /version/);
  stub.fail(429);
  assert.equal(err(await client.gridMods(FIXTURES.fit)).kind, "rateLimited");
  stub.fail(null);
  const controller = new AbortController();
  controller.abort();
  assert.equal(err(await client.gridMods(FIXTURES.fit, { signal: controller.signal })).kind, "cancelled");
  stub.route("POST /v1/grid-mods", (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hello: "world" }));
  });
  try {
    assert.equal(err(await client.gridMods(FIXTURES.fit)).kind, "unavailable");
  } finally {
    stub.route("POST /v1/grid-mods", undefined);
  }
});

test("roll posts the item, tier, seed and line, and returns the engine's roll; refusals, limits and cancels map as elsewhere", async () => {
  const all = ok(await client.roll(FIXTURES.rollRequest));
  assert.deepEqual(all, FIXTURES.roll);
  const sent = stub.requests.at(-1);
  assert.deepEqual([sent.method, sent.path, sent.body], ["POST", "/v1/roll", FIXTURES.rollRequest]);
  // The highest tier when none is asked for, the seed echoed, and nothing but the modifiers changed.
  assert.equal(all.breachTier, FIXTURES.catalog.breachTiers.at(-1).index);
  assert.equal(all.seed, FIXTURES.rollRequest.seed);
  assert.deepEqual({ ...all.item.roll, modifiers: [] }, { ...FIXTURES.rollRequest.item.roll, modifiers: [] });

  const line = ok(await client.roll(FIXTURES.rollLineRequest));
  assert.deepEqual(line, FIXTURES.rollLine);
  assert.deepEqual(line.item.roll.modifiers.slice(1), all.item.roll.modifiers.slice(1));

  const normal = FIXTURES.fit.modules[1].item;
  assert.equal(err(await client.roll({ item: normal })).kind, "rejected");
  assert.equal(err(await client.roll({ item: all.item, breachTier: 99 })).kind, "rejected");
  assert.equal(err(await client.roll({ item: all.item, line: 9 })).kind, "rejected");
  stub.fail(429);
  assert.equal(err(await client.roll(FIXTURES.rollRequest)).kind, "rateLimited");
  stub.fail(null);
  const controller = new AbortController();
  controller.abort();
  assert.equal(err(await client.roll(FIXTURES.rollRequest, { signal: controller.signal })).kind, "cancelled");
  stub.route("POST /v1/roll", (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ item: null, seed: "1" }));
  });
  try {
    assert.equal(err(await client.roll(FIXTURES.rollRequest)).kind, "unavailable");
  } finally {
    stub.route("POST /v1/roll", undefined);
  }
});

test("a 400 is rejected with the engine's message", async () => {
  const e = err(await client.importFitString("nonsense"));
  assert.equal(e.kind, "rejected");
  assert.equal(e.message, FIXTURES.error.error);
  assert.equal(err(await client.evaluate(undefined)).kind, "rejected");
});

test("413, 429 and 5xx map to tooLarge, rateLimited and failed", async () => {
  stub.fail(413);
  assert.equal(err(await client.evaluate(FIXTURES.fit)).kind, "tooLarge");
  stub.fail(429);
  assert.equal(err(await client.evaluate(FIXTURES.fit)).kind, "rateLimited");
  assert.equal(err(await client.catalog()).kind, "rateLimited");
  stub.fail(500);
  assert.equal(err(await client.evaluate(FIXTURES.fit)).kind, "failed");
  stub.fail(503);
  assert.equal(err(await client.health()).kind, "failed");
});

test("a real over-limit body gets the engine's 413", async () => {
  const huge = { ...FIXTURES.fit, pad: "x".repeat(300_000) };
  assert.equal(err(await client.evaluate(huge)).kind, "tooLarge");
});

test("an engine that is down is unavailable, never a throw", async () => {
  const down = createEngineClient({ baseUrl: await deadEngineUrl() });
  for (const result of [
    await down.health(),
    await down.catalog(),
    await down.evaluate(FIXTURES.fit),
    await down.importFitString("x"),
    await down.exportFitString(FIXTURES.fit),
    await down.gridMods(FIXTURES.fit),
    await down.roll(FIXTURES.rollRequest),
  ]) {
    assert.equal(err(result).kind, "unavailable");
  }
});

test("a slow engine times out", async () => {
  stub.route("POST /v1/evaluate", () => {}); // never answers
  const quick = createEngineClient({ baseUrl: stub.url, timeouts: { evaluateMs: 80 } });
  const started = Date.now();
  assert.equal(err(await quick.evaluate(FIXTURES.fit)).kind, "timeout");
  assert.ok(Date.now() - started < 2000);
});

test("no engine URL configured is unavailable", async () => {
  const none = createEngineClient({ baseUrl: null });
  assert.equal(err(await none.evaluate(FIXTURES.fit)).kind, "unavailable");
});

test("a 200 that is not the engine's JSON is unavailable", async () => {
  stub.route("POST /v1/evaluate", (req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>bad gateway page</html>");
  });
  assert.equal(err(await client.evaluate(FIXTURES.fit)).kind, "unavailable");
  stub.route("POST /v1/evaluate", (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hello: "world" }));
  });
  assert.equal(err(await client.evaluate(FIXTURES.fit)).kind, "unavailable");
});

test("a custom fetch that throws something odd still yields a result", async () => {
  const weird = createEngineClient({
    baseUrl: "http://engine.test",
    fetch: () => {
      throw "boom";
    },
  });
  assert.equal(err(await weird.health()).kind, "unavailable");
});

test("a 429's Retry-After (seconds or a date) comes back as retryAfterMs", async () => {
  const { parseRetryAfter } = await import("./client.ts");
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
  // Held to [1 s, 60 s]: "0" or a past date isn't a tight loop, an hour isn't a dead builder.
  assert.equal(parseRetryAfter("0"), 1000);
  assert.equal(parseRetryAfter(new Date(1_000).toUTCString(), 50_000), 1000);
  assert.equal(parseRetryAfter("3600"), 60_000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("soon"), undefined);
  const stub = await startStubEngine({
    "POST /v1/evaluate": (req, res) => {
      res.writeHead(429, { "retry-after": "2", "content-type": "application/json" });
      res.end("{}");
    },
  });
  try {
    const result = await createEngineClient({ baseUrl: stub.url }).evaluate(FIXTURES.fit);
    assert.deepEqual(result.error, { kind: "rateLimited", message: "Too many requests. Wait a moment and try again.", retryAfterMs: 2000 });
  } finally {
    await stub.close();
  }
});

test("the engine's {error:{code,message}} envelope reaches the site; the old string shape still does", async () => {
  const answer = (status, body) => createEngineClient({ baseUrl: "http://engine.test", fetch: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) });
  const envelope = err(await answer(400, { error: { code: "bad_fit", message: "modules[2]: unknown item" } }).evaluate(FIXTURES.fit));
  assert.deepEqual([envelope.kind, envelope.message], ["rejected", "modules[2]: unknown item"]);
  const legacy = err(await answer(400, { error: "version: expected 1" }).evaluate(FIXTURES.fit));
  assert.equal(legacy.message, "version: expected 1");
  const other4xx = err(await answer(422, { error: { code: "x", message: "That hull can't carry this." } }).evaluate(FIXTURES.fit));
  assert.deepEqual([other4xx.kind, other4xx.message], ["rejected", "That hull can't carry this."]);
  const unreadable = err(await answer(404, "nope").evaluate(FIXTURES.fit));
  assert.equal(unreadable.kind, "rejected");
  assert.match(unreadable.message, /rejected/);
});

test("a 5xx is 'failed' (the engine answered), with the engine's text kept out of the message", async () => {
  const boom = createEngineClient({ baseUrl: "http://engine.test", fetch: async () => new Response(JSON.stringify({ error: { code: "internal", message: "NullReferenceException at X" } }), { status: 500 }) });
  const e = err(await boom.evaluate(FIXTURES.fit));
  assert.equal(e.kind, "failed");
  assert.equal(e.message, ENGINE_FAILED_MESSAGE);
});
