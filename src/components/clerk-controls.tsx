"use client";

import { Show, SignInButton, UserButton } from "@clerk/nextjs";

const BUTTON =
  "h-8 border border-[color:var(--panel-border)] bg-content px-3 text-[length:var(--font-size-small)] uppercase tracking-widest text-primary hover:text-accent";

/** Only rendered when sign-in is configured, so a site without keys never loads Clerk's code. */
export function ClerkControls() {
  return (
    <>
      <Show when="signed-out">
        <SignInButton mode="modal">
          <button type="button" className={BUTTON}>
            Sign in
          </button>
        </SignInButton>
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </>
  );
}
