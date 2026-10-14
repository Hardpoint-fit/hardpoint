import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, toPublicConfig } from "./config.ts";

test("an empty environment gives a usable, read-only config", () => {
  const config = parseConfig({});
  assert.equal(config.apiUrl, null);
  assert.equal(config.apiInternalUrl, null);
  assert.equal(config.databaseUrl, null);
  assert.equal(config.authEnabled, false);
  assert.deepEqual(config.adminUserIds, []);
});

test("blank values count as missing", () => {
  const config = parseConfig({ DATABASE_URL: "  ", GAME_DATA_API_URL: "", CITADEL_OAUTH_CLIENT_SECRET: " ", SESSION_SECRET: " " });
  assert.equal(config.databaseUrl, null);
  assert.equal(config.apiUrl, null);
  assert.equal(config.oauthClientSecret, null);
  assert.equal(config.sessionSecret, null);
});

test("present values are read, and URLs lose trailing slashes", () => {
  const config = parseConfig({
    GAME_DATA_API_URL: "https://engine.example.com//",
    GAME_DATA_API_INTERNAL_URL: "http://engine.railway.internal:8080/",
    DATABASE_URL: "postgres://u:p@db/fits",
  });
  assert.equal(config.apiUrl, "https://engine.example.com");
  assert.equal(config.apiInternalUrl, "http://engine.railway.internal:8080");
  assert.equal(config.databaseUrl, "postgres://u:p@db/fits");
});

test("the server falls back to the public API URL when no internal one is set", () => {
  const config = parseConfig({ GAME_DATA_API_URL: "https://engine.example.com" });
  assert.equal(config.apiInternalUrl, "https://engine.example.com");
});

const SESSION_SECRET = Buffer.alloc(48, 9).toString("base64");
const OAUTH = { CITADEL_OAUTH_CLIENT_ID: "client_x", CITADEL_OAUTH_CLIENT_SECRET: "secret_x", SESSION_SECRET };

test("auth is enabled only when the client id, client secret and session secret are all present", () => {
  assert.equal(parseConfig(OAUTH).authEnabled, true);
  for (const name of Object.keys(OAUTH)) {
    const env = { ...OAUTH };
    delete env[name];
    assert.equal(parseConfig(env).authEnabled, false, `without ${name}`);
  }
  // The retired Clerk SDK keys enable nothing.
  assert.equal(parseConfig({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_x", CLERK_SECRET_KEY: "sk_live_x" }).authEnabled, false);
});

test("the session secret must decode to at least 32 bytes of base64", () => {
  assert.equal(parseConfig({ ...OAUTH, SESSION_SECRET: Buffer.alloc(31).toString("base64") }).sessionSecret, null);
  assert.equal(parseConfig({ ...OAUTH, SESSION_SECRET: "not base64!" }).authEnabled, false);
  assert.equal(parseConfig(OAUTH).sessionSecret.length, 48);
  assert.equal(parseConfig({ ...OAUTH, SESSION_SECRET: Buffer.alloc(32, 1).toString("base64url") }).sessionSecret.length, 32);
});

test("issuer and site URL: the Citadel defaults, overridable, reduced to an origin", () => {
  const defaults = parseConfig({});
  assert.equal(defaults.oauthIssuer, "https://clerk.alpha.thecitadel.com");
  assert.equal(defaults.siteUrl, "https://hardpoint.fit");
  const set = parseConfig({ CITADEL_OAUTH_ISSUER: "https://idp.example/", SITE_URL: "http://localhost:3000/some/path" });
  assert.equal(set.oauthIssuer, "https://idp.example");
  assert.equal(set.siteUrl, "http://localhost:3000");
  assert.equal(parseConfig({ SITE_URL: "javascript:alert(1)" }).siteUrl, "https://hardpoint.fit");
});

test("admin user ids are split on commas and trimmed", () => {
  const config = parseConfig({ SITE_ADMIN_USER_IDS: " user_1, user_2 ,,user_3" });
  assert.deepEqual(config.adminUserIds, ["user_1", "user_2", "user_3"]);
});

test("the public config carries no secret or server-only value", () => {
  const config = parseConfig({
    GAME_DATA_API_URL: "https://engine.example.com",
    GAME_DATA_API_INTERNAL_URL: "http://engine.railway.internal",
    DATABASE_URL: "postgres://u:p@db/fits",
    CITADEL_OAUTH_CLIENT_ID: "client_x",
    CITADEL_OAUTH_CLIENT_SECRET: "oauth_secret",
    SESSION_SECRET,
    SITE_ADMIN_USER_IDS: "user_1",
  });
  const publicConfig = toPublicConfig(config);
  assert.deepEqual(Object.keys(publicConfig).sort(), ["apiUrl", "authEnabled"]);
  assert.equal(publicConfig.authEnabled, true);
  assert.equal(JSON.stringify(publicConfig).includes("secret"), false);
  assert.equal(JSON.stringify(publicConfig).includes("postgres"), false);
});
