import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { createAuth, type Author, type SessionAdapter } from "./auth-core.ts";
import { SESSION_COOKIE, openSession } from "./session.ts";
import { getConfig } from "./site-config";

export { AuthError, authErrorResponse, withAuthRefusal } from "./auth-errors.ts";
export type { Author } from "./auth-core.ts";

/** The session cookie set by /auth/callback ("Sign in with Citadel"). No network call: name and role are in it. */
function cookieAdapter(secret: Uint8Array): SessionAdapter {
  return {
    async session() {
      const opened = await openSession(secret, (await cookies()).get(SESSION_COOKIE)?.value);
      return opened ? { userId: opened.session.userId, name: opened.session.name, isAdminRole: opened.session.isAdminRole } : null;
    },
  };
}

/** React's cache() memoizes only during an RSC render; route handlers and server actions get a fresh instance per call. */
const forRequest = cache(() => {
  const config = getConfig();
  const adapter: SessionAdapter = config.authEnabled && config.sessionSecret ? cookieAdapter(config.sessionSecret) : { session: async () => null };
  return createAuth(config, adapter);
});

/** The signed-in author, or null when signed out or sign-in isn't configured. */
export const currentAuthor = (): Promise<Author | null> => forRequest().currentAuthor();
/** Throws AuthError 503 when sign-in isn't configured, 401 when signed out. */
export const requireAuthor = (): Promise<Author> => forRequest().requireAuthor();
/** Clerk `admin` role in public metadata (as of sign-in), or listed in SITE_ADMIN_USER_IDS. */
export const isAdmin = (userId: string): Promise<boolean> => forRequest().isAdmin(userId);
/** requireAuthor plus admin; throws AuthError 403 for other users. */
export const requireAdmin = (): Promise<Author> => forRequest().requireAdmin();
