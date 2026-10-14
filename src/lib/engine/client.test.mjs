import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { CATALOG_ROUTES } from "./catalog-resources.ts";
import { createEngineClient } from "./client.ts";
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
  for (const key of ["POST /v1/fits/evaluate", "GET /v1/qualities", "GET /v1/items"]) stub.route(key, undefined);
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

const catalogPaths = () => stub.requests.filter((r) => r.path !== "/v1/status").map((r) => r.path).sort();
const routePaths = Object.values(CATALOG_ROUTES).map((route) => route.path).sort();

test("status returns the live build", async () => {
  assert.deepEqual(ok(await client.status()), FIXTURES.status);
  assert.equal(stub.requests.at(-1).path, "/v1/status");
  assert.match(stub.requests.at(-1).headers["user-agent"], /^hardpoint\.fit \(/, "the server names itself, as the API asks");
});

test("the catalog is read from the resource routes and assembled, with its art URLs made absolute", async () => {
  const first = ok(await client.catalog());
  assert.equal(first.status, "ok");
  assert.deepEqual(catalogPaths(), routePaths, "one request per resource route");
  assert.equal(first.catalog.buildSha, FIXTURES.status.build);
  assert.equal(first.catalog.items.length, FIXTURES.parts.items.items.length);
  assert.deepEqual(first.catalog.placement, FIXTURES.parts.placementRules.placementRules);
  assert.match(first.etag, /^"[0-9a-f]{64}"$/);
  // The client was given the stub as its only address, so that is the art origin.
  const { art } = first.catalog.items[0];
  assert.ok(art.base.startsWith(`${stub.url}/v1/art/`) && art.base.endsWith(".webp"), art.base);
  assert.equal(art.base, `${stub.url}${FIXTURES.parts.items.items[0].art.base}`);
  assert.equal(first.catalog.artifacts.find((artifact) => artifact.art === null)?.art, null, "an artifact without an icon keeps null");
});

test("the catalog's etag changes with the art origin, so browsers drop a copy with old art URLs", async () => {
  const one = ok(await createEngineClient({ baseUrl: stub.url, artBaseUrl: "https://api.thecitadel.com" }).catalog());
  const same = ok(await createEngineClient({ baseUrl: stub.url, artBaseUrl: "https://api.thecitadel.com" }).catalog());
  const moved = ok(await createEngineClient({ baseUrl: stub.url, artBaseUrl: "https://api.example.test" }).catalog());
  assert.equal(same.etag, one.etag);
  assert.notEqual(moved.etag, one.etag);
});

test("art URLs use the public API origin, not the address the server calls", async () => {
  const split = createEngineClient({ baseUrl: stub.url, artBaseUrl: "https://api.thecitadel.com" });
  const { catalog } = ok(await split.catalog());
  assert.ok(catalog.hulls.every((hull) => hull.art.base.startsWith("https://api.thecitadel.com/v1/art/")));
  assert.ok(catalog.ciphers.every((cipher) => cipher.art.base.startsWith("https://api.thecitadel.com/v1/art/")));
});

test("a held catalog revalidates part by part; all 304 is not modified", async () => {
  const first = ok(await client.catalog());
  stub.requests.length = 0;
  assert.deepEqual(ok(await client.catalog({ held: first })), { status: "notModified" });
  assert.deepEqual(catalogPaths(), routePaths);
  for (const request of stub.requests) assert.match(request.headers["if-none-match"], /^"[0-9a-f]+:/);
});

test("when one part changed, only it is replaced and the catalog gets a new etag", async () => {
  const first = ok(await client.catalog());
  stub.route("GET /v1/qualities", (req, res) => {
    res.writeHead(200, { "content-type": "application/json", etag: '"qualities-2"' });
    res.end(JSON.stringify({ ...FIXTURES.parts.qualities, qualities: FIXTURES.parts.qualities.qualities.slice(1) }));
  });
  stub.requests.length = 0;
  const again = ok(await client.catalog({ held: first }));
  assert.equal(again.status, "ok");
  assert.equal(again.catalog.qualities.length, first.catalog.qualities.length - 1);
  assert.equal(again.catalog.items.length, first.catalog.items.length, "the unchanged parts came from the held copy");
  assert.notEqual(again.etag, first.etag);
  assert.equal(again.parts.items, first.parts.items);
});

test("parts of two builds are asked for again once; a build that keeps changing is unavailable", async () => {
  const other = { ...FIXTURES.parts.qualities, build: "next-build" };
  let calls = 0;
  stub.route("GET /v1/qualities", (req, res) => {
    // The first try meets the new build on one route only (a deploy landed between the requests).
    const body = ++calls === 1 ? other : FIXTURES.parts.qualities;
    res.writeHead(200, { "content-type": "application/json", etag: `"q-${calls}"` });
    res.end(JSON.stringify(body));
  });
  assert.equal(ok(await client.catalog()).status, "ok");
  assert.equal(calls, 2);
  stub.route("GET /v1/qualities", (req, res) => {
    res.writeHead(200, { "content-type": "application/json", etag: '"q-x"' });
    res.end(JSON.stringify(other));
  });
  const stuck = err(await client.catalog());
  assert.equal(stuck.kind, "unavailable");
  assert.match(stuck.message, /changed builds/);
});

test("a catalog route that answers with something else is unavailable", async () => {
  stub.route("GET /v1/items", (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hello: "world" }));
  });
  assert.equal(err(await client.catalog()).kind, "unavailable");
});

