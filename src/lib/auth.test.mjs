import assert from "node:assert/strict";
import test from "node:test";
import { FALLBACK_AUTHOR_NAME, createAuth, describeAuthError, displayName, hasAdminRole } from "./auth-core.ts";
import { AuthError, authErrorResponse, withAuthRefusal } from "./auth-errors.ts";

const profile = (over = {}) => ({ username: null, firstName: null, lastName: null, publicMetadata: {}, ...over });

/** An adapter that counts its reads and never touches a cookie. */
function fakeAdapter(session = { userId: "user_a", name: "ahab", adminRole: "none" }) {
  const calls = { session: 0 };
  return { calls, session: async () => (calls.session++, session) };
}

const ON = { authEnabled: true, adminUserIds: [] };
const OFF = { authEnabled: false, adminUserIds: [] };

test("auth disabled: requireAuthor refuses with 503 and never reads the session", async () => {
  const adapter = fakeAdapter();
  const auth = createAuth(OFF, adapter);
  await assert.rejects(auth.requireAuthor(), (e) => e instanceof AuthError && e.status === 503 && e.message === "Sign-in isn't configured on this site yet");
  await assert.rejects(auth.requireAdmin(), (e) => e.status === 503);
  assert.equal(await auth.currentAuthor(), null);
  assert.equal(await auth.isAdmin("user_a"), false);
  assert.equal(adapter.calls.session, 0);
});

test("signed out: requireAuthor refuses with 401, currentAuthor is null", async () => {
  const auth = createAuth(ON, fakeAdapter(null));
  assert.equal(await auth.currentAuthor(), null);
  await assert.rejects(auth.requireAuthor(), (e) => e instanceof AuthError && e.status === 401);
});

test("signed in: the author is the session's id and name, read once per instance", async () => {
  const adapter = fakeAdapter();
  const auth = createAuth(ON, adapter);
  assert.deepEqual(await auth.requireAuthor(), { userId: "user_a", name: "ahab" });
  await auth.currentAuthor();
  await auth.isAdmin("user_a");
  assert.equal(adapter.calls.session, 1);
});

test("display name: username, else first and last, else PILOT", () => {
  assert.equal(displayName(profile({ username: " ahab ", firstName: "A" })), "ahab");
  assert.equal(displayName(profile({ firstName: "Ada", lastName: "Lovelace" })), "Ada Lovelace");
  assert.equal(displayName(profile({ firstName: "Ada" })), "Ada");
  assert.equal(displayName(profile({ lastName: "Lovelace" })), "Lovelace");
  assert.equal(displayName(profile({ username: "  ", firstName: " " })), FALLBACK_AUTHOR_NAME);
  assert.equal(displayName(null), "PILOT");
});

test("admin role: public metadata role admin only", () => {
  assert.equal(hasAdminRole(profile({ publicMetadata: { role: "admin" } })), true);
  assert.equal(hasAdminRole(profile({ publicMetadata: { role: "member" } })), false);
  assert.equal(hasAdminRole(null), false);
});

test("admin: the session's role, or listed in the env ids", async () => {
  const mod = createAuth(ON, fakeAdapter({ userId: "mod", name: "m", adminRole: "active" }));
  assert.equal(await mod.isAdmin("mod"), true);
  assert.equal(await mod.isAdmin("someone_else"), false);
  const listed = createAuth({ authEnabled: true, adminUserIds: ["listed"] }, fakeAdapter({ userId: "plain", name: "p", adminRole: "none" }));
  assert.equal(await listed.isAdmin("listed"), true);
  assert.equal(await listed.isAdmin("plain"), false);
});

test("requireAdmin: 403 for a plain user, the author for an admin", async () => {
  await assert.rejects(createAuth(ON, fakeAdapter()).requireAdmin(), (e) => e.status === 403);
  const admin = createAuth(ON, fakeAdapter({ userId: "user_a", name: "a", adminRole: "active" }));
  assert.equal((await admin.requireAdmin()).userId, "user_a");
  const listed = createAuth({ authEnabled: true, adminUserIds: ["user_a"] }, fakeAdapter());
  assert.equal((await listed.requireAdmin()).userId, "user_a");
});

test("error to status: each AuthError maps to its HTTP response", async () => {
  for (const [error, status, reason] of [
    [AuthError.unauthenticated(), 401, "unauthenticated"],
    [AuthError.forbidden(), 403, "forbidden"],
    [AuthError.unavailable(), 503, "auth_unavailable"],
  ]) {
    const response = authErrorResponse(error);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: reason, message: error.message });
  }
  assert.equal(authErrorResponse(new Error("boom")), null);
});

test("withAuthRefusal turns an AuthError into a refusal value and rethrows anything else", async () => {
  assert.deepEqual(await withAuthRefusal(async () => ({ ok: true })), { ok: true });
  assert.deepEqual(
    await withAuthRefusal(async () => {
      throw AuthError.unavailable();
    }),
    { ok: false, reason: "auth_unavailable", status: 503, message: "Sign-in isn't configured on this site yet" },
  );
  await assert.rejects(
    withAuthRefusal(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
});

test("an unreadable session: reads degrade to signed out, writes refuse with 503", async (t) => {
  t.mock.method(console, "error", () => {});
  const auth = createAuth(ON, {
    session: async () => {
      throw new Error("cookie store down");
    },
  });
  assert.equal(await auth.currentAuthor(), null);
  assert.equal(await auth.isAdmin("user_a"), false);
  await assert.rejects(auth.requireAuthor(), (e) => e instanceof AuthError && e.status === 503 && e.message === "Sign-in is unavailable right now");
  await assert.rejects(auth.requireAdmin(), (e) => e.status === 503);
});

test("an auth failure is logged by class and message, with tokens and keys redacted", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  class OAuthTrouble extends Error {}
  const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyX2EifQ.c2lnbmF0dXJl";
  const auth = createAuth(ON, {
    session: async () => {
      throw new OAuthTrouble(`Unauthorized: token ${token} with sk_live_abc123 and Bearer abc.def rejected`);
    },
  });
  assert.equal(await auth.currentAuthor(), null);
  assert.equal(logged.mock.callCount(), 1);
  const line = logged.mock.calls[0].arguments.join(" ");
  assert.match(line, /^auth session failed: OAuthTrouble: Unauthorized: token \[redacted\] with \[redacted\] and \[redacted\] rejected$/);
  assert.equal(describeAuthError("plain"), "string: ");
});
