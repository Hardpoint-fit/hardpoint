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

/**
 * One instance serves one request: the session and profile lookups are memoized on it, so
 * name and role cost one Clerk call however many times callers ask.
 */
export function createAuth(settings: AuthSettings, adapter: ClerkAdapter): Auth {
  const profiles = new Map<string, Promise<ClerkProfile | null>>();
  let session: Promise<string | null> | undefined;

  const profileOf = (userId: string) => {
    let pending = profiles.get(userId);
    if (!pending) profiles.set(userId, (pending = adapter.profile(userId)));
    return pending;
  };

  const auth: Auth = {
    async currentAuthor() {
      if (!settings.authEnabled) return null;
      const userId = await (session ??= adapter.sessionUserId());
      if (!userId) return null;
      return { userId, name: displayName(await profileOf(userId)) };
    },

    async requireAuthor() {
      if (!settings.authEnabled) throw AuthError.unavailable();
      const author = await auth.currentAuthor();
      if (!author) throw AuthError.unauthenticated();
      return author;
    },

    async isAdmin(userId) {
      if (!settings.authEnabled) return false;
      if (settings.adminUserIds.includes(userId)) return true;
      return hasAdminRole(await profileOf(userId));
    },

    async requireAdmin() {
      const author = await auth.requireAuthor();
      if (!(await auth.isAdmin(author.userId))) throw AuthError.forbidden();
      return author;
    },
  };
  return auth;
}
