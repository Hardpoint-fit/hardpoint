import Link from "next/link";
import { Suspense } from "react";
import { currentAuthor } from "#/lib/auth";
import { SIGN_IN_UNAVAILABLE_MESSAGE } from "#/lib/auth-errors";
import { getConfig } from "#/lib/site-config";
import { SignInLink, SignedIn } from "./auth-controls";

const NAV = [
  { href: "/", label: "Browse" },
  { href: "/fits/new", label: "New fit" },
] as const;

export async function SiteHeader() {
  const { authEnabled } = getConfig();
  const author = authEnabled ? await currentAuthor() : null;
  return (
    <header className="flex h-12 items-center gap-6 border-b border-[color:var(--panel-border)] bg-header px-4">
      <Link href="/" className="text-[length:var(--font-size-header)] tracking-widest text-primary">
        Citadel Fits
      </Link>
      <nav className="flex gap-4 text-[length:var(--font-size-small)] tracking-widest">
        {NAV.map(({ href, label }) => (
          <Link key={href} href={href} className="text-secondary hover:text-accent">
            {label}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        {authEnabled ? (
          // useSearchParams needs a boundary; the fallback is the same link without the return path.
          <Suspense fallback={author ? null : <a className="btn" href="/auth/signin">Sign in</a>}>
            {author ? <SignedIn name={author.name} /> : <SignInLink />}
          </Suspense>
        ) : (
          <span className="text-[length:var(--font-size-small)] text-secondary">{SIGN_IN_UNAVAILABLE_MESSAGE}</span>
        )}
      </div>
    </header>
  );
}
