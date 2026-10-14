// "Sign in with Citadel" end to end against a local fake provider: the /auth/* handlers, the cookies
// they set, and what auth-core reads back from the session.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createAuth } from "./auth-core.ts";
import { AuthError } from "./auth-errors.ts";
import { canonicalRedirect, handleCallback, handleSignIn, handleSignOut, refreshedSessionCookie } from "./auth-routes.ts";
import { parseConfig } from "./config.ts";
import { startFakeIdp } from "./fake-idp.mjs";
import { forgetProviders, safeReturnTo } from "./oidc.ts";
import { SESSION_COOKIE, SIGN_IN_COOKIE, openSession, readCookie, sealSession } from "./session.ts";

const DAY = 24 * 3600;

const SITE = "https://fits.test";
const SESSION_SECRET = Buffer.alloc(48, 7).toString("base64");

let idp;
let config;
before(async () => {
  idp = await startFakeIdp();
});
after(() => idp.close());
beforeEach(() => {
  forgetProviders();
  idp.idTokenClaims = {};
  idp.signWithOtherKey = false;
  idp.tokenStatus = null;
  idp.user = { ...idp.user, sub: "user_2fakePilot", user_id: "user_2fakePilot", preferred_username: "ahab", public_metadata: {}, unsafe_metadata: {} };
  config = parseConfig({
    CITADEL_OAUTH_ISSUER: idp.issuer,
    CITADEL_OAUTH_CLIENT_ID: idp.clientId,
    CITADEL_OAUTH_CLIENT_SECRET: idp.clientSecret,
    SESSION_SECRET,
    SITE_URL: SITE,
  });
});

const get = (path, { host = "fits.test", cookie } = {}) =>
  new Request(`${SITE}${path}`, { headers: { host, ...(cookie ? { cookie } : {}) } });

/** Every Set-Cookie of a response as { name: { value, attributes } }. */
function setCookies(response) {
  const out = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(";").map((part) => part.trim());
    const at = pair.indexOf("=");
    out[pair.slice(0, at)] = { value: pair.slice(at + 1), attributes };
  }
  return out;
}

/** /auth/signin -> the provider -> /auth/callback. Returns the callback's response. */
async function signIn({ returnTo = "/fits/abc?x=1", tamper } = {}) {
  const start = await handleSignIn(get(`/auth/signin?returnTo=${encodeURIComponent(returnTo)}`), config);
  assert.equal(start.status, 302);
  const transaction = setCookies(start)[SIGN_IN_COOKIE];
  assert.ok(transaction, "the sign-in cookie is set");
  let back = idp.authorize(start.headers.get("location"));
  let cookie = `${SIGN_IN_COOKIE}=${transaction.value}`;
  ({ back, cookie } = tamper?.({ back, cookie }) ?? { back, cookie });
  return handleCallback(get(`${back.pathname}${back.search}`, { cookie }), config);
}

async function sessionOf(response) {
  const cookie = setCookies(response)[SESSION_COOKIE];
  return cookie?.value ? openSession(config.sessionSecret, cookie.value) : null;
}

function authFrom(opened, settings = { authEnabled: true, adminUserIds: [] }) {
  return createAuth(settings, { session: async () => (opened ? { ...opened.session } : null) });
}

test("returnTo: same-site relative paths only", () => {
  assert.equal(safeReturnTo("/fits/abc?sort=new#c1"), "/fits/abc?sort=new#c1");
  assert.equal(safeReturnTo("/"), "/");
  for (const attack of [
    "https://evil.example/",
    "//evil.example/x",
    "/\\evil.example",
    "\\\\evil.example",
    "/%5Cevil.example".replace("%5C", "\\"),
    "javascript:alert(1)",
    "evil.example",
    "/\tevil",
    "/x\nSet-Cookie: a=b",
    "http:/evil.example",
    // Normalising these yields "//evil.com".
    "/.//evil.com",
    "/%2e//evil.com",
    "/a/..//evil.com",
    "/auth/signin?returnTo=//evil",
    "/auth/callback",
    "",
    null,
    undefined,
    `/${"a".repeat(3000)}`,
  ]) {
    assert.equal(safeReturnTo(attack), "/", JSON.stringify(attack));
  }
});

