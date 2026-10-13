import "server-only";
import { auth as clerkAuth, createClerkClient } from "@clerk/nextjs/server";
import { cache } from "react";
import { createAuth, type Author, type ClerkAdapter } from "./auth-core.ts";
import { getConfig } from "./site-config";

export { AuthError, authErrorResponse, withAuthRefusal } from "./auth-errors.ts";
export type { Author } from "./auth-core.ts";

// Clerk is only imported by this module and only called once keys exist, so a site without keys never runs it.
function clerkAdapter(secretKey: string, publishableKey: string): ClerkAdapter {
  const client = createClerkClient({ secretKey, publishableKey });
  return {
    async sessionUserId() {
      return (await clerkAuth()).userId;
    },
    async profile(userId) {
      try {
        const user = await client.users.getUser(userId);
        return {
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          publicMetadata: user.publicMetadata,
        };
      } catch (error) {
        // A deleted user is "no profile"; an outage must not be mistaken for one.
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    },
  };
}

/** React's cache() memoizes only during an RSC render; route handlers and server actions get a fresh instance per call, so there the name and role are fetched again. */
const forRequest = cache(() => {
  const config = getConfig();
  const adapter =
    config.authEnabled && config.clerkSecretKey && config.clerkPublishableKey
      ? clerkAdapter(config.clerkSecretKey, config.clerkPublishableKey)
      : { sessionUserId: async () => null, profile: async () => null };
  return createAuth(config, adapter);
});

/** The signed-in author, or null when signed out or sign-in isn't configured. */
export const currentAuthor = (): Promise<Author | null> => forRequest().currentAuthor();
/** Throws AuthError 503 when sign-in isn't configured, 401 when signed out. */
export const requireAuthor = (): Promise<Author> => forRequest().requireAuthor();
/** Clerk `admin` role in publicMetadata, or listed in SITE_ADMIN_USER_IDS. */
export const isAdmin = (userId: string): Promise<boolean> => forRequest().isAdmin(userId);
/** requireAuthor plus admin; throws AuthError 403 for other users. */
export const requireAdmin = (): Promise<Author> => forRequest().requireAdmin();
