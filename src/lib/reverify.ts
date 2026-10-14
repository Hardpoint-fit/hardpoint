// "RE-VERIFY TO MODERATE": the link a moderator whose admin role has expired (signed in with it more than a day
// ago, session.ts adminRoleOf) follows to sign in again. Every sign-in reads the role fresh from Clerk at the
// callback (oidc.ts completeSignIn), and Clerk signs a pilot it still holds a session for straight back in, so
// the pilot lands on `returnTo` with the role read anew. `reverify=1` names that intent: /auth/signin keeps it
// across its canonical-host restart and otherwise runs a normal sign-in. Pure, so views and tests share it.

export const REVERIFY_PARAM = "reverify";

/** The re-verify sign-in for a page; `returnTo` is checked again by /auth/signin (oidc.ts safeReturnTo). */
export function reverifyHref(returnTo: string): string {
  return `/auth/signin?${new URLSearchParams({ returnTo, [REVERIFY_PARAM]: "1" })}`;
}
