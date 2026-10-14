"use client";

import { usePathname, useSearchParams } from "next/navigation";

/** The page to come back to after signing in or out: this one. */
function useReturnTo(): string {
  const pathname = usePathname() ?? "/";
  const query = useSearchParams()?.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** "Sign in with Citadel": a plain link to /auth/signin, which hands over to Citadel's sign-in page. */
export function SignInLink() {
  const returnTo = useReturnTo();
  return (
    <a className="btn" href={`/auth/signin?${new URLSearchParams({ returnTo })}`}>
      Sign in
    </a>
  );
}

/** The signed-in pilot's name and a sign-out form (POST, so a link elsewhere can't sign anyone out). */
export function SignedIn({ name }: { name: string }) {
  const returnTo = useReturnTo();
  return (
    <form action="/auth/signout" method="post" className="flex items-center gap-3">
      <span className="text-[length:var(--font-size-small)] uppercase tracking-widest text-primary">{name}</span>
      <input type="hidden" name="returnTo" value={returnTo} />
      <button type="submit" className="btn btn--quiet">
        Sign out
      </button>
    </form>
  );
}
