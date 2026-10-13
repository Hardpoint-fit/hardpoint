// Smoke test of the built standalone server: seeds a disposable Postgres with the fixture fits,
// serves the engine fixtures from the stub, starts `.next/standalone/server.js` three ways (engine
// up, engine down, no database) and fetches every route for its status and key text.
//
//   pnpm build
//   SMOKE_DATABASE_URL=postgres://... pnpm smoke     # a throwaway database: it is truncated
//
// `node --import ./scripts/node-hooks.mjs scripts/smoke.mjs --serve` seeds and leaves the server and
// stub running for a look in the browser (Ctrl+C stops both).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startStubEngine } from "../src/lib/engine/stub-engine.mjs";
import { applySchema } from "../src/lib/fits/migrate.mjs";
import { seedSite } from "../src/lib/site/seed.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = join(appRoot, ".next/standalone");
const databaseUrl = process.env.SMOKE_DATABASE_URL;
const serve = process.argv.includes("--serve");

if (!databaseUrl) throw new Error("Set SMOKE_DATABASE_URL to a throwaway Postgres database.");
if (!existsSync(join(standalone, "server.js"))) throw new Error("Run `pnpm build` first.");
// As the Dockerfile does: the standalone server serves the static assets from beside it.
cpSync(join(appRoot, ".next/static"), join(standalone, ".next/static"), { recursive: true });

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
async function check(site, path, { status = 200, has = [], lacks = [], type, encoding } = {}) {
  const response = await fetch(site.url + path, { redirect: "manual", headers: encoding ? { "accept-encoding": encoding } : {} });
  if (encoding) assert.equal(response.headers.get("content-encoding"), encoding.split(",")[0].trim(), `${path}: content encoding`);
  const body = type?.startsWith("image/") ? "" : await response.text();
  assert.equal(response.status, status, `${path}: status ${response.status}`);
  if (type) assert.match(response.headers.get("content-type") ?? "", new RegExp(`^${type}`), `${path}: content type`);
  for (const text of has) assert.ok(body.includes(text), `${path}: missing ${JSON.stringify(text)}`);
  for (const text of lacks) assert.ok(!body.includes(text), `${path}: has ${JSON.stringify(text)}`);
  results.push(`${response.status} ${path}${has.length ? `  [${has.join(" | ")}]` : ""}`);
}

const ALICE_ID = "user_alice";
const ids = await seed();
const stub = await startStubEngine();
const sites = [];
try {
  // ---- Engine up, database seeded, no sign-in -----------------------------------------------
  const up = await startSite({ DATABASE_URL: databaseUrl, LOADOUT_ENGINE_URL: stub.url });
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
  await check(up, `/fits/${ids.removed}`, { has: ["UNKNOWN ITEM", "OUTDATED", "doesn&#x27;t exist in the current build", "LAST VALID"] });
  await check(up, `/fits/${ids.showcase}/opengraph-image`, { type: "image/png" });
  await check(up, `/fits/${ids.draft}`, { status: 404 });
  await check(up, "/fits/nosuchfit0", { status: 404, has: ["NOTHING HERE"] });
  await check(up, `/u/${ALICE_ID}`, { has: ["ALICE", "Scarab cipher brawler"], lacks: ["Unfinished idea"] });
  await check(up, "/u/user_nobody", { has: ["HASN&#x27;T PUBLISHED"] });
  await check(up, "/admin/reports", { status: 404 });
  // The builder: its page renders and loads the catalog from the server, which keeps serving the copy
  // it holds when the engine stops answering (Review Focus #4).
  await check(up, "/fits/new", { has: ["LOADING THE CATALOG"] });
  await check(up, `/fits/new?from=${ids.showcase}`, { has: ["LOADING THE CATALOG"] });
  await check(up, "/api/catalog", { has: ["SCARAB", "OMNI REPAIRER TURRET", "affinity"] });
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
  up.child.kill();

  // ---- Engine down since start: stored verdicts, a banner, no 500 --------------------------
  const down = await startSite({ DATABASE_URL: databaseUrl, LOADOUT_ENGINE_URL: "http://127.0.0.1:9" });
  sites.push(down);
  results.push("== engine down");
  await check(down, "/", { has: ["ISN&#x27;T ANSWERING", "Scarab cipher brawler"] });
  await check(down, `/fits/${ids.showcase}`, { has: ["ISN&#x27;T ANSWERING", "MAX VELOCITY", "THE GRID NEEDS THE LOADOUT ENGINE"] });
  await check(down, `/fits/${ids.removed}`, { has: ["ISN&#x27;T ANSWERING", "Old build regalia runner"] });
  await check(down, `/fits/${ids.showcase}/opengraph-image`, { type: "image/png" });
  await check(down, `/u/${ALICE_ID}`, { has: ["Scarab cipher brawler"] });
  await check(down, "/fits/new", { has: ["LOADING THE CATALOG"] });
  await check(down, "/api/catalog", { status: 503, has: ["no_catalog"] });
  down.child.kill();

  // ---- No database: an unavailable state, not a 500 -----------------------------------------
  const noDb = await startSite({ LOADOUT_ENGINE_URL: stub.url });
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
