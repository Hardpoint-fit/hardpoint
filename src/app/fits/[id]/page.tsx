import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { FitPageView } from "#/components/fit/fit-page-view";
import { EngineBanner, UnavailableState } from "#/components/ui";
import { loadFitPage } from "#/lib/site/loaders";
import { pageViewer, siteDeps } from "#/lib/site/server";

type Params = Promise<{ id: string }>;

// The metadata and the page read the same fit once per request.
const load = cache(async (id: string) => {
  const viewer = await pageViewer();
  return { viewer, data: await loadFitPage(siteDeps(), id, viewer) };
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const { data } = await load(id);
  if (data.status !== "ok") return { title: "Fit · hardpoint.fit" };
  const hull = data.hull?.name ?? "Ship";
  const description = `${hull} fit by ${data.fit.authorName}: ${data.fit.votes} upvotes.`;
  return {
    title: `${data.fit.title} · ${hull} · hardpoint.fit`,
    description,
    openGraph: { title: data.fit.title, description, type: "article" },
    twitter: { card: "summary_large_image", title: data.fit.title, description },
  };
}

export default async function FitPage({ params }: { params: Params }) {
  const { id } = await params;
  const { viewer, data } = await load(id);
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
