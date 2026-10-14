// What a moderator whose admin role has expired sees in place of the moderation controls: one link that signs
// them in again (reverify.ts) and brings them back to the same page with the controls live. Server-rendered.
import Link from "next/link";
import { reverifyHref } from "#/lib/reverify";
import { Panel } from "./ui";

export function ReverifyLink({ returnTo }: { returnTo: string }) {
  return (
    <a className="btn btn--quiet" href={reverifyHref(returnTo)}>
      RE-VERIFY TO MODERATE
    </a>
  );
}

/** An admin page for a moderator whose role has expired: why there is nothing to act on, and the way back. */
export function ReverifyPanel({ returnTo }: { returnTo: string }) {
  return (
    <Panel title="MODERATION">
      <p className="note">YOUR MODERATOR SIGN-IN IS OVER A DAY OLD. SIGN IN AGAIN TO MODERATE.</p>
      <ReverifyLink returnTo={returnTo} />
    </Panel>
  );
}

/** The admin pages' own links. */
export function AdminNav({ current }: { current: "reports" | "pilots" }) {
  const links = [
    { key: "reports", href: "/admin/reports", label: "REPORTS" },
    { key: "pilots", href: "/admin/pilots", label: "PILOTS" },
  ] as const;
  return (
    <nav className="flex flex-wrap gap-4 text-[length:var(--font-size-small)] tracking-widest" aria-label="Admin">
      {links.map((link) => (
        <Link key={link.key} href={link.href} className={link.key === current ? "text-accent" : "text-secondary hover:text-accent"} aria-current={link.key === current ? "page" : undefined}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
