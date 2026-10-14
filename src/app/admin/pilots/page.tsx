import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PilotsView } from "#/components/admin/pilots-view";
import { AdminNav, ReverifyPanel } from "#/components/moderation";
import { getConfig } from "#/lib/site-config";
import { loadPilots } from "#/lib/site/loaders";
import { pageViewer, siteDeps } from "#/lib/site/server";

export const metadata: Metadata = { title: "Pilots · hardpoint.fit", robots: { index: false } };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PilotsPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await pageViewer();
  // Like the report queue: not there for anyone but a moderator, and no data until an expired role is re-verified.
  if (viewer.moderation === "none") notFound();
  const data = viewer.isAdmin ? await loadPilots(siteDeps(), await searchParams) : null;
  return (
    <main className="page">
      <div className="page-title">
        <h1>PILOTS</h1>
        <span className="eyebrow">FIND A PILOT · BAN OR UNBAN</span>
      </div>
      <AdminNav current="pilots" />
      {data === null ? (
        <ReverifyPanel returnTo="/admin/pilots" />
      ) : (
        <PilotsView data={data} viewerId={viewer.userId!} siteAdmins={getConfig().adminUserIds} />
      )}
    </main>
  );
}