test("evaluate posts the fit and returns the API's verdict; an invalid fit is still a successful call", async () => {
  const valid = ok(await client.evaluate(FIXTURES.fit));
  assert.equal(valid.valid, true);
  assert.deepEqual(stub.requests.at(-1).body, { fit: FIXTURES.fit });
  const dup = { ...FIXTURES.fit, modules: [FIXTURES.fit.modules[0], FIXTURES.fit.modules[0]] };
  const invalid = ok(await client.evaluate(dup));
  assert.equal(invalid.valid, false);
  assert.equal(invalid.issues[0].kind, "Overlap");
});

test("import and export round-trip through the API's shapes", async () => {
  const exported = ok(await client.exportFitString(FIXTURES.fit));
  assert.equal(exported.fitString, FIXTURES.exported.fitString);
  assert.deepEqual(ok(await client.importFitString(exported.fitString)).fit, FIXTURES.imported.fit);
});

test("item facts post the rolled item and return the API's rows; an unknown item is rejected", async () => {
  assert.deepEqual(ok(await client.itemFacts(FIXTURES.itemFactsRequest.item)), FIXTURES.itemFacts);
  assert.deepEqual(stub.requests.at(-1).body, FIXTURES.itemFactsRequest);
  const unknown = err(await client.itemFacts({ ...FIXTURES.itemFactsRequest.item, def: "1" }));
  assert.equal(unknown.kind, "rejected");
  assert.match(unknown.message, /not a fittable item/);
  const controller = new AbortController();
  controller.abort();
  assert.equal(err(await client.itemFacts(FIXTURES.itemFactsRequest.item, { signal: controller.signal })).kind, "cancelled");
});

test("a 400 is rejected with the message from the error envelope", async () => {
  const e = err(await client.importFitString("nonsense"));
  assert.equal(e.kind, "rejected");
  assert.equal(e.message, FIXTURES.error.error.message);
  assert.equal(FIXTURES.error.error.code, "bad_request");
  assert.equal(err(await client.evaluate(undefined)).kind, "rejected");
});

test("413, 429 and 5xx map to tooLarge, rateLimited and unavailable", async () => {
  stub.fail(413);
  assert.equal(err(await client.evaluate(FIXTURES.fit)).kind, "tooLarge");
  stub.fail(429);
  assert.equal(err(await client.evaluate(FIXTURES.fit)).kind, "rateLimited");
  assert.equal(err(await client.catalog()).kind, "rateLimited");
  stub.fail(500);
  assert.equal(err(await client.evaluate(FIXTURES.fit)).kind, "unavailable");
  stub.fail(503);
  assert.equal(err(await client.status()).kind, "unavailable");
});

test("a real over-limit body gets the API's 413", async () => {
  const huge = { ...FIXTURES.fit, pad: "x".repeat(300_000) };
  assert.equal(err(await client.evaluate(huge)).kind, "tooLarge");
});

test("an API that is down is unavailable, never a throw", async () => {
  const down = createEngineClient({ baseUrl: await deadEngineUrl() });
  for (const result of [
    await down.status(),
    await down.catalog(),
    await down.evaluate(FIXTURES.fit),
    await down.importFitString("x"),
    await down.exportFitString(FIXTURES.fit),
  ]) {
    assert.equal(err(result).kind, "unavailable");
  }
});

test("a slow API times out", async () => {
  stub.route("POST /v1/fits/evaluate", () => {}); // never answers
  const quick = createEngineClient({ baseUrl: stub.url, timeouts: { evaluateMs: 80 } });
  const started = Date.now();
  assert.equal(err(await quick.evaluate(FIXTURES.fit)).kind, "timeout");
  assert.ok(Date.now() - started < 2000);
});

test("no API URL configured is unavailable", async () => {
  const none = createEngineClient({ baseUrl: null });
  assert.equal(err(await none.evaluate(FIXTURES.fit)).kind, "unavailable");
});

test("a 200 that is not the API's JSON is unavailable", async () => {
  stub.route("POST /v1/fits/evaluate", (req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>bad gateway page</html>");
  });
  assert.equal(err(await client.evaluate(FIXTURES.fit)).kind, "unavailable");
  stub.route("POST /v1/fits/evaluate", (req, res) => {
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
  assert.equal(err(await weird.status()).kind, "unavailable");
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
    "POST /v1/fits/evaluate": (req, res) => {
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
