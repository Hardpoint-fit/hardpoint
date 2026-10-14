import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Builder } from "#/components/builder/builder";
import Link from "next/link";
import { Panel, UnavailableState } from "#/components/ui";
import { loadBuilder } from "#/lib/site/loaders";
import { pageViewer, siteDeps } from "#/lib/site/server";

export const metadata: Metadata = { title: "Edit fit · hardpoint.fit" };

/** The builder on a saved fit, for its author; anyone else reads the fit page instead. */
export default async function EditFitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9]{1,40}$/.test(id)) notFound();
  const viewer = await pageViewer();
  const data = await loadBuilder(siteDeps(), { fitId: id }, viewer);
  if (data.status === "not_found") notFound();
  if (data.status === "forbidden") redirect(`/fits/${id}`);
  if (data.status === "unreadable")
    return (
      <main className="page">
        <Panel title="EDIT FIT">
          <div className="empty-state">
            <span>THIS FIT CAN&apos;T BE OPENED IN THE BUILDER.</span>
            <Link className="btn btn--quiet" href={`/fits/${id}`}>
              BACK TO THE FIT
            </Link>
          </div>
        </Panel>
      </main>
    );
  if (data.status === "unavailable")
    return (
      <main className="page">
        <UnavailableState what="THIS FIT" />
      </main>
    );
  return <Builder start={data.start} auth={{ enabled: viewer.authEnabled, signedIn: viewer.userId !== null }} />;
}
