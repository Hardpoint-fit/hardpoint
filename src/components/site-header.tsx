import Link from "next/link";
import { Suspense } from "react";
import { currentAuthor } from "#/lib/auth";
import { SIGN_IN_UNAVAILABLE_MESSAGE } from "#/lib/auth-errors";
import { getConfig } from "#/lib/site-config";
import { loadUnreadCount, unreadLabel } from "#/lib/site/loaders";
import { siteDeps } from "#/lib/site/server";
import { SignInLink, SignedIn } from "./auth-controls";

const NAV = [
  { href: "/", label: "Browse" },
  { href: "/fits/new", label: "New fit" },
] as const;

export async function SiteHeader() {
  const { authEnabled } = getConfig();
  const author = authEnabled ? await currentAuthor() : null;
  // One indexed count per page view for a signed-in pilot; a database that can't answer reads as none.
  const unread = author ? await loadUnreadCount(siteDeps(), author.userId) : 0;
  return (
    // Below sm the links drop to their own row under the logo and sign-in, so the header never scrolls sideways.
    <header className="flex min-h-12 flex-wrap items-center gap-x-6 gap-y-1 border-b border-[color:var(--panel-border)] bg-header px-4 py-1">
      <Link href="/" className="flex items-center gap-2 text-[length:var(--font-size-header)] tracking-widest text-primary">
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed-size SVG gains nothing from next/image */}
        <img src="/logo.svg" width={24} height={24} alt="" />
        hardpoint.fit
      </Link>
      <nav className="order-last flex w-full flex-wrap gap-x-4 gap-y-1 text-[length:var(--font-size-small)] tracking-widest sm:order-none sm:w-auto">
        {NAV.map(({ href, label }) => (
          <Link key={href} href={href} className="text-secondary hover:text-accent">
            {label}
          </Link>
        ))}
        {author && (
          <>
            <Link href={`/u/${encodeURIComponent(author.userId)}`} className="text-secondary hover:text-accent">
              My fits
            </Link>
            <Link href="/bookmarks" className="text-secondary hover:text-accent">
              Bookmarks
            </Link>
            <Link
              href="/notifications"
              className="text-secondary hover:text-accent"
              aria-label={unread > 0 ? `Notifications, ${unreadLabel(unread)} unread` : "Notifications"}
            >
              Notifications{unread > 0 && <span className="bell-count">{unreadLabel(unread)}</span>}
            </Link>
          </>
        )}
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
