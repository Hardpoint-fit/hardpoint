import type { Metadata } from "next";
import { CompareView } from "#/components/fit/compare-view";
import { UnavailableState, EngineBanner } from "#/components/ui";
import { loadCompare } from "#/lib/site/loaders";
import { pageViewer, siteDeps } from "#/lib/site/server";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: "Compare · hardpoint.fit", robots: { index: false, follow: true } };

const one = (value: string | string[] | undefined) => (typeof value === "string" && value !== "" ? value : undefined);

/** `?a=<id>&b=<id>`. With only `a` it offers a picker for `b`; a fit the viewer can't see reads as not found. */
export default async function ComparePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const viewer = await pageViewer();
  const data = await loadCompare(siteDeps(), { a: one(params.a), b: one(params.b) }, viewer);
  if (data.status === "unavailable")
    return (
      <main className="page">
        <EngineBanner engine={data.engine} />
        <UnavailableState what="THESE FITS" />
      </main>
    );
  return <CompareView data={data} signedIn={viewer.authEnabled && viewer.userId !== null} />;
}
