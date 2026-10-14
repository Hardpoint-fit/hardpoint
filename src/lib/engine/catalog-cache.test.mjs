import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createCatalogCache } from "./catalog-cache.ts";
import { createEngineClient } from "./client.ts";
import { FIXTURES, startStubEngine } from "./stub-engine.mjs";

let stub;
let client;
let clock;
const catalogRequests = () => stub.requests.filter((r) => r.path === "/v1/catalog");

before(async () => {
  stub = await startStubEngine();
  client = createEngineClient({ baseUrl: stub.url });
});
after(() => stub.close());
beforeEach(() => {
  stub.fail(null);
  stub.route("GET /v1/catalog", undefined);
  stub.requests.length = 0;
  clock = 1_000_000;
});
const make = () => createCatalogCache(client, { recheckMs: 60_000, retryMs: 10_000, now: () => clock });

test("the first get fetches; later gets inside the window don't touch the engine", async () => {
  const cache = make();
  assert.equal(cache.peek(), null);
  const first = await cache.get();
  assert.equal(first.ok && first.value.buildSha, FIXTURES.catalog.buildSha);
  clock += 59_000;
  await cache.get();
  assert.equal(catalogRequests().length, 1);
  assert.equal(cache.peek().buildSha, FIXTURES.catalog.buildSha);
});

test("after the window it revalidates with the etag and a 304 keeps the held catalog", async () => {
  const cache = make();
  const first = await cache.get();
  clock += 61_000;
  const second = await cache.get();
  assert.equal(catalogRequests().length, 2);
  assert.equal(catalogRequests()[1].headers["if-none-match"], `"${FIXTURES.catalog.buildSha}"`);
  assert.equal(second.value, first.value, "same object: nothing was replaced");
});

test("a new build replaces the held catalog", async () => {
  const cache = make();
  await cache.get();
  const next = { ...FIXTURES.catalog, buildSha: "next-build" };
  stub.route("GET /v1/catalog", (req, res) => {
    res.writeHead(200, { "content-type": "application/json", etag: '"next-build"' });
    res.end(JSON.stringify(next));
  });
  clock += 61_000;
  const result = await cache.get();
  assert.equal(result.value.buildSha, "next-build");
  assert.equal(cache.peek().buildSha, "next-build");
});

test("a new engine etag on the same build replaces the held catalog", async () => {
  const cache = make();
  await cache.get();
  const first = cache.etag();
  assert.ok(first);
  const next = { ...FIXTURES.catalog, items: FIXTURES.catalog.items.slice(1) };
  stub.route("GET /v1/catalog", (req, res) => {
    res.writeHead(200, { "content-type": "application/json", etag: '"content-2"' });
    res.end(JSON.stringify(next));
  });
  clock += 61_000;
  const result = await cache.get();
  assert.equal(result.value.buildSha, FIXTURES.catalog.buildSha);
  assert.equal(result.value.items.length, next.items.length);
  assert.equal(cache.etag(), '"content-2"');
  assert.notEqual(cache.etag(), first);
});

test("when revalidation fails the held catalog keeps serving, and retries wait", async () => {
  const cache = make();
  await cache.get();
  stub.fail(503);
  clock += 61_000;
  const result = await cache.get();
  assert.equal(result.ok, true);
  assert.equal(catalogRequests().length, 2);
  clock += 5_000;
  await cache.get();
  assert.equal(catalogRequests().length, 2, "inside the retry delay");
  clock += 6_000;
  await cache.get();
  assert.equal(catalogRequests().length, 3);
});

test("with nothing held, a failure is returned, and the next get tries again", async () => {
  const cache = make();
  stub.fail(503);
  const failed = await cache.get();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.kind, "unavailable");
  stub.fail(null);
  assert.equal((await cache.get()).ok, true);
});

test("concurrent gets share one request", async () => {
  const cache = make();
  const results = await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(catalogRequests().length, 1);
});
