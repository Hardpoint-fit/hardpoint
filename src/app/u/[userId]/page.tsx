import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FitCards, MoreLink } from "#/components/fit/browse-view";
import { PilotHeader } from "#/components/pilot/pilot-header";
import { EngineBanner, UnavailableState } from "#/components/ui";
import { loadAuthor } from "#/lib/site/loaders";
import { pageViewer, siteDeps } from "#/lib/site/server";

type Params = Promise<{ userId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const USER_ID = /^[A-Za-z0-9_-]{1,100}$/;

export const metadata: Metadata = { title: "Pilot · hardpoint.fit" };

export default async function AuthorPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  // Next hands the segment over decoded; an id is only letters, digits, "_" and "-", so nothing is decoded twice.
  const userId = (await params).userId;
  if (!USER_ID.test(userId)) notFound();
  const viewer = await pageViewer();
  const data = await loadAuthor(siteDeps(), userId, await searchParams, viewer);
  if (data.status === "not_found") notFound();
  const own = viewer.userId === userId;
  return (
    <main className="page">
      <EngineBanner engine={data.engine} />
      {data.status === "unavailable" ? (
        <UnavailableState />
      ) : (
        <>
          <PilotHeader pilot={data.pilot} viewer={viewer} />
          <div className="page-title">
            <span className="eyebrow">{own ? "YOUR FITS AND DRAFTS" : "PUBLISHED FITS"}</span>
          </div>
          <FitCards cards={data.cards} empty={own ? "YOU HAVEN'T SAVED A FIT YET." : "THIS PILOT HASN'T PUBLISHED A FIT."} canBookmark={viewer.authEnabled && viewer.userId !== null} />
          <MoreLink query={data.query} cursor={data.nextCursor} path={`/u/${encodeURIComponent(userId)}`} />
        </>
      )}
    </main>
  );
}