test("sign-in: PKCE S256, state and nonce go to the provider; the transaction is an encrypted host-only cookie", async () => {
  const response = await handleSignIn(get("/auth/signin?returnTo=%2Ffits%2Fabc"), config);
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, idp.issuer);
  const p = location.searchParams;
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("client_id"), idp.clientId);
  assert.equal(p.get("redirect_uri"), `${SITE}/auth/callback`);
  assert.equal(p.get("scope"), "openid profile public_metadata");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.match(p.get("code_challenge"), /^[\w-]{43}$/);
  assert.ok(p.get("state") && p.get("nonce"));
  const cookie = setCookies(response)[SIGN_IN_COOKIE];
  assert.deepEqual(cookie.attributes, ["Path=/", "Max-Age=600", "HttpOnly", "Secure", "SameSite=Lax"]);
  assert.equal(cookie.value.split(".").length, 5, "a compact JWE");
  assert.ok(!cookie.value.includes(p.get("state")), "the state is not readable in the cookie");
});

test("sign-in begun on another host restarts on the canonical one, keeping only a safe returnTo", async () => {
  for (const host of ["www.fits.test", "fits.alpha.thecitadel.com", "site-production-ed67.up.railway.app"]) {
    const response = await handleSignIn(get("/auth/signin?returnTo=%2Fu%2Fuser_a", { host }), config);
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), `${SITE}/auth/signin?returnTo=%2Fu%2Fuser_a`);
    assert.equal(setCookies(response)[SIGN_IN_COOKIE], undefined);
  }
  const evil = await handleSignIn(get("/auth/signin?returnTo=https%3A%2F%2Fevil.example", { host: "www.fits.test" }), config);
  assert.equal(evil.headers.get("location"), `${SITE}/auth/signin?returnTo=%2F`);
});

