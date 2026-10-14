import type { Metadata } from "next";
import { Builder } from "#/components/builder/builder";
import { UnavailableState } from "#/components/ui";
import { loadBuilder } from "#/lib/site/loaders";
import { pageViewer, siteDeps } from "#/lib/site/server";

export const metadata: Metadata = { title: "New fit · hardpoint.fit", description: "Build a Citadel ship fit and check it against the live build." };

type Search = Promise<Record<string, string | string[] | undefined>>;

/** The builder for a new fit, from a hull, a pasted fit string, or `?from=<fit id>` (copy fit). */
export default async function NewFitPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const from = typeof params.from === "string" && /^[A-Za-z0-9]{1,40}$/.test(params.from) ? params.from : undefined;
  const viewer = await pageViewer();
  const data = await loadBuilder(siteDeps(), { copyFrom: from }, viewer);
  if (data.status !== "ok")
    return (
      <main className="page">
        <UnavailableState what="FITS" />
      </main>
    );
  return <Builder start={data.start} auth={{ enabled: viewer.authEnabled, signedIn: viewer.userId !== null }} />;
}
