// Notifications: a pilot's inbox. The `notifications` table is the only owner of what a pilot was told;
// nothing here is counted or cached elsewhere. Rows are written in the transaction of the event that
// causes them (createComment, publishFit, recordEvaluation call the notify* helpers with their own
// transaction) and are never about the actor's own action. They are deleted with what they point at:
// the foreign keys cascade on delete, and hiding or unpublishing a fit, or hiding or tombstoning a
// comment, deletes them in the same statement as the change (queries.ts). Every read below also keeps
// only rows whose fit is published and whose comment, if any, is visible, so nothing leaks if a path
// that should have deleted a row did not. A pilot reads and marks only their own rows: user_id is in
// every WHERE.
//
// Runs under plain `node` through the re-evaluation job, so it stays erasable TypeScript with explicit
// .ts import paths.
import type { Queryable } from "./db.ts";
import { decodeNotificationCursor, encodeNotificationCursor } from "./filters.ts";

export type NotificationKind = "comment" | "reply" | "follow_fit" | "fit_broken";

export type Notification = {
  id: string;
  kind: NotificationKind;
  fitId: string;
  fitTitle: string;
  commentId: string | null;
  /** The pilot who acted; null for fit_broken (the engine did). */
  actorUserId: string | null;
  actorName: string | null;
  createdAt: string;
  read: boolean;
};

export type NotificationPage = { notifications: Notification[]; nextCursor: string | null };

export const NOTIFICATIONS_PAGE_SIZE = 30;
/** The header shows 99+ beyond this, so counting stops one past it. */
export const UNREAD_DISPLAY_CAP = 99;

// ---------------------------------------------------------------------------------------------------
// Writes that belong to another event: call them inside that event's transaction.

/**
 * A new comment on a published fit: `comment` to the fit's author, and `reply` to the author of the comment
 * replied to. Never to the commenter, and a pilot who is both the fit's author and the parent's author gets
 * the reply only. A retried write inserts nothing twice (the unique index).
 */
