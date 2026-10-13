import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FitCards, MoreLink } from "#/components/fit/browse-view";
import { EngineBanner, UnavailableState } from "#/components/ui";
import { loadAuthor } from "#/lib/site/loaders";
import { pageViewer, siteDeps } from "#/lib/site/server";

type Params = Promise<{ userId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const USER_ID = /^[A-Za-z0-9_-]{1,100}$/;

export const metadata: Metadata = { title: "Pilot fits · Citadel Fits" };

export default async function AuthorPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = decodeURIComponent((await params).userId);
  if (!USER_ID.test(userId)) notFound();
  const viewer = await pageViewer();
  const data = await loadAuthor(siteDeps(), userId, await searchParams, viewer);
  const own = viewer.userId === userId;
  return (
    <main className="page">
      <EngineBanner engine={data.engine} />
      {data.status === "unavailable" ? (
        <UnavailableState />
      ) : (
        <>
          <div className="page-title">
            <h1>{data.authorName ?? (own ? viewer.name : null) ?? "PILOT"}</h1>
            <span className="eyebrow">{own ? "YOUR FITS AND DRAFTS" : "PUBLISHED FITS"}</span>
          </div>
          <FitCards cards={data.cards} empty={own ? "YOU HAVEN'T SAVED A FIT YET." : "THIS PILOT HASN'T PUBLISHED A FIT."} />
          <MoreLink query={data.query} cursor={data.nextCursor} path={`/u/${encodeURIComponent(userId)}`} />
        </>
      )}
    </main>
  );
}
