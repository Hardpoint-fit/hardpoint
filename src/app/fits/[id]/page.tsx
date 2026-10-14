import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { FitPageView } from "#/components/fit/fit-page-view";
import { EngineBanner, UnavailableState } from "#/components/ui";
import { loadFitPage } from "#/lib/site/loaders";
import { pageViewer, siteDeps } from "#/lib/site/server";

type Params = Promise<{ id: string }>;
type Search = Promise<{ rev?: string | string[] }>;

// The metadata and the page read the same fit once per request. `rev` is `null` for the latest, else the
// raw `?rev=` value (a repeated one is passed as text no revision number matches, so it is not found).
const load = cache(async (id: string, rev: string | null) => {
  const viewer = await pageViewer();
  return { viewer, data: await loadFitPage(siteDeps(), id, viewer, rev ?? undefined) };
});

const revParam = (search: { rev?: string | string[] }) => (search.rev === undefined ? null : Array.isArray(search.rev) ? "invalid" : search.rev);

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: Search }): Promise<Metadata> {
  const { id } = await params;
  // Always the latest: a revision is a read-only view of the same fit, kept out of search results.
  const { data } = await load(id, null);
  const robots = (await searchParams).rev === undefined ? undefined : { index: false, follow: true };
  if (data.status !== "ok") return { title: "Fit · hardpoint.fit", robots };
  const hull = data.hull?.name ?? "Ship";
  const description = `${hull} fit by ${data.fit.authorName}: ${data.fit.votes} upvotes.`;
  return {
    title: `${data.fit.title} · ${hull} · hardpoint.fit`,
    robots,
    description,
    openGraph: { title: data.fit.title, description, type: "article" },
    twitter: { card: "summary_large_image", title: data.fit.title, description },
  };
}

export default async function FitPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { id } = await params;
  const { viewer, data } = await load(id, revParam(await searchParams));
  if (data.status === "not_found") notFound();
  if (data.status === "unavailable")
    return (
      <main className="page">
        <EngineBanner engine={data.engine} />
        <UnavailableState what="THIS FIT AND ITS COMMENTS" />
      </main>
    );
  return <FitPageView data={data} viewer={viewer} />;
}
