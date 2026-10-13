// A stand-in loadout engine for tests: a real HTTP server that answers with the responses recorded from
// the real engine in __fixtures__. Not a test file. Pass `overrides` to replace a route's behaviour.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));
export const FIXTURES = {
  health: fixture("health.json"),
  catalog: fixture("catalog.json"),
  fit: fixture("fit.json"),
  evaluateValid: fixture("evaluate-valid.json"),
  evaluateInvalid: fixture("evaluate-invalid.json"),
  /** fit.json with a ciphered port (module 3) and a turned module (5). */
  fitShowcase: fixture("fit-showcase.json"),
  evaluateShowcase: fixture("evaluate-showcase.json"),
  /** fit.json with module 2's item replaced by one no build has: what a removed item looks like. */
  fitRemovedItem: fixture("fit-removed-item.json"),
  evaluateRemovedItem: fixture("evaluate-removed-item.json"),
  /** Engine verdicts for fit-showcase.json with module 5 at each rotation (two overlap the cipher's cell). */
  rotationOracle: fixture("rotation-oracle.json"),
  exported: fixture("export.json"),
  imported: fixture("import.json"),
  error: fixture("error.json"),
  /** A rolled module from fit.json, and the engine's facts for it. */
  itemFactsRequest: fixture("item-facts-request.json"),
  itemFacts: fixture("item-facts.json"),
};

const MAX_BODY = 262_144;

function send(res, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return { tooLarge: true };
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return { json: text ? JSON.parse(text) : undefined };
  } catch {
    return { json: undefined };
  }
}

/** Like the real engine, a fit whose modules share an origin cell is invalid. */
function overlaps(fit) {
  const seen = new Set();
  for (const m of fit?.modules ?? []) {
    const key = `${m.row},${m.col}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

const knownItems = new Set(FIXTURES.catalog.items.map((item) => item.def));

/** The recorded verdict that fits this fit: a removed item, an overlap, the showcase fit, or valid. */
function evaluate(fit) {
  const unknown = (fit.modules ?? []).findIndex((m) => !knownItems.has(m?.item?.def));
  if (unknown >= 0) {
    const [issue] = FIXTURES.evaluateRemovedItem.issues;
    return { ...FIXTURES.evaluateRemovedItem, issues: [{ ...issue, moduleIndex: unknown }] };
  }
  if (overlaps(fit)) return FIXTURES.evaluateInvalid;
  if (JSON.stringify(fit) === JSON.stringify(FIXTURES.fitShowcase)) return FIXTURES.evaluateShowcase;
  return FIXTURES.evaluateValid;
}

/**
 * Starts the stub on a free port. `requests` records every call as `{ method, path, headers, body }`.
 * `overrides["POST /v1/evaluate"] = (req, res, body) => ...` replaces a route; `stub.fail(status)` makes
 * every route answer with that status until `stub.fail(null)`.
 */
export async function startStubEngine(overrides = {}, port = 0) {
  const requests = [];
  let failing = null;
  const routes = { ...overrides };
  const catalogSha = () => FIXTURES.catalog.buildSha;

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://stub").pathname;
    const body = req.method === "POST" ? await readBody(req) : {};
    requests.push({ method: req.method, path, headers: req.headers, body: body.json });
    const route = routes[`${req.method} ${path}`];
    if (route) return route(req, res, body.json);
    if (failing !== null) return send(res, failing, { error: `stub failing with ${failing}` });
    if (body.tooLarge) return send(res, 413, undefined);

    if (req.method === "GET" && path === "/healthz") return send(res, 200, FIXTURES.health);
    if (req.method === "GET" && path === "/v1/catalog") {
      const etag = `"${catalogSha()}"`;
      if (req.headers["if-none-match"] === etag) return send(res, 304, undefined, { etag });
      return send(res, 200, FIXTURES.catalog, { etag, "cache-control": "public, max-age=300" });
    }
    if (req.method === "POST" && path === "/v1/evaluate") {
      if (!body.json?.fit) return send(res, 400, { error: "Body must be { fit }." });
      return send(res, 200, evaluate(body.json.fit));
    }
    if (req.method === "POST" && path === "/v1/item-facts") {
      const item = body.json?.item;
      if (!item) return send(res, 400, { error: "Body must be { item }." });
      if (JSON.stringify(item) === JSON.stringify(FIXTURES.itemFactsRequest.item)) return send(res, 200, FIXTURES.itemFacts);
      // Any other known item answers with its catalog facts (the plainest roll's); an unknown one is refused.
      const known = FIXTURES.catalog.items.find((entry) => entry.def === item.def);
      return known ? send(res, 200, { facts: known.facts }) : send(res, 400, { error: "item: not a fittable item in this build" });
    }
    if (req.method === "POST" && path === "/v1/fits/import") {
      return body.json?.fitString === FIXTURES.exported.fitString
        ? send(res, 200, FIXTURES.imported)
        : send(res, 400, FIXTURES.error);
    }
    if (req.method === "POST" && path === "/v1/fits/export") {
      return body.json?.fit ? send(res, 200, FIXTURES.exported) : send(res, 400, { error: "Body must be { fit }." });
    }
    return send(res, 404, undefined);
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    route: (key, handler) => {
      if (handler) routes[key] = handler;
      else delete routes[key];
    },
    fail: (status) => {
      failing = status;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A URL nothing listens on, for "engine is down". */
export async function deadEngineUrl() {
  const stub = await startStubEngine();
  const { url } = stub;
  await stub.close();
  return url;
}

// `node src/lib/engine/stub-engine.mjs [port]` serves the fixtures for local development and the smoke test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stub = await startStubEngine({}, Number(process.argv[2] ?? 18082));
  console.log(`stub engine on ${stub.url}`);
}
