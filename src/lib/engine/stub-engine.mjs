// A stand-in loadout engine for tests: a real HTTP server that answers with the responses recorded from
// the real engine in __fixtures__. Not a test file. Pass `overrides` to replace a route's behaviour.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));
export const FIXTURES = {
  health: fixture("health.json"),
  catalog: fixture("catalog.json"),
  fit: fixture("fit.json"),
  evaluateValid: fixture("evaluate-valid.json"),
  evaluateInvalid: fixture("evaluate-invalid.json"),
  exported: fixture("export.json"),
  imported: fixture("import.json"),
  error: fixture("error.json"),
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

/**
 * Starts the stub on a free port. `requests` records every call as `{ method, path, headers, body }`.
 * `overrides["POST /v1/evaluate"] = (req, res, body) => ...` replaces a route; `stub.fail(status)` makes
 * every route answer with that status until `stub.fail(null)`.
 */
export async function startStubEngine(overrides = {}) {
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
      return send(res, 200, overlaps(body.json.fit) ? FIXTURES.evaluateInvalid : FIXTURES.evaluateValid);
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

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
