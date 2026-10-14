// Reads of a fit's history. The rows are written by queries.ts (publishFit, updateFit) in the transaction
// of the change they record, and are deleted with the fit (ON DELETE CASCADE). Reads here do not check who
// may see the fit: callers read the fit through getFit first, so a revision follows the fit's own
// visibility (a hidden fit's or another pilot's draft's revisions are never reachable without it).
import type { Queryable } from "./db.ts";

/** The history list shows at most this many, newest first; the newest is always among them. */
export const REVISION_LIST_MAX = 200;

const ID = /^[0-9A-Za-z]{10}$/;
/** A revision number as it appears in a URL: positive decimal, no sign, no leading zero, no exponent. */
const REVISION_PARAM = /^[1-9]\d{0,8}$/;

export function parseRevisionParam(raw: unknown): number | null {
  return typeof raw === "string" && REVISION_PARAM.test(raw) ? Number(raw) : null;
}

export type RevisionSummary = { revision: number; createdAt: string; buildSha: string; note: string | null };

export type Revision = RevisionSummary & {
  title: string;
  description: string;
  tags: string[];
  hullItem: string;
  /** The open fit JSON as it was. */
  fit: unknown;
  /** True when the fit's stored content is exactly this revision's: the fit's current evaluation then describes it. */
  matchesCurrent: boolean;
};

type Row = Record<string, any>;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** The fit's revisions, newest first. Empty for a fit that has none (published before history existed). */
export async function listRevisions(db: Queryable, fitId: string): Promise<RevisionSummary[]> {
  if (!ID.test(fitId)) return [];
  const { rows } = await db.query<Row>(
    `SELECT revision, created_at, build_sha, note FROM fit_revisions WHERE fit_id = $1 ORDER BY revision DESC LIMIT ${REVISION_LIST_MAX}`,
    [fitId],
  );
  return rows.map((row) => ({ revision: row.revision, createdAt: iso(row.created_at), buildSha: row.build_sha, note: row.note ?? null }));
}

/** One revision of a fit, or null when there is no such number. */
export async function getRevision(db: Queryable, fitId: string, revision: number): Promise<Revision | null> {
  if (!ID.test(fitId) || !Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647) return null;
  const { rows } = await db.query<Row>(
    `SELECT r.revision, r.created_at, r.build_sha, r.note, r.title, r.description, r.tags, r.hull_item, r.fit,
            (r.fit = f.fit) AS matches_current
     FROM fit_revisions r JOIN fits f ON f.id = r.fit_id
     WHERE r.fit_id = $1 AND r.revision = $2`,
    [fitId, revision],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    revision: row.revision,
    createdAt: iso(row.created_at),
    buildSha: row.build_sha,
    note: row.note ?? null,
    title: row.title,
    description: row.description,
    tags: row.tags,
    hullItem: row.hull_item,
    fit: row.fit,
    matchesCurrent: row.matches_current === true,
  };
}
