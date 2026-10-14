import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { FitCards, MoreBookmarks } from "#/components/fit/browse-view";
import { EngineBanner, NotConfigured, UnavailableState } from "#/components/ui";
import { loadBookmarks } from "#/lib/site/loaders";
import { pageViewer, siteDeps } from "#/lib/site/server";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: "Bookmarks · hardpoint.fit", robots: { index: false, follow: false } };

/** The signed-in pilot's bookmarked fits, newest bookmark first. Signed out, it goes to sign-in and comes back. */
export default async function BookmarksPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await pageViewer();
  if (!viewer.authEnabled)
    return (
      <main className="page">
        <NotConfigured />
      </main>
    );
  if (viewer.userId === null) redirect(`/auth/signin?${new URLSearchParams({ returnTo: "/bookmarks" })}`);
  const params = await searchParams;
  const data = await loadBookmarks(siteDeps(), params, viewer.userId);
  return (
    <main className="page">
      <EngineBanner engine={data.engine} />
      <div className="page-title">
        <h1>BOOKMARKS</h1>
        <span className="eyebrow">PUBLISHED FITS YOU SAVED · NEWEST FIRST</span>
      </div>
      {data.status === "unavailable" ? (
        <UnavailableState />
      ) : (
        <>
          <FitCards cards={data.cards} empty="NO BOOKMARKS YET. BOOKMARK A FIT TO KEEP IT HERE." canBookmark />
          <MoreBookmarks cursor={data.nextCursor} />
        </>
      )}
    </main>
  );
}
