import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createCatalogCache } from "./catalog-cache.ts";
import { CATALOG_ROUTES } from "./catalog-resources.ts";
import { createEngineClient } from "./client.ts";
import { FIXTURES, startStubEngine } from "./stub-engine.mjs";

let stub;
let client;
let clock;
// One catalog fetch is one request to each resource route; the items route stands for the round.
const catalogRequests = () => stub.requests.filter((r) => r.path === "/v1/items");

before(async () => {
  stub = await startStubEngine();
  client = createEngineClient({ baseUrl: stub.url });
});
after(() => stub.close());
beforeEach(() => {
  stub.fail(null);
  for (const route of Object.values(CATALOG_ROUTES)) stub.route(`GET ${route.path}`, undefined);
  stub.requests.length = 0;
  clock = 1_000_000;
});
const make = () => createCatalogCache(client, { recheckMs: 60_000, retryMs: 10_000, now: () => clock });

test("the first get fetches; later gets inside the window don't touch the engine", async () => {
  const cache = make();
  assert.equal(cache.peek(), null);
  const first = await cache.get();
  assert.equal(first.ok && first.value.buildSha, FIXTURES.status.build);
  clock += 59_000;
  await cache.get();
  assert.equal(catalogRequests().length, 1);
  assert.equal(cache.peek().buildSha, FIXTURES.status.build);
});

test("after the window it revalidates with the etag and a 304 keeps the held catalog", async () => {
  const cache = make();
  const first = await cache.get();
  clock += 61_000;
  const second = await cache.get();
  assert.equal(catalogRequests().length, 2);
  assert.match(catalogRequests()[1].headers["if-none-match"], /^"[^"]+"$/, "the items part is asked for again by its tag");
  assert.equal(second.value, first.value, "same object: nothing was replaced");
});

/** Every route at `build`, with that build in its tags. */
function newBuild(build) {
  for (const [part, route] of Object.entries(CATALOG_ROUTES)) {
    const body = { ...FIXTURES.parts[part], build };
    stub.route(`GET ${route.path}`, (req, res) => {
      res.writeHead(200, { "content-type": "application/json", etag: `"${build}:${part}"` });
      res.end(JSON.stringify(body));
    });
  }
}

test("a new build replaces the held catalog", async () => {
  const cache = make();
  await cache.get();
  const first = cache.etag();
  newBuild("next-build");
  clock += 61_000;
  const result = await cache.get();
  assert.equal(result.value.buildSha, "next-build");
  assert.equal(cache.peek().buildSha, "next-build");
  assert.notEqual(cache.etag(), first);
});

test("a changed part on the same build replaces the held catalog", async () => {
  const cache = make();
  await cache.get();
  const first = cache.etag();
  assert.ok(first);
  stub.route("GET /v1/items", (req, res) => {
    res.writeHead(200, { "content-type": "application/json", etag: '"content-2"' });
    res.end(JSON.stringify({ ...FIXTURES.parts.items, items: FIXTURES.parts.items.items.slice(1) }));
  });
  clock += 61_000;
  const result = await cache.get();
  assert.equal(result.value.buildSha, FIXTURES.status.build);
  assert.equal(result.value.items.length, FIXTURES.parts.items.items.length - 1);
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

test("with nothing held, a failure is returned, and retries are spaced by retryMs", async () => {
  const cache = make();
  stub.fail(503);
  const failed = await cache.get();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.kind, "unavailable");
  const asked = catalogRequests().length;
  stub.fail(null);
  clock += 9_000;
  assert.deepEqual(await cache.get(), failed, "inside the retry delay the failure is served without a request");
  assert.equal(catalogRequests().length, asked);
  clock += 2_000;
  assert.equal((await cache.get()).ok, true, "after it, the API is asked again");
  assert.equal(catalogRequests().length, asked + 1);
});

test("concurrent gets share one request", async () => {
  const cache = make();
  const results = await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(catalogRequests().length, 1);
});
