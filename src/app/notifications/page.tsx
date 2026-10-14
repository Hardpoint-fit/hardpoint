import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MarkAllRead, MoreNotifications, NotificationList } from "#/components/notifications-view";
import { EngineBanner, NotConfigured, UnavailableState } from "#/components/ui";
import { loadNotifications } from "#/lib/site/loaders";
import { pageViewer, siteDeps } from "#/lib/site/server";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: "Notifications · hardpoint.fit", robots: { index: false, follow: false } };

/** The signed-in pilot's notifications, newest first. Opening the page marks nothing read. */
export default async function NotificationsPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await pageViewer();
  if (!viewer.authEnabled)
    return (
      <main className="page">
        <NotConfigured />
      </main>
    );
  if (viewer.userId === null) redirect(`/auth/signin?${new URLSearchParams({ returnTo: "/notifications" })}`);
  const params = await searchParams;
  const data = await loadNotifications(siteDeps(), params, viewer.userId);
  return (
    <main className="page">
      <EngineBanner engine={data.engine} />
      <div className="page-title">
        <h1>NOTIFICATIONS</h1>
        <span className="eyebrow">NEWEST FIRST</span>
        {data.status === "ok" && <MarkAllRead />}
      </div>
      {data.status === "unavailable" ? (
        <UnavailableState />
      ) : (
        <>
          <NotificationList notifications={data.notifications} empty="NOTHING YET. COMMENTS, REPLIES AND NEW FITS FROM PILOTS YOU FOLLOW SHOW UP HERE." />
          <MoreNotifications cursor={data.nextCursor} />
        </>
      )}
    </main>
  );
}
