// Fork credit and copy counts, read for one fit page. `fits.forked_from` / `forked_from_deleted` (written by
// createFit and deleteFit in queries.ts) are the only owners of where a fit was copied from; the copy count is
// computed from them per request. The credit never reveals a source the viewer may not see: a draft or hidden
// source of another pilot reads as "another fit", with no title or pilot.
import type { Queryable } from "./db.ts";
import type { Viewer } from "./queries.ts";

export type ForkCredit =
  /** The source exists and the viewer may see it. */
  | { state: "source"; id: string; title: string; authorUserId: string; authorName: string }
  /** The source was deleted by its author. */
  | { state: "deleted" }
  /** The source exists but is a draft or hidden fit the viewer can't see. */
  | { state: "unseen" };

export type ForkInfo = { credit: ForkCredit | null; copies: number };

/**
 * What the page of fit `fitId` says about forking: the credit (null when it wasn't copied from a fit) and
 * `copies`, the number of published fits copied from it. The caller has already checked the viewer may see
 * the fit itself. A source is visible by the rule getFit applies: published, the viewer's own, or any to an admin.
 */
export async function getForkInfo(db: Queryable, fitId: string, viewer: Viewer): Promise<ForkInfo> {
  const { rows } = await db.query<Record<string, any>>(
    `SELECT f.forked_from_deleted, s.id AS source_id,
            (s.status = 'published' OR $2::boolean OR s.author_user_id = $3::text) AS source_visible,
            CASE WHEN s.status = 'published' OR $2::boolean OR s.author_user_id = $3::text THEN s.title END AS source_title,
            CASE WHEN s.status = 'published' OR $2::boolean OR s.author_user_id = $3::text THEN s.author_user_id END AS source_author_id,
            CASE WHEN s.status = 'published' OR $2::boolean OR s.author_user_id = $3::text THEN sp.name END AS source_author_name,
            (SELECT count(*)::int FROM fits c WHERE c.forked_from = f.id AND c.status = 'published') AS copies
     FROM fits f
     LEFT JOIN fits s ON s.id = f.forked_from
     LEFT JOIN pilots sp ON sp.user_id = s.author_user_id
     WHERE f.id = $1`,
    [fitId, viewer.isAdmin, viewer.userId],
  );
  const row = rows[0];
  if (!row) return { credit: null, copies: 0 };
  let credit: ForkCredit | null = null;
  if (row.source_id) {
    credit = row.source_visible
      ? { state: "source", id: row.source_id, title: row.source_title, authorUserId: row.source_author_id, authorName: row.source_author_name }
      : { state: "unseen" };
  } else if (row.forked_from_deleted) {
    credit = { state: "deleted" };
  }
  return { credit, copies: row.copies };
}