test("good sign-in: a 30-day session cookie, then currentAuthor is { userId: sub, name }", async () => {
  const response = await signIn();
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${SITE}/fits/abc?x=1`);
  const cookies = setCookies(response);
  assert.deepEqual(cookies[SESSION_COOKIE].attributes, ["Path=/", "Max-Age=2592000", "HttpOnly", "Secure", "SameSite=Lax"]);
  assert.equal(cookies[SIGN_IN_COOKIE].value, "", "the sign-in transaction is cleared");
  const opened = await sessionOf(response);
  assert.equal(opened.session.userId, "user_2fakePilot");
  assert.equal(opened.session.isAdminRole, false);
  const auth = authFrom(opened);
  assert.deepEqual(await auth.currentAuthor(), { userId: "user_2fakePilot", name: "ahab" });
  assert.deepEqual(await auth.requireAuthor(), { userId: "user_2fakePilot", name: "ahab" });
  assert.equal(await auth.isAdmin("user_2fakePilot"), false);
});

test("display name: username, else given and family name, else PILOT", async () => {
  idp.user = { ...idp.user, preferred_username: null, username: null };
  assert.equal((await sessionOf(await signIn())).session.name, "Ada Lovelace");
  idp.user = { ...idp.user, given_name: null, family_name: null };
  assert.equal((await sessionOf(await signIn())).session.name, "PILOT");
});

test("admin comes from public metadata only; an unsafe-metadata role is ignored", async () => {
  idp.user = { ...idp.user, public_metadata: {}, unsafe_metadata: { role: "admin" } };
  const forged = await sessionOf(await signIn());
  assert.equal(forged.session.isAdminRole, false);
  await assert.rejects(authFrom(forged).requireAdmin(), (e) => e instanceof AuthError && e.status === 403);

  idp.user = { ...idp.user, public_metadata: { role: "admin" }, unsafe_metadata: {} };
  const admin = await sessionOf(await signIn());
  assert.equal(admin.session.isAdminRole, true);
  assert.equal((await authFrom(admin).requireAdmin()).userId, "user_2fakePilot");
  assert.equal(await authFrom(admin).isAdmin("user_someoneElse"), false, "the session's role is only its own");
});

test("SITE_ADMIN_USER_IDS still grants admin", async () => {
  const opened = await sessionOf(await signIn());
  const auth = authFrom(opened, { authEnabled: true, adminUserIds: ["user_2fakePilot"] });
  assert.equal((await auth.requireAdmin()).userId, "user_2fakePilot");
});

/** A callback that must be refused: 400 "Sign-in didn't complete", no session, the transaction cleared. */
async function assertRefused(response, status = 400) {
  assert.equal(response.status, status);
  const cookies = setCookies(response);
  assert.equal(cookies[SESSION_COOKIE], undefined, "no session is set");
  assert.equal(cookies[SIGN_IN_COOKIE].value, "", "the transaction is cleared");
  assert.match(await response.text(), status === 503 ? /Sign-in is unavailable right now/ : /Sign-in didn&#39;t complete/);
}

test("state mismatch is refused", async (t) => {
  t.mock.method(console, "error", (...a) => process.env.SHOW_REFUSALS && process.stderr.write(a.join(" ") + "\n"));
  const response = await signIn({
    tamper: ({ back, cookie }) => {
      back.searchParams.set("state", "forged-state");
      return { back, cookie };
    },
  });
  await assertRefused(response);
});

test("a callback without the sign-in cookie (another browser, or expired) is refused before any token request", async (t) => {
  t.mock.method(console, "error", (...a) => process.env.SHOW_REFUSALS && process.stderr.write(a.join(" ") + "\n"));
  const before = idp.tokenRequests;
  await assertRefused(await signIn({ tamper: ({ back }) => ({ back, cookie: "" }) }));
  await assertRefused(await signIn({ tamper: ({ back }) => ({ back, cookie: `${SIGN_IN_COOKIE}=garbage` }) }));
  assert.equal(idp.tokenRequests, before);
});

test("a sign-in cookie from another sign-in (PKCE verifier and nonce don't match the code) is refused", async (t) => {
  t.mock.method(console, "error", (...a) => process.env.SHOW_REFUSALS && process.stderr.write(a.join(" ") + "\n"));
  const other = setCookies(await handleSignIn(get("/auth/signin"), config))[SIGN_IN_COOKIE].value;
  // The code was issued against the first transaction; present the second's cookie with its own state.
  const response = await signIn({
    tamper: ({ back }) => {
      return { back, cookie: `${SIGN_IN_COOKIE}=${other}` };
    },
  });
  await assertRefused(response);
});

test("PKCE: a code redeemed with the wrong verifier is refused by the provider", async (t) => {
  t.mock.method(console, "error", (...a) => process.env.SHOW_REFUSALS && process.stderr.write(a.join(" ") + "\n"));
  const start = await handleSignIn(get("/auth/signin"), config);
  const location = new URL(start.headers.get("location"));
  // Swap the challenge for one the site's verifier can't match, as an attacker injecting their own code would.
  location.searchParams.set("code_challenge", "A".repeat(43));
  const back = idp.authorize(location);
  const cookie = `${SIGN_IN_COOKIE}=${setCookies(start)[SIGN_IN_COOKIE].value}`;
  await assertRefused(await handleCallback(get(`${back.pathname}${back.search}`, { cookie }), config));
});

test("the ID token is refused for a bad signature, wrong iss, wrong aud, expiry or a wrong nonce", async (t) => {
  t.mock.method(console, "error", (...a) => process.env.SHOW_REFUSALS && process.stderr.write(a.join(" ") + "\n"));
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    ["bad signature", () => (idp.signWithOtherKey = true)],
    ["wrong iss", () => (idp.idTokenClaims = { iss: "https://clerk.evil.example" })],
    ["wrong aud", () => (idp.idTokenClaims = { aud: "someone_else" })],
    ["expired", () => (idp.idTokenClaims = { iat: now - 7200, exp: now - 3600 })],
    ["wrong nonce", () => (idp.idTokenClaims = { nonce: "replayed-nonce" })],
    ["no nonce", () => (idp.idTokenClaims = { nonce: undefined })],
    ["sub is not a Clerk user id", () => (idp.idTokenClaims = { sub: "admin" })],
  ];
  for (const [name, bend] of cases) {
    idp.idTokenClaims = {};
    idp.signWithOtherKey = false;
    bend();
    const response = await signIn();
    assert.equal(response.status, 400, name);
    assert.equal(setCookies(response)[SESSION_COOKIE], undefined, `${name}: no session`);
  }
});

test("userinfo for another subject is refused", async (t) => {
  t.mock.method(console, "error", (...a) => process.env.SHOW_REFUSALS && process.stderr.write(a.join(" ") + "\n"));
  idp.user = { ...idp.user, sub: "user_2someoneElse", user_id: "user_2someoneElse" };
  idp.idTokenClaims = { sub: "user_2fakePilot" };
  await assertRefused(await signIn());
});

test("the provider refusing consent, or failing, shows a page instead of a session", async (t) => {
  t.mock.method(console, "error", (...a) => process.env.SHOW_REFUSALS && process.stderr.write(a.join(" ") + "\n"));
  const start = await handleSignIn(get("/auth/signin"), config);
  const back = idp.authorize(start.headers.get("location"), { deny: true });
  const cookie = `${SIGN_IN_COOKIE}=${setCookies(start)[SIGN_IN_COOKIE].value}`;
  const denied = await handleCallback(get(`${back.pathname}${back.search}`, { cookie }), config);
  await assertRefused(denied);

  idp.tokenStatus = 503;
  await assertRefused(await signIn(), 503);
});

test("the provider down at sign-in start: 503, no cookie", async (t) => {
  t.mock.method(console, "error", (...a) => process.env.SHOW_REFUSALS && process.stderr.write(a.join(" ") + "\n"));
  const down = { ...config, oauthIssuer: "http://127.0.0.1:9" };
  const response = await handleSignIn(get("/auth/signin"), down);
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Sign-in is unavailable right now/);
  assert.equal(setCookies(response)[SIGN_IN_COOKIE], undefined);
});

test("a session cookie can't be forged or altered, and one sealed with another secret is ignored", async () => {
  const opened = await sessionOf(await signIn());
  const sealed = await sealSession(config.sessionSecret, opened.session);
  assert.ok(await openSession(config.sessionSecret, sealed));
  const flipped = sealed.slice(0, -3) + (sealed.endsWith("A") ? "BBB" : "AAA");
  assert.equal(await openSession(config.sessionSecret, flipped), null);
  assert.equal(await openSession(new Uint8Array(32).fill(1), sealed), null);
  // A sign-in transaction is not a session, even under the same secret.
  const transaction = setCookies(await handleSignIn(get("/auth/signin"), config))[SIGN_IN_COOKIE].value;
  assert.equal(await openSession(config.sessionSecret, transaction), null);
});

test("rolling expiry: a cookie a day old is re-issued, keeping its sign-in time; a fresh one isn't", async () => {
  const opened = await sessionOf(await signIn());
  const now = Math.floor(Date.now() / 1000);
  const signedInAt = now - 2 * DAY;
  const old = await sealSession(config.sessionSecret, { ...opened.session, issuedAt: signedInAt }, now - 2 * DAY);
  const refreshed = await refreshedSessionCookie(get("/", { cookie: `${SESSION_COOKIE}=${old}` }), config, now);
  // The cookie lives only until 30 days after sign-in, not 30 days from now.
  assert.match(refreshed, new RegExp(`^__Host-citadel-session=.+; Path=/; Max-Age=${28 * DAY}; HttpOnly; Secure; SameSite=Lax$`));
  const reopened = await openSession(config.sessionSecret, readCookie(refreshed.split(";")[0], SESSION_COOKIE), now);
  assert.equal(reopened.refreshedAt, now);
  assert.equal(reopened.session.issuedAt, signedInAt, "refreshing never moves the sign-in time");
  const fresh = await sealSession(config.sessionSecret, opened.session, now - 60);
  assert.equal(await refreshedSessionCookie(get("/", { cookie: `${SESSION_COOKIE}=${fresh}` }), config, now), null);
  assert.equal(await refreshedSessionCookie(get("/"), config, now), null);
});

test("a session ends 30 days after sign-in however often it was renewed, and its cookie is cleared", async () => {
  const opened = await sessionOf(await signIn());
  const now = Math.floor(Date.now() / 1000);
  // Renewed an hour ago, signed in 30 days and a minute ago.
  const stale = await sealSession(config.sessionSecret, { ...opened.session, issuedAt: now - 30 * DAY - 60 }, now - 3600);
  assert.equal(await openSession(config.sessionSecret, stale, now), null, "read as signed out");
  const cleared = await refreshedSessionCookie(get("/", { cookie: `${SESSION_COOKIE}=${stale}` }), config, now);
  assert.match(cleared, /^__Host-citadel-session=; Path=\/; Max-Age=0;/);
  // Just inside the limit it still opens.
  const inside = await sealSession(config.sessionSecret, { ...opened.session, issuedAt: now - 30 * DAY + 60 }, now - 3600);
  assert.ok(await openSession(config.sessionSecret, inside, now));
  // A tampered cookie is cleared too.
  assert.match(await refreshedSessionCookie(get("/", { cookie: `${SESSION_COOKIE}=garbage` }), config, now), /Max-Age=0/);
});

test("the admin role from sign-in counts for 24 hours; then moderation needs a new sign-in (the env list is unaffected)", async () => {
  idp.user = { ...idp.user, public_metadata: { role: "admin" } };
  const opened = await sessionOf(await signIn());
  const now = Math.floor(Date.now() / 1000);
  const recent = await sealSession(config.sessionSecret, { ...opened.session, issuedAt: now - DAY + 60 }, now - 60);
  const recentOpened = await openSession(config.sessionSecret, recent, now);
  assert.equal(recentOpened.session.isAdminRole, true);
  assert.equal((await authFrom(recentOpened).requireAdmin()).userId, "user_2fakePilot");

  const dayOld = await sealSession(config.sessionSecret, { ...opened.session, issuedAt: now - DAY - 60 }, now - 60);
  const dayOldOpened = await openSession(config.sessionSecret, dayOld, now);
  assert.equal(dayOldOpened.session.isAdminRole, false);
  assert.equal(dayOldOpened.session.userId, "user_2fakePilot", "still signed in, just not admin");
  await assert.rejects(authFrom(dayOldOpened).requireAdmin(), (e) => e instanceof AuthError && e.status === 403);
  const listed = authFrom(dayOldOpened, { authEnabled: true, adminUserIds: ["user_2fakePilot"] });
  assert.equal((await listed.requireAdmin()).userId, "user_2fakePilot");
});

const post = (headers, body = new URLSearchParams({ returnTo: "/fits/abc" })) =>
  new Request(`${SITE}/auth/signout`, { method: "POST", headers: { host: "fits.test", "content-type": "application/x-www-form-urlencoded", ...headers }, body });

test("sign-out from the site clears the session cookie and returns to the page", async () => {
  for (const headers of [{ origin: SITE }, { "sec-fetch-site": "same-origin" }]) {
    const response = await handleSignOut(post(headers), config);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${SITE}/fits/abc`);
    const cleared = setCookies(response)[SESSION_COOKIE];
    assert.equal(cleared.value, "");
    assert.ok(cleared.attributes.includes("Max-Age=0"));
  }
  for (const returnTo of ["//evil.example", "/.//evil.com", "/%2e//evil.com", "/a/..//evil.com"]) {
    const evil = await handleSignOut(post({ origin: SITE }, new URLSearchParams({ returnTo })), config);
    assert.equal(evil.headers.get("location"), `${SITE}/`, returnTo);
  }
});