export async function notifyComment(
  db: Queryable,
  input: { fitId: string; commentId: string; actorUserId: string; parentAuthorUserId: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO notifications (user_id, kind, fit_id, comment_id, actor_user_id)
     SELECT author_user_id, 'comment', id, $2::bigint, $3 FROM fits
     WHERE id = $1 AND status = 'published' AND author_user_id <> $3 AND author_user_id IS DISTINCT FROM $4::text
     ON CONFLICT DO NOTHING`,
    [input.fitId, input.commentId, input.actorUserId, input.parentAuthorUserId],
  );
  if (input.parentAuthorUserId !== null && input.parentAuthorUserId !== input.actorUserId) {
    await db.query(
      `INSERT INTO notifications (user_id, kind, fit_id, comment_id, actor_user_id)
       VALUES ($1, 'reply', $2, $3::bigint, $4)
       ON CONFLICT DO NOTHING`,
      [input.parentAuthorUserId, input.fitId, input.commentId, input.actorUserId],
    );
  }
}

/** A fit's author published it: `follow_fit` to each of their followers, in one statement. */
export async function notifyFollowers(db: Queryable, input: { fitId: string; authorUserId: string }): Promise<void> {
  await db.query(
    `INSERT INTO notifications (user_id, kind, fit_id, actor_user_id)
     SELECT follower_user_id, 'follow_fit', $1, $2 FROM pilot_follows WHERE followee_user_id = $2
     ON CONFLICT DO NOTHING`,
    [input.fitId, input.authorUserId],
  );
}

/**
 * A verdict was just stored for `buildSha`. If it is invalid, the fit is published, and the fit's most recent
 * verdict on any other build was valid, the fit broke on this build: tell its author, once per (fit, build).
 * Call it after the verdict row is stored, in the same transaction.
 */
export async function notifyBroken(db: Queryable, input: { fitId: string; buildSha: string; valid: boolean }): Promise<void> {
  if (input.valid) return;
  await db.query(
    `INSERT INTO notifications (user_id, kind, fit_id, build_sha)
     SELECT f.author_user_id, 'fit_broken', f.id, $2 FROM fits f
     WHERE f.id = $1 AND f.status = 'published'
       AND (SELECT e.valid FROM fit_evaluations e WHERE e.fit_id = f.id AND e.build_sha <> $2
            ORDER BY e.evaluated_at DESC, e.build_sha LIMIT 1) IS TRUE
     ON CONFLICT DO NOTHING`,
    [input.fitId, input.buildSha],
  );
}

// ---------------------------------------------------------------------------------------------------
// Reads and the pilot's own read markers

// A notification is shown only while its fit is published and its comment (if any) is visible: not hidden,
// not a tombstone, and not under a hidden top-level comment.
const VISIBLE_FROM = `
  FROM notifications n
  JOIN fits f ON f.id = n.fit_id AND f.status = 'published'
  LEFT JOIN fit_comments c ON c.id = n.comment_id
  LEFT JOIN fit_comments cp ON cp.id = c.parent_id`;
const VISIBLE_WHERE = `
  (n.comment_id IS NULL
   OR (c.id IS NOT NULL AND NOT c.hidden AND c.deleted_at IS NULL AND (c.parent_id IS NULL OR NOT cp.hidden)))`;

/** How many unread notifications the pilot has, counted to at most UNREAD_DISPLAY_CAP + 1 (the header shows 99+). */
export async function countUnread(db: Queryable, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (
       SELECT 1 ${VISIBLE_FROM}
       WHERE n.user_id = $1 AND n.read_at IS NULL AND ${VISIBLE_WHERE}
       LIMIT ${UNREAD_DISPLAY_CAP + 1}
     ) AS unread`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

function mapNotification(row: Record<string, any>): Notification {
  return {
    id: String(row.id),
    kind: row.kind,
    fitId: row.fit_id,
    fitTitle: row.fit_title,
    commentId: row.comment_id === null ? null : String(row.comment_id),
    actorUserId: row.actor_user_id ?? null,
    actorName: row.actor_name ?? null,
    createdAt: row.created_at,
    read: row.read_at !== null,
  };
}

/** The pilot's visible notifications, newest first, paged by (created at, id). */
export async function listNotifications(db: Queryable, options: { userId: string; cursor?: string; limit?: number }): Promise<NotificationPage> {
  const size = Math.min(Math.max(Math.trunc(options.limit ?? NOTIFICATIONS_PAGE_SIZE), 1), 100);
  const cursor = options.cursor ? decodeNotificationCursor(options.cursor) : undefined;
  const { rows } = await db.query<Record<string, any>>(
    `SELECT n.id::text AS id, n.kind, n.fit_id, f.title AS fit_title, n.comment_id::text AS comment_id,
            n.actor_user_id, (SELECT p.name FROM pilots p WHERE p.user_id = n.actor_user_id) AS actor_name,
            n.created_at::text AS created_at, n.read_at
     ${VISIBLE_FROM}
     WHERE n.user_id = $1 AND ${VISIBLE_WHERE}
       ${cursor ? `AND (n.created_at, n.id) < ($2::timestamptz, $3::bigint)` : ""}
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT ${size + 1}`,
    cursor ? [options.userId, cursor.at, cursor.id] : [options.userId],
  );
  const pageRows = rows.slice(0, size);
  const last = pageRows[pageRows.length - 1];
  return {
    notifications: pageRows.map(mapNotification),
    nextCursor: rows.length > size && last ? encodeNotificationCursor({ at: last.created_at, id: last.id }) : null,
  };
}

const NUMERIC_ID = /^\d{1,15}$/;

export type OpenedNotification = { fitId: string; commentId: string | null };

/**
 * Marks one of the pilot's own notifications read and says where it points, or null when it isn't theirs,
 * doesn't exist, or no longer points at anything visible. Opening a read one changes nothing.
 */
export async function openNotification(db: Queryable, input: { userId: string; id: string }): Promise<OpenedNotification | null> {
  if (!NUMERIC_ID.test(input.id)) return null;
  const { rows } = await db.query<Record<string, any>>(
    `WITH target AS (
       SELECT n.id, n.fit_id, n.comment_id::text AS comment_id
       ${VISIBLE_FROM}
       WHERE n.id = $1::bigint AND n.user_id = $2 AND ${VISIBLE_WHERE}
     ),
     marked AS (
       UPDATE notifications SET read_at = now()
       WHERE id IN (SELECT id FROM target) AND user_id = $2 AND read_at IS NULL
     )
     SELECT fit_id, comment_id FROM target`,
    [input.id, input.userId],
  );
  const row = rows[0];
  return row ? { fitId: row.fit_id, commentId: row.comment_id ?? null } : null;
}

/** Marks all of the pilot's notifications read; returns how many were unread. */
export async function markAllRead(db: Queryable, userId: string): Promise<number> {
  const { rows } = await db.query(
    `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL RETURNING id`,
    [userId],
  );
  return rows.length;
}
