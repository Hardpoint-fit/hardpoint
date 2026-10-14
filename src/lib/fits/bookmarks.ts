// A pilot's bookmarks. fit_bookmarks is the only owner of who bookmarked what; "viewerBookmarked" on a fit
// summary is read from it per request, nothing is cached or counted. A bookmark is private to its pilot: no
// read here returns anyone else's. Only a published fit can be bookmarked, and the list shows a bookmark only
// while its fit is published, so a fit that is unpublished, hidden or deleted never appears in anyone's list
// (a deleted fit's bookmarks go with it, ON DELETE CASCADE; the others come back if it is published again).
import { decodeBookmarkCursor, encodeBookmarkCursor } from "./filters.ts";
import type { Queryable } from "./db.ts";
import { DEFAULT_PAGE_SIZE, FitDataError, MAX_PAGE_SIZE, mapSummary, summaryColumns, type FitPage } from "./queries.ts";

const ID = /^[0-9A-Za-z]{10}$/;

export type BookmarkResult = { bookmarked: boolean };

/**
 * Sets whether `userId` has bookmarked a published fit. Idempotent: asking for the state they are already in
 * changes nothing (a second bookmark keeps the first's time, so the list order doesn't jump). Bookmarking a
 * fit that isn't published, or doesn't exist, is `not_found`; removing a bookmark always works.
 */
export async function setBookmark(db: Queryable, input: { fitId: string; userId: string; bookmarked: boolean }): Promise<BookmarkResult> {
  if (!input.userId) throw new FitDataError("invalid", "Sign in to bookmark a fit.");
  if (!input.bookmarked) {
    if (ID.test(input.fitId)) await db.query(`DELETE FROM fit_bookmarks WHERE fit_id = $1 AND user_id = $2`, [input.fitId, input.userId]);
    return { bookmarked: false };
  }
  // FOR KEY SHARE holds the fit against a concurrent delete; if the fit is deleted between the check and
  // the insert anyway, Postgres raises 23503 and that is the same answer as "no such fit".
  let rows: unknown[];
  try {
    ({ rows } = await db.query(
      `INSERT INTO fit_bookmarks (fit_id, user_id)
       SELECT id, $2 FROM fits WHERE id = $1 AND status = 'published' FOR KEY SHARE
       ON CONFLICT (user_id, fit_id) DO NOTHING RETURNING fit_id`,
      [ID.test(input.fitId) ? input.fitId : "", input.userId],
    ));
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23503") throw new FitDataError("not_found", "No such fit.");
    throw error;
  }
  if (rows.length === 0) {
    // Nothing inserted: already bookmarked (fine), or not a published fit.
    const { rows: held } = await db.query(
      `SELECT 1 FROM fit_bookmarks b JOIN fits f ON f.id = b.fit_id WHERE b.fit_id = $1 AND b.user_id = $2 AND f.status = 'published'`,
      [ID.test(input.fitId) ? input.fitId : "", input.userId],
    );
    if (held.length === 0) throw new FitDataError("not_found", "No such fit.");
  }
  return { bookmarked: true };
}

export type ListBookmarksOptions = {
  userId: string;
  cursor?: string;
  limit?: number;
  buildSha?: string | null;
};

/**
 * The pilot's bookmarked fits that are published now, newest bookmark first, in the browse cards' shape.
 * Ordered by (bookmarked at, fit id), a total order, so paging by cursor neither repeats nor skips a fit.
 */
export async function listBookmarks(db: Queryable, options: ListBookmarksOptions): Promise<FitPage> {
  const size = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const cursor = options.cursor ? decodeBookmarkCursor(options.cursor) : undefined;
  const { rows } = await db.query<Record<string, any>>(
    `SELECT ${summaryColumns("$2", "$1")}, b.created_at::text AS marked_at
     FROM fit_bookmarks b
     JOIN fits f ON f.id = b.fit_id
     JOIN pilots p ON p.user_id = f.author_user_id
     WHERE b.user_id = $1::text AND f.status = 'published'
       ${cursor ? `AND (b.created_at, b.fit_id) < ($3::timestamptz, $4::text)` : ""}
     ORDER BY b.created_at DESC, b.fit_id DESC
     LIMIT ${size + 1}`,
    cursor ? [options.userId, options.buildSha ?? null, cursor.at, cursor.id] : [options.userId, options.buildSha ?? null],
  );
  const pageRows = rows.slice(0, size);
  const last = pageRows[pageRows.length - 1];
  return {
    fits: pageRows.map(mapSummary),
    nextCursor: rows.length > size && last ? encodeBookmarkCursor({ at: last.marked_at, id: last.id }) : null,
  };
}