test("sign-out is CSRF-safe: a cross-site or unlabelled POST is refused and clears nothing", async () => {
  for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, {}]) {
    const response = await handleSignOut(post(headers), config);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(setCookies(response)[SESSION_COOKIE], undefined);
  }
});

test("auth disabled: the auth routes answer 503 and writes still refuse with 503", async () => {
  const off = parseConfig({ SITE_URL: SITE });
  for (const handler of [handleSignIn, handleCallback]) {
    const response = await handler(get("/auth/signin"), off);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /Sign-in isn&#39;t configured on this site yet/);
  }
  const auth = createAuth(off, { session: async () => ({ userId: "user_a", name: "a", isAdminRole: true }) });
  await assert.rejects(auth.requireAuthor(), (e) => e.status === 503 && e.message === "Sign-in isn't configured on this site yet");
  assert.equal(await auth.currentAuthor(), null);
  assert.equal(await refreshedSessionCookie(get("/"), off), null);
});

test("www.<canonical host> redirects to the canonical origin with path and query; other hosts don't", () => {
  const apex = parseConfig({ SITE_URL: "https://hardpoint.fit/" });
  const at = (host, path) => canonicalRedirect(new Request(`http://internal:3000${path}`, { headers: { host } }), apex);
  assert.equal(at("www.hardpoint.fit", "/x?y=1"), "https://hardpoint.fit/x?y=1");
  assert.equal(at("WWW.HARDPOINT.FIT", "/"), "https://hardpoint.fit/");
  assert.equal(at("www.hardpoint.fit", "/art/a.webp"), "https://hardpoint.fit/art/a.webp");
  assert.equal(at("hardpoint.fit", "/x"), null);
  assert.equal(at("fits.alpha.thecitadel.com", "/x"), null);
  assert.equal(at("site-production-ed67.up.railway.app", "/x"), null);
});
