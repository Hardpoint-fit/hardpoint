// Who is signed in and who may moderate. The session cookie is read through a one-method adapter so
// the rules are testable without Next. Pure (no server-only import); auth.ts wires the real adapter.
//
// Name and admin role are read from Clerk once, at sign-in ("Sign in with Citadel", oidc.ts), and
// carried in the session: a name or role changed in Clerk shows after the pilot signs in again.
// SITE_ADMIN_USER_IDS is read on every request.

import { AuthError } from "./auth-errors.ts";

export const FALLBACK_AUTHOR_NAME = "PILOT";

export type Author = { userId: string; name: string };

/** The parts of a Clerk user the site reads, as named in Clerk's userinfo. */
export type ClerkProfile = {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  publicMetadata: Readonly<Record<string, unknown>>;
};

/** What the session cookie says about the current request. */
export type SessionState = { userId: string; name: string; isAdminRole: boolean };

export type SessionAdapter = {
  /** The signed-in pilot of the current request, or null. */
  session(): Promise<SessionState | null>;
};

export type AuthSettings = { authEnabled: boolean; adminUserIds: readonly string[] };

/** Clerk username, else first and last name, else "PILOT". */
export function displayName(profile: Pick<ClerkProfile, "username" | "firstName" | "lastName"> | null): string {
  const username = profile?.username?.trim();
  if (username) return username;
  const full = [profile?.firstName, profile?.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return full || FALLBACK_AUTHOR_NAME;
}

/** Clerk public metadata `role: "admin"`. Unsafe metadata is user-writable and never consulted. */
export function hasAdminRole(profile: Pick<ClerkProfile, "publicMetadata"> | null): boolean {
  return profile?.publicMetadata.role === "admin";
}

export type Auth = {
  currentAuthor(): Promise<Author | null>;
  requireAuthor(): Promise<Author>;
  isAdmin(userId: string): Promise<boolean>;
  requireAdmin(): Promise<Author>;
};

type Outcome<T> = { ok: true; value: T } | { ok: false };

// Anything shaped like a token or a key, in case an error message quotes one.
const SECRET = /\b(?:eyJ[\w-]+\.[\w-]+\.[\w-]*|(?:sk|pk)_(?:live|test)_\w+|Bearer\s+\S+)/g;

/** What is logged of an auth failure: the error's class and message, tokens and keys redacted. */
export function describeAuthError(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name || error.name : typeof error;
  const message = error instanceof Error ? error.message : "";
  return `${name}: ${message.replace(SECRET, "[redacted]").slice(0, 300)}`;
}

async function attempt<T>(what: string, work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    // The adapter boundary: reads degrade and writes refuse, so this line is how a failure is seen.
    console.error(`auth ${what} failed:`, describeAuthError(error));
    return { ok: false };
  }
}

/**
 * One instance serves one request; the session is read once however many times callers ask. A
 * failure to read it never escapes as a plain error: reads degrade (signed out, not admin) and writes
 * refuse with a typed 503.
 */
export function createAuth(settings: AuthSettings, adapter: SessionAdapter): Auth {
  let pending: Promise<Outcome<SessionState | null>> | undefined;
  const session = () => (pending ??= attempt("session", () => adapter.session()));

  const auth: Auth = {
    async currentAuthor() {
      if (!settings.authEnabled) return null;
      const who = await session();
      return who.ok && who.value ? { userId: who.value.userId, name: who.value.name } : null;
    },

    async requireAuthor() {
      if (!settings.authEnabled) throw AuthError.unavailable();
      const who = await session();
      if (!who.ok) throw AuthError.outage();
      if (!who.value) throw AuthError.unauthenticated();
      return { userId: who.value.userId, name: who.value.name };
    },

    async isAdmin(userId) {
      if (!settings.authEnabled) return false;
      if (settings.adminUserIds.includes(userId)) return true;
      // The role is known only for the signed-in pilot, from their session.
      const who = await session();
      return who.ok && who.value?.userId === userId && who.value.isAdminRole;
    },

    async requireAdmin() {
      const author = await auth.requireAuthor();
      if (await auth.isAdmin(author.userId)) return author;
      throw AuthError.forbidden();
    },
  };
  return auth;
}
