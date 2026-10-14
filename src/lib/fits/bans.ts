// Bans. `pilot_bans` owns whether a pilot may write: one row per banned pilot, deleted to unban. Every signed-in
// write in actions-core calls assertNotBanned first, so no write path can skip it; reads never consult it.
// Banning can also hide everything the pilot published, in the same transaction, the way moderation hides one
// fit or comment (its notifications go, its open reports close). Pure of Next, like queries.ts.
import type { Db, Queryable } from "./db.ts";
import { decodePilotCursor, encodePilotCursor, MAX_SEARCH_LENGTH } from "./filters.ts";
import { BAN_REASON_MAX } from "./limits.ts";
import { FitDataError } from "./queries.ts";
import { safeAvatarUrl } from "./pilots.ts";

export const BANNED_MESSAGE = "Your account is suspended from posting.";

/** Thrown by assertNotBanned; actions-core turns it into a 403 refusal with BANNED_MESSAGE. */
export class PilotBannedError extends Error {
  constructor() {
    super(BANNED_MESSAGE);
    this.name = "PilotBannedError";
  }
}

const USER_ID = /^[A-Za-z0-9_-]{1,100}$/;
type Row = Record<string, any>;

export async function isBanned(db: Queryable, userId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM pilot_bans WHERE user_id = $1`, [userId]);
  return rows.length > 0;
}

/** Refuses a banned pilot's write. Called before the write's budget is spent, so a refused write costs nothing. */
export async function assertNotBanned(db: Queryable, userId: string): Promise<void> {
  if (await isBanned(db, userId)) throw new PilotBannedError();
}

export type PilotBan = {
  reason: string;
  bannedBy: string;
  /** The moderator's pilot name, when they have a pilot row. */
  bannedByName: string | null;
  createdAt: string;
};

const iso = (value: unknown) => new Date(value as string).toISOString();

function mapBan(row: Row): PilotBan | null {
  if (row.ban_reason === null || row.ban_reason === undefined) return null;
  return { reason: row.ban_reason, bannedBy: row.ban_by, bannedByName: row.ban_by_name ?? null, createdAt: iso(row.ban_at) };
}

const BAN_COLUMNS = `b.reason AS ban_reason, b.banned_by AS ban_by, bp.name AS ban_by_name, b.created_at AS ban_at`;
const BAN_JOIN = `LEFT JOIN pilot_bans b ON b.user_id = p.user_id LEFT JOIN pilots bp ON bp.user_id = b.banned_by`;

/** The pilot's ban, or null. For admin views only. */
export async function getBan(db: Queryable, userId: string): Promise<PilotBan | null> {
  if (!USER_ID.test(userId)) return null;
  const { rows } = await db.query<Row>(`SELECT ${BAN_COLUMNS} FROM pilots p ${BAN_JOIN} WHERE p.user_id = $1`, [userId]);
  return rows[0] ? mapBan(rows[0]) : null;
}

/** Plain text, 1 to BAN_REASON_MAX characters. */
export function validateBanReason(raw: string): string {
  const reason = raw.replace(/\u0000/g, "").trim();
  if (reason === "") throw new FitDataError("invalid", "Say why.");
  if ([...reason].length > BAN_REASON_MAX) throw new FitDataError("invalid", `A reason can be at most ${BAN_REASON_MAX} characters.`);
  return reason;
}

export type HiddenContent = { fits: number; comments: number; reports: number };

/**
 * Hides everything of the pilot's that others can see: published fits become hidden (drafts stay drafts, which
 * no one else sees), live comments become hidden (and with them their replies, as moderation hides one). The
 * notifications about those fits and comments are deleted, as setFitHidden and setCommentHidden delete them, and
 * every open report about any of the pilot's fits or comments is resolved. One statement, one snapshot.
 */
export async function hidePilotContent(db: Queryable, userId: string): Promise<HiddenContent> {
  const { rows } = await db.query<Row>(
    `WITH hid_fits AS (
       UPDATE fits SET status = 'hidden' WHERE author_user_id = $1 AND status = 'published' RETURNING id
     ),
     hid_comments AS (
       UPDATE fit_comments SET hidden = true WHERE author_user_id = $1 AND NOT hidden AND deleted_at IS NULL RETURNING id
     ),
     told AS (
       DELETE FROM notifications
       WHERE fit_id IN (SELECT id FROM hid_fits)
          OR comment_id IN (SELECT id FROM hid_comments)
          OR comment_id IN (SELECT r.id FROM fit_comments r WHERE r.parent_id IN (SELECT id FROM hid_comments))
     ),
     closed AS (
       UPDATE fit_reports SET resolved_at = now()
       WHERE resolved_at IS NULL
         AND ((target_kind = 'fit' AND target_id IN (SELECT id FROM fits WHERE author_user_id = $1))
           OR (target_kind = 'comment' AND target_id IN (SELECT id::text FROM fit_comments WHERE author_user_id = $1)))
       RETURNING id
     )
     SELECT (SELECT count(*)::int FROM hid_fits) AS fits, (SELECT count(*)::int FROM hid_comments) AS comments,
       (SELECT count(*)::int FROM closed) AS reports`,
    [userId],
  );
  return { fits: rows[0]!.fits, comments: rows[0]!.comments, reports: rows[0]!.reports };
}

export type BanResult = {
  /** False when the pilot was banned already (the first ban's reason stands). */
  created: boolean;
  /** What "hide all their fits and comments" changed; null when it wasn't asked for. */
  hidden: HiddenContent | null;
};

/**
 * Bans a pilot who has a row, on behalf of moderator `bannedBy` (actions-core has checked they are an admin now).
 * Every rule is checked inside the transaction, after locking the pilot rows of both the target and the moderator
 * (in user id order, so two moderators banning each other can't deadlock): the moderator is not banned (so of two
 * concurrent bans of each other, the second sees the first and is refused), the target is not the moderator, and
 * `isProtected(target)` (a site admin) is false. Idempotent: banning a banned pilot keeps the first ban, and can
 * still hide their content.
 */
export async function banPilot(
  db: Db,
  input: { userId: string; reason: string; bannedBy: string; hideAll: boolean; isProtected?: (userId: string) => Promise<boolean> | boolean },
): Promise<BanResult> {
  const reason = validateBanReason(input.reason);
  if (!USER_ID.test(input.userId)) throw new FitDataError("not_found", "No such pilot.");
  return db.transaction(async (tx) => {
    const { rows: locked } = await tx.query<Row>(
      `SELECT user_id FROM pilots WHERE user_id = ANY($1::text[]) ORDER BY user_id FOR UPDATE`,
      [[input.userId, input.bannedBy]],
    );
    if (input.userId === input.bannedBy) throw new FitDataError("invalid", "You can't ban yourself.");
    if (await input.isProtected?.(input.userId)) throw new FitDataError("forbidden", "Site admins can't be banned.");
    if (!locked.some((row) => row.user_id === input.userId)) throw new FitDataError("not_found", "No such pilot.");
    await assertNotBanned(tx, input.bannedBy);
    const { rows } = await tx.query(
      `INSERT INTO pilot_bans (user_id, reason, banned_by) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
      [input.userId, reason, input.bannedBy],
    );
    return { created: rows.length > 0, hidden: input.hideAll ? await hidePilotContent(tx, input.userId) : null };
  });
}

