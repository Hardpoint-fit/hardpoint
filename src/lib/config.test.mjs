import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, toPublicConfig } from "./config.ts";

test("an empty environment gives a usable, read-only config", () => {
  const config = parseConfig({});
  assert.equal(config.engineUrl, null);
  assert.equal(config.engineInternalUrl, null);
  assert.equal(config.databaseUrl, null);
  assert.equal(config.authEnabled, false);
  assert.deepEqual(config.adminUserIds, []);
});

test("blank values count as missing", () => {
  const config = parseConfig({ DATABASE_URL: "  ", LOADOUT_ENGINE_URL: "", CLERK_SECRET_KEY: " " });
  assert.equal(config.databaseUrl, null);
  assert.equal(config.engineUrl, null);
  assert.equal(config.clerkSecretKey, null);
});

test("present values are read, and URLs lose trailing slashes", () => {
  const config = parseConfig({
    LOADOUT_ENGINE_URL: "https://engine.example.com//",
    LOADOUT_ENGINE_INTERNAL_URL: "http://engine.railway.internal:8080/",
    DATABASE_URL: "postgres://u:p@db/fits",
  });
  assert.equal(config.engineUrl, "https://engine.example.com");
  assert.equal(config.engineInternalUrl, "http://engine.railway.internal:8080");
  assert.equal(config.databaseUrl, "postgres://u:p@db/fits");
});

test("the server falls back to the public engine URL when no internal one is set", () => {
  const config = parseConfig({ LOADOUT_ENGINE_URL: "https://engine.example.com" });
  assert.equal(config.engineInternalUrl, "https://engine.example.com");
});

test("auth is enabled only when both Clerk keys are present", () => {
  const pk = { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_x" };
  const sk = { CLERK_SECRET_KEY: "sk_live_x" };
  assert.equal(parseConfig(pk).authEnabled, false);
  assert.equal(parseConfig(sk).authEnabled, false);
  assert.equal(parseConfig({ ...pk, ...sk }).authEnabled, true);
});

test("admin user ids are split on commas and trimmed", () => {
  const config = parseConfig({ SITE_ADMIN_USER_IDS: " user_1, user_2 ,,user_3" });
  assert.deepEqual(config.adminUserIds, ["user_1", "user_2", "user_3"]);
});

test("the public config carries no secret or server-only value", () => {
  const config = parseConfig({
    LOADOUT_ENGINE_URL: "https://engine.example.com",
    LOADOUT_ENGINE_INTERNAL_URL: "http://engine.railway.internal",
    DATABASE_URL: "postgres://u:p@db/fits",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_x",
    CLERK_SECRET_KEY: "sk_live_secret",
    SITE_ADMIN_USER_IDS: "user_1",
  });
  const publicConfig = toPublicConfig(config);
  assert.deepEqual(Object.keys(publicConfig).sort(), ["authEnabled", "clerkPublishableKey", "engineUrl"]);
  assert.equal(JSON.stringify(publicConfig).includes("secret"), false);
  assert.equal(JSON.stringify(publicConfig).includes("postgres"), false);
});
