// The notifications list. Each item is a POST form (a server action marks it read, then redirects to the
// fit or comment), so merely following a link or loading the page never marks anything read.
import Link from "next/link";
import { markAllNotificationsReadAction, openNotificationAction } from "#/app/actions";
import { formatDate } from "#/components/ui";
import type { Notification } from "#/lib/fits/notifications";

function describe(n: Notification): string {
  const who = n.actorName ?? "A PILOT";
  switch (n.kind) {
    case "comment":
      return `${who} COMMENTED ON ${n.fitTitle}`;
    case "reply":
      return `${who} REPLIED TO YOUR COMMENT ON ${n.fitTitle}`;
    case "follow_fit":
      return `${who} PUBLISHED ${n.fitTitle}`;
    case "fit_broken":
      return `${n.fitTitle} NO LONGER PASSES VALIDATION ON THE LATEST BUILD`;
  }
}

export function NotificationList({ notifications, empty }: { notifications: Notification[]; empty: string }) {
  if (notifications.length === 0) return <p className="note">{empty}</p>;
  return (
    <ul className="notification-list">
      {notifications.map((n) => (
        <li key={n.id} className={n.read ? "notification" : "notification notification--unread"}>
          <form action={openNotificationAction.bind(null, n.id)}>
            <button type="submit" className="notification__open">
              <span className="notification__text">{describe(n)}</span>
              <span className="note">
                {n.read ? "" : "NEW · "}
                {formatDate(n.createdAt)}
              </span>
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}

export function MarkAllRead() {
  return (
    <form action={markAllNotificationsReadAction}>
      <button type="submit" className="btn btn--quiet">
        MARK ALL READ
      </button>
    </form>
  );
}

export function MoreNotifications({ cursor }: { cursor: string | null }) {
  if (!cursor) return null;
  return (
    <div className="flex justify-center">
      <Link className="btn btn--quiet" href={`/notifications?${new URLSearchParams({ cursor })}`}>
        OLDER
      </Link>
    </div>
  );
}
