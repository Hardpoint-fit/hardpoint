import assert from "node:assert/strict";
import test from "node:test";
import { FALLBACK_AUTHOR_NAME, createAuth, displayName } from "./auth-core.ts";
import { AuthError, authErrorResponse, withAuthRefusal } from "./auth-errors.ts";

const profile = (over = {}) => ({ username: null, firstName: null, lastName: null, publicMetadata: {}, ...over });

/** An adapter that counts its calls and never touches the network. */
function fakeAdapter({ userId = "user_a", profiles = {} } = {}) {
  const calls = { session: 0, profile: 0 };
  return {
    calls,
    sessionUserId: async () => (calls.session++, userId),
    profile: async (id) => (calls.profile++, profiles[id] ?? null),
  };
}

const ON = { authEnabled: true, adminUserIds: [] };
const OFF = { authEnabled: false, adminUserIds: [] };

test("auth disabled: requireAuthor refuses with 503 and never calls Clerk", async () => {
  const adapter = fakeAdapter();
  const auth = createAuth(OFF, adapter);
  await assert.rejects(auth.requireAuthor(), (e) => e instanceof AuthError && e.status === 503 && e.message === "Sign-in isn't configured on this site yet");
  await assert.rejects(auth.requireAdmin(), (e) => e.status === 503);
  assert.equal(await auth.currentAuthor(), null);
  assert.equal(await auth.isAdmin("user_a"), false);
  assert.deepEqual(adapter.calls, { session: 0, profile: 0 });
});

test("signed out: requireAuthor refuses with 401, currentAuthor is null", async () => {
  const auth = createAuth(ON, fakeAdapter({ userId: null }));
  assert.equal(await auth.currentAuthor(), null);
  await assert.rejects(auth.requireAuthor(), (e) => e instanceof AuthError && e.status === 401);
});

test("signed in: author carries the Clerk display name, fetched once per instance", async () => {
  const adapter = fakeAdapter({ profiles: { user_a: profile({ username: "ahab" }) } });
  const auth = createAuth(ON, adapter);
  assert.deepEqual(await auth.requireAuthor(), { userId: "user_a", name: "ahab" });
  await auth.currentAuthor();
  await auth.isAdmin("user_a");
  assert.deepEqual(adapter.calls, { session: 1, profile: 1 });
});

test("display name: username, else first and last, else PILOT", () => {
  assert.equal(displayName(profile({ username: " ahab ", firstName: "A" })), "ahab");
  assert.equal(displayName(profile({ firstName: "Ada", lastName: "Lovelace" })), "Ada Lovelace");
  assert.equal(displayName(profile({ firstName: "Ada" })), "Ada");
  assert.equal(displayName(profile({ lastName: "Lovelace" })), "Lovelace");
  assert.equal(displayName(profile({ username: "  ", firstName: " " })), FALLBACK_AUTHOR_NAME);
  assert.equal(displayName(null), "PILOT");
});

test("admin: Clerk role admin, or listed in the env ids", async () => {
  const profiles = {
    mod: profile({ publicMetadata: { role: "admin" } }),
    plain: profile({ publicMetadata: { role: "member" } }),
    listed: profile(),
  };
  const auth = createAuth({ authEnabled: true, adminUserIds: ["listed"] }, fakeAdapter({ profiles }));
  assert.equal(await auth.isAdmin("mod"), true);
  assert.equal(await auth.isAdmin("listed"), true);
  assert.equal(await auth.isAdmin("plain"), false);
  assert.equal(await auth.isAdmin("ghost"), false);
});

test("the env list needs no Clerk lookup", async () => {
  const adapter = fakeAdapter();
  const auth = createAuth({ authEnabled: true, adminUserIds: ["listed"] }, adapter);
  assert.equal(await auth.isAdmin("listed"), true);
  assert.equal(adapter.calls.profile, 0);
});

test("requireAdmin: 403 for a plain user, the author for an admin", async () => {
  const plain = createAuth(ON, fakeAdapter({ profiles: { user_a: profile() } }));
  await assert.rejects(plain.requireAdmin(), (e) => e.status === 403);
  const admin = createAuth(ON, fakeAdapter({ profiles: { user_a: profile({ publicMetadata: { role: "admin" } }) } }));
  assert.equal((await admin.requireAdmin()).userId, "user_a");
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
