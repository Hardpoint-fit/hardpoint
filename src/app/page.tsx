import { BrowseFilters, FitCards, MoreLink } from "#/components/fit/browse-view";
import { EngineBanner, UnavailableState } from "#/components/ui";
import { loadBrowse } from "#/lib/site/loaders";
import { pageViewer, siteDeps } from "#/lib/site/server";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function BrowsePage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await pageViewer();
  const data = await loadBrowse(siteDeps(), await searchParams, viewer);
  return (
    <main className="page">
      <EngineBanner engine={data.engine} />
      <div className="page-title">
        <h1>SHIP FITS</h1>
      </div>
      {data.status === "unavailable" ? (
        <UnavailableState />
      ) : (
        <>
          <BrowseFilters query={data.query} hulls={data.hulls} selectedModules={data.selectedModules} signedIn={viewer.authEnabled && viewer.userId !== null} />
          <FitCards cards={data.cards} empty="NO FITS MATCH. TRY FEWER FILTERS." canBookmark={viewer.authEnabled && viewer.userId !== null} />
          <MoreLink query={data.query} cursor={data.nextCursor} />
        </>
      )}
    </main>
  );
}
