// Smoke test of the built standalone server: seeds a disposable Postgres with the fixture fits,
// serves the game data API fixtures from the stub, starts `.next/standalone/server.js` three ways (engine
// up, engine down, no database) and fetches every route for its status and key text.
//
//   pnpm build
//   SMOKE_DATABASE_URL=postgres://... pnpm smoke     # a throwaway database: it is truncated
//
// `node --import ./scripts/node-hooks.mjs scripts/smoke.mjs --serve` seeds and leaves the server and
// stub running for a look in the browser (Ctrl+C stops both).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { cpSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startStubEngine } from "../src/lib/engine/stub-engine.mjs";
import { applySchema } from "../src/lib/fits/migrate.mjs";
import { seedSite } from "../src/lib/site/seed.mjs";
import { startFakeIdp } from "../src/lib/fake-idp.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = join(appRoot, ".next/standalone");
const databaseUrl = process.env.SMOKE_DATABASE_URL;
const serve = process.argv.includes("--serve");

if (!databaseUrl) throw new Error("Set SMOKE_DATABASE_URL to a throwaway Postgres database.");
if (!existsSync(join(standalone, "server.js"))) throw new Error("Run `pnpm build` first.");
// As the Dockerfile does: the standalone server serves the static assets and public/ from beside it.
cpSync(join(appRoot, ".next/static"), join(standalone, ".next/static"), { recursive: true });
cpSync(join(appRoot, "public"), join(standalone, "public"), { recursive: true });

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function seed() {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = {
    query: (text, params) => pool.query(text, params ? [...params] : undefined),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work({ query: (text, params) => client.query(text, params ? [...params] : undefined) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
  await applySchema({ exec: (sql) => pool.query(sql) });
  await pool.query("TRUNCATE fits, fit_reports CASCADE");
  const ids = await seedSite(db);
  await pool.end();
  return ids;
}

async function startSite(env) {
  const port = await freePort();
  if (typeof env === "function") env = env(`http://127.0.0.1:${port}`);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: standalone,
    env: { PATH: process.env.PATH, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return { url, child, output: () => output };
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  child.kill();
  throw new Error(`The site didn't start:\n${output}`);
}

const results = [];
async function check(site, path, { status = 200, has = [], lacks = [], type, encoding, cacheControl } = {}) {
  const response = await fetch(site.url + path, { redirect: "manual", headers: encoding ? { "accept-encoding": encoding } : {} });
  if (encoding) assert.equal(response.headers.get("content-encoding"), encoding.split(",")[0].trim(), `${path}: content encoding`);
  const body = type?.startsWith("image/") ? "" : await response.text();
  assert.equal(response.status, status, `${path}: status ${response.status}`);
  if (type) assert.match(response.headers.get("content-type") ?? "", new RegExp(`^${type}`), `${path}: content type`);
  if (cacheControl) assert.equal(response.headers.get("cache-control"), cacheControl, `${path}: cache control`);
  for (const text of has) assert.ok(body.includes(text), `${path}: missing ${JSON.stringify(text)}`);
  for (const text of lacks) assert.ok(!body.includes(text), `${path}: has ${JSON.stringify(text)}`);
  results.push(`${response.status} ${path}${has.length ? `  [${has.join(" | ")}]` : ""}`);
}

/** A GET with a chosen Host header (fetch won't send one), for the www redirect. */
function getWithHost(site, path, host) {
  return new Promise((done, fail) => {
    const url = new URL(site.url + path);
    httpRequest({ host: url.hostname, port: url.port, path, headers: { host } }, (response) => {
      response.resume();
      done({ status: response.statusCode, location: response.headers.location });
    })
      .on("error", fail)
      .end();
  });
}

async function checkWww(site, host, path, location) {
  const response = await getWithHost(site, path, host);
  assert.equal(response.status, 308, `${host}${path}: status ${response.status}`);
  assert.equal(response.location, location, `${host}${path}: location`);
  results.push(`308 ${host}${path} -> ${location}`);
}

/** Set-Cookie name -> value of a fetch response. */
const cookiesOf = (response) => Object.fromEntries(response.headers.getSetCookie().map((line) => line.split(";")[0].split(/=(.*)/s).slice(0, 2)));

const ALICE_ID = "user_alice";
const PUBLIC_API = "https://api.example.test";
const ART_SRC = `class="item-icon" src="${PUBLIC_API}/v1/art/`;
const ids = await seed();
const stub = await startStubEngine();
const sites = [];
try {
  // ---- Engine up, database seeded, no sign-in -----------------------------------------------
  // The public API address is one nothing listens on: the page must only name it in its art URLs, and
  // the server must read the API (and fetch the share card's art) at the internal address.
  const up = await startSite({ DATABASE_URL: databaseUrl, GAME_DATA_API_URL: PUBLIC_API, GAME_DATA_API_INTERNAL_URL: stub.url });
  sites.push(up);
  if (serve) {
    console.log(`site ${up.url}  fits ${JSON.stringify(ids)}`);
    await new Promise(() => {});
  }
  results.push("== engine up");
  await check(up, "/healthz");
  await check(up, "/", { has: ["SHIP FITS", "Scarab cipher brawler", "Old build regalia runner", "OUTDATED", "CHECKING ON NEW BUILD", "SCARAB", "ALICE"], lacks: ["Unfinished idea", "ISN&#x27;T ANSWERING"] });
  await check(up, "/?role=Destroyer&sort=new", { has: ["Scarab cipher brawler"] });
  await check(up, "/?role=Interceptor", { has: ["NO FITS MATCH"] });
  await check(up, "/?current=1", { has: ["Scarab cipher brawler"], lacks: ["Old build regalia runner"] });
  await check(up, "/?tag=regalia", { has: ["Old build regalia runner"], lacks: ["Scarab cipher brawler"] });
  await check(up, `/fits/${ids.showcase}`, {
    has: ["Scarab cipher brawler", "COOLANT RESERVOIR", "MAX VELOCITY", "KASSIK", "WORKS ON CURRENT BUILD", "COPY FIT STRING", "Does the <strong>cipher</strong>", "Sign-in isn&#x27;t configured"],
    lacks: ["<script>alert(1)</script>", "UPVOTED"],
  });
  // Icons, descriptions, fact rows and the stored hull specs on the fit page; hull art on the cards.
  await check(up, `/fits/${ids.showcase}`, {
    has: ['class="fg-module__icon"', ART_SRC, "AUTOMATICALLY VENTS HEAT WHEN UNSTABLE", "DEACTIVATION COOLDOWN", "HULL SPECS", 'data-spec="effective-health"', "TIME TO SCRAM"],
    lacks: ["STATS APPEAR AFTER THE NEXT CHECK"],
  });
  await check(up, `/fits/${ids.pending}`, { has: ["STATS APPEAR AFTER THE NEXT CHECK", 'class="fg-module__icon"'] });
  await check(up, "/", { has: [ART_SRC] });
  await check(up, `/fits/${ids.removed}`, { has: ["UNKNOWN ITEM", "OUTDATED", "doesn&#x27;t exist in the current build", "LAST VALID"] });
  stub.requests.length = 0;
  await check(up, `/fits/${ids.showcase}/opengraph-image`, { type: "image/png" });
  // The share card fetches the art it draws from the API's internal address, never the public one.
  assert.ok(stub.requests.some((request) => request.path.startsWith("/v1/art/") && request.path.endsWith("@2x.webp")), "the share card read art from the API");
  await check(up, `/fits/${ids.draft}`, { status: 404 });
  await check(up, "/fits/nosuchfit0", { status: 404, has: ["NOTHING HERE"] });
  await check(up, `/u/${ALICE_ID}`, { has: ["ALICE", "Scarab cipher brawler"], lacks: ["Unfinished idea"] });
  await check(up, "/u/user_nobody", { has: ["HASN&#x27;T PUBLISHED"] });
  await check(up, "/admin/reports", { status: 404 });
  // The builder: its page renders and loads the catalog from the server, which keeps serving the copy
  // it holds when the engine stops answering (Review Focus #4).
  await check(up, "/fits/new", { has: ["LOADING THE CATALOG"] });
  await check(up, `/fits/new?from=${ids.showcase}`, { has: ["LOADING THE CATALOG"] });
  await check(up, "/api/catalog", { has: ["SCARAB", "REPAIR PROJECTOR", "affinity"] });
  await check(up, "/api/catalog", { encoding: "br", has: ["SCARAB"] });
  await check(up, "/api/catalog", { encoding: "gzip", has: ["SCARAB"] });
  // A crafted cursor is the first page; a path that doesn't decode is not found, not a 500.
  await check(up, `/?sort=new&cursor=${Buffer.from('{"sort":"new","score":0,"at":"never","id":"abcdefghij"}').toString("base64url")}`, { has: ["Scarab cipher brawler"] });
  await check(up, "/u/%E0%A4%A", { status: 404, has: ["NOTHING HERE"] });
  await check(up, "/fits/%E0%A4%A", { status: 404 });
  stub.fail(503);
  await check(up, "/api/catalog", { has: ["SCARAB"] });
  stub.fail(null);
  await check(up, `/fits/${ids.showcase}/edit`, { status: 307 });
  await check(up, `/fits/${ids.draft}/edit`, { status: 404 });
  await check(up, `/fits/${ids.showcase}`, { has: ["COPY FIT TO BUILDER"], lacks: [`/fits/${ids.showcase}/edit`] });
  // Sign-in not configured: the header says so, the auth routes answer 503, www still goes to the apex.
  await check(up, "/", { has: ["Sign-in isn&#x27;t configured on this site yet"], lacks: ["/auth/signin"] });
  await check(up, "/auth/signin?returnTo=%2F", { status: 503, has: ["Sign-in isn&#39;t configured on this site yet"] });
  await check(up, "/auth/callback?code=x&state=y", { status: 503 });
  await checkWww(up, "www.hardpoint.fit", "/fits/abc?x=1", "https://hardpoint.fit/fits/abc?x=1");
  up.child.kill();

  // ---- Sign in with Citadel, against a local fake provider -----------------------------------
  const idp = await startFakeIdp();
  try {
    const authed = await startSite((origin) => ({
      DATABASE_URL: databaseUrl,
      GAME_DATA_API_URL: stub.url,
      CITADEL_OAUTH_ISSUER: idp.issuer,
      CITADEL_OAUTH_CLIENT_ID: idp.clientId,
      CITADEL_OAUTH_CLIENT_SECRET: idp.clientSecret,
      SESSION_SECRET: Buffer.alloc(48, 3).toString("base64"),
      SITE_URL: origin,
    }));
    sites.push(authed);
    results.push("== sign in with citadel");
    await check(authed, "/", { has: ["/auth/signin?returnTo=%2F", "Sign in"], lacks: ["Sign-in isn&#x27;t configured"] });
    const start = await fetch(`${authed.url}/auth/signin?returnTo=${encodeURIComponent(`/fits/${ids.showcase}`)}`, { redirect: "manual" });
    assert.equal(start.status, 302, "signin redirects to the provider");
    const back = idp.authorize(start.headers.get("location"));
    assert.equal(back.origin, authed.url, "the redirect URI is SITE_URL/auth/callback");
    const signInCookie = Object.entries(cookiesOf(start)).map(([k, v]) => `${k}=${v}`).join("; ");
    const callback = await fetch(back, { redirect: "manual", headers: { cookie: signInCookie } });
    assert.equal(callback.status, 303, "callback signs in");
    assert.equal(callback.headers.get("location"), `${authed.url}/fits/${ids.showcase}`);
    const session = cookiesOf(callback)["__Host-citadel-session"];
    assert.ok(session, "session cookie set");
    results.push(`303 /auth/callback -> /fits/${ids.showcase} (session cookie set)`);
    const signedIn = await fetch(`${authed.url}/`, { headers: { cookie: `__Host-citadel-session=${session}` } });
    const page = await signedIn.text();
    assert.ok(page.includes("ahab") && page.includes("Sign out") && page.includes('action="/auth/signout"'), "header shows the pilot and SIGN OUT");
    results.push("200 / signed in  [ahab | Sign out]");
    const forged = await fetch(`${authed.url}/auth/signout`, { method: "POST", redirect: "manual", headers: { origin: "https://evil.example", cookie: `__Host-citadel-session=${session}` } });
    assert.equal(forged.status, 403, "cross-site sign-out refused");
    const out = await fetch(`${authed.url}/auth/signout`, { method: "POST", redirect: "manual", headers: { origin: authed.url, "content-type": "application/x-www-form-urlencoded", cookie: `__Host-citadel-session=${session}` }, body: "returnTo=%2F" });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), `${authed.url}/`, "sign-out returns to the canonical origin");
    assert.equal(cookiesOf(out)["__Host-citadel-session"], "", "sign-out clears the session");
    results.push("303 POST /auth/signout (cleared); 403 cross-site");
    authed.child.kill();
  } finally {
    await idp.close();
  }

  // ---- Engine down since start: stored verdicts, a banner, no 500 --------------------------
  const down = await startSite({ DATABASE_URL: databaseUrl, GAME_DATA_API_URL: "http://127.0.0.1:9" });
  sites.push(down);
  results.push("== engine down");
  await check(down, "/", { has: ["ISN&#x27;T ANSWERING", "Scarab cipher brawler"] });
  await check(down, `/fits/${ids.showcase}`, { has: ["ISN&#x27;T ANSWERING", "MAX VELOCITY", "THE GRID NEEDS THE GAME DATA API", 'data-spec="effective-health"', "EFFECTIVE HEALTH"] });
  await check(down, `/fits/${ids.removed}`, { has: ["ISN&#x27;T ANSWERING", "Old build regalia runner"] });
  await check(down, `/fits/${ids.showcase}/opengraph-image`, { type: "image/png" });
  await check(down, `/u/${ALICE_ID}`, { has: ["Scarab cipher brawler"] });
  await check(down, "/fits/new", { has: ["LOADING THE CATALOG"] });
  await check(down, "/api/catalog", { status: 503, has: ["no_catalog"] });
  down.child.kill();

  // ---- No database: an unavailable state, not a 500 -----------------------------------------
  const noDb = await startSite({ GAME_DATA_API_URL: stub.url });
  sites.push(noDb);
  results.push("== no database");
  await check(noDb, "/", { has: ["UNAVAILABLE RIGHT NOW"] });
  await check(noDb, `/fits/${ids.showcase}`, { has: ["UNAVAILABLE RIGHT NOW"] });
  await check(noDb, `/u/${ALICE_ID}`, { has: ["UNAVAILABLE RIGHT NOW"] });
  await check(noDb, "/admin/reports", { status: 404 });
  await check(noDb, "/fits/new", { has: ["LOADING THE CATALOG"] });
  await check(noDb, `/fits/new?from=${ids.showcase}`, { has: ["LOADING THE CATALOG"] });
  await check(noDb, `/fits/${ids.showcase}/edit`, { has: ["UNAVAILABLE RIGHT NOW"] });
  noDb.child.kill();
  console.log(results.join("\n"));
  console.log(`smoke: ${results.filter((line) => !line.startsWith("==")).length} requests passed`);
} catch (error) {
  console.log(results.join("\n"));
  for (const site of sites) console.error(site.output().slice(-3000));
  throw error;
} finally {
  for (const site of sites) site.child.kill();
  await stub.close();
}
