// Who is signed in and who may moderate. The Clerk SDK sits behind a two-method adapter so the
// rules are testable without the network. Pure (no server-only import); auth.ts wires the real adapter.

import { AuthError } from "./auth-errors.ts";

export const FALLBACK_AUTHOR_NAME = "PILOT";

export type Author = { userId: string; name: string };

/** The parts of a Clerk user the site reads. */
export type ClerkProfile = {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  publicMetadata: Readonly<Record<string, unknown>>;
};

export type ClerkAdapter = {
  /** The signed-in user id of the current request, or null. */
  sessionUserId(): Promise<string | null>;
  /** The Clerk user, or null if it no longer exists. */
  profile(userId: string): Promise<ClerkProfile | null>;
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

async function attempt<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch {
    return { ok: false };
  }
}

/**
 * One instance serves one request: the session and profile lookups are memoized on it, so
 * name and role cost one Clerk call however many times callers ask. A Clerk failure never
 * escapes as a plain error: reads degrade (signed out, name "PILOT", not admin) and writes
 * refuse with a typed 503.
 */
export function createAuth(settings: AuthSettings, adapter: ClerkAdapter): Auth {
  const profiles = new Map<string, Promise<Outcome<ClerkProfile | null>>>();
  let session: Promise<Outcome<string | null>> | undefined;

  const profileOf = (userId: string) => {
    let pending = profiles.get(userId);
    if (!pending) profiles.set(userId, (pending = attempt(() => adapter.profile(userId))));
    return pending;
  };

  /** The signed-in author, "signed-out", or "outage" when Clerk failed; `lenient` names a user whose profile failed "PILOT". */
  const resolve = async (lenient: boolean): Promise<Author | "signed-out" | "outage"> => {
    const who = await (session ??= attempt(() => adapter.sessionUserId()));
    if (!who.ok) return "outage";
    if (!who.value) return "signed-out";
    const profile = await profileOf(who.value);
    if (!profile.ok) return lenient ? { userId: who.value, name: FALLBACK_AUTHOR_NAME } : "outage";
    return { userId: who.value, name: displayName(profile.value) };
  };

  const auth: Auth = {
    async currentAuthor() {
      if (!settings.authEnabled) return null;
      const result = await resolve(true);
      return typeof result === "string" ? null : result;
    },

    async requireAuthor() {
      if (!settings.authEnabled) throw AuthError.unavailable();
      const result = await resolve(false);
      if (result === "outage") throw AuthError.outage();
      if (result === "signed-out") throw AuthError.unauthenticated();
      return result;
    },

    async isAdmin(userId) {
      if (!settings.authEnabled) return false;
      if (settings.adminUserIds.includes(userId)) return true;
      const profile = await profileOf(userId);
      return profile.ok && hasAdminRole(profile.value);
    },

    async requireAdmin() {
      const author = await auth.requireAuthor();
      if (settings.adminUserIds.includes(author.userId)) return author;
      const profile = await profileOf(author.userId);
      if (!profile.ok) throw AuthError.outage();
      if (!hasAdminRole(profile.value)) throw AuthError.forbidden();
      return author;
    },
  };
  return auth;
}