/** Lifts a ban. What a ban hid stays hidden; moderators restore it one fit or comment at a time. False if not banned. */
export async function unbanPilot(db: Queryable, userId: string): Promise<boolean> {
  if (!USER_ID.test(userId)) return false;
  const { rows } = await db.query(`DELETE FROM pilot_bans WHERE user_id = $1 RETURNING user_id`, [userId]);
  return rows.length > 0;
}

export type AdminPilot = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  joinedAt: string;
  publishedFits: number;
  comments: number;
  ban: PilotBan | null;
};

export type AdminPilotPage = { pilots: AdminPilot[]; nextCursor: string | null };

export const PILOT_PAGE_SIZE = 50;

/**
 * The admin pilot list, newest pilot first, paged by (row created at, user id). `q` matches a user id exactly or
 * a name by substring (escaped, capped like browse search); `banned` lists banned pilots only.
 */
export async function listPilots(
  db: Queryable,
  options: { q?: string; banned?: boolean; cursor?: string; limit?: number } = {},
): Promise<AdminPilotPage> {
  const size = Math.min(Math.max(Math.trunc(options.limit ?? PILOT_PAGE_SIZE), 1), 100);
  const params: unknown[] = [];
  const add = (value: unknown) => `$${params.push(value)}`;
  const where: string[] = [];
  const q = options.q?.trim().slice(0, MAX_SEARCH_LENGTH);
  if (q) {
    const pattern = add(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(p.user_id = ${add(q)} OR p.name ILIKE ${pattern})`);
  }
  if (options.banned) where.push(`b.user_id IS NOT NULL`);
  const cursor = options.cursor ? decodePilotCursor(options.cursor) : undefined;
  if (cursor) where.push(`(p.created_at, p.user_id) < (${add(cursor.at)}::timestamptz, ${add(cursor.id)}::text)`);
  const { rows } = await db.query<Row>(
    `SELECT p.user_id, p.name, p.avatar_url, p.created_at, p.created_at::text AS created_at_text,
       (SELECT count(*)::int FROM fits f WHERE f.author_user_id = p.user_id AND f.status = 'published') AS published_fits,
       (SELECT count(*)::int FROM fit_comments c WHERE c.author_user_id = p.user_id AND c.deleted_at IS NULL) AS comments,
       ${BAN_COLUMNS}
     FROM pilots p ${BAN_JOIN}
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY p.created_at DESC, p.user_id DESC
     LIMIT ${size + 1}`,
    params,
  );
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    pilots: page.map((row) => ({
      userId: row.user_id,
      name: row.name,
      avatarUrl: safeAvatarUrl(row.avatar_url),
      joinedAt: iso(row.created_at),
      publishedFits: row.published_fits,
      comments: row.comments,
      ban: mapBan(row),
    })),
    nextCursor: rows.length > size && last ? encodePilotCursor({ at: last.created_at_text, id: last.user_id }) : null,
  };
}
