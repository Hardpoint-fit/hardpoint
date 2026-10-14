// Pilot profiles and follows. `pilots` owns a pilot's name, avatar and bio: sign-in writes the name and
// avatar (upsertPilotAtSignIn), the pilot writes their bio (setBio), and fits and comments join it for
// the author's name. Follows are one row per (follower, followee); every count is computed by query.
// Pure of Next, like queries.ts, so node --test runs it on pglite.
import type { Db, Queryable } from "./db.ts";
import { BIO_MAX } from "./limits.ts";
import { FitDataError, ensurePilot, type PilotIdentity, type Viewer } from "./queries.ts";
/** The longest avatar URL kept; anything longer is dropped, as a non-https one is. */
export const AVATAR_URL_MAX = 2048;

const USER_ID = /^[A-Za-z0-9_-]{1,100}$/;

export type PilotProfile = {
  userId: string;
  name: string;
  /** An https URL, or null for the placeholder. */
  avatarUrl: string | null;
  /** Plain text; render it as text, never as HTML or markdown. */
  bio: string;
  publishedFits: number;
  /** Upvotes on the pilot's published fits. */
  upvotesReceived: number;
  /** Their most upvoted published fit with at least one upvote; ties go to the earlier published. */
  topFit: { id: string; title: string; votes: number } | null;
  followers: number;
  following: number;
  /** Whether the viewer follows this pilot; false when signed out or viewing themself. */
  viewerFollows: boolean;
};

/** An avatar URL worth storing: https only, no credentials, bounded. Anything else is null (the placeholder). */
export function safeAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > AVATAR_URL_MAX) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href.length <= AVATAR_URL_MAX ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Records who signed in: creates their row, or refreshes its name and avatar from the session. A missing
 * or non-https avatar is stored as null. The bio is the pilot's and is never touched here.
 */
export async function upsertPilotAtSignIn(db: Queryable, input: { userId: string; name: string; avatarUrl: string | null }): Promise<void> {
  const name = input.name.trim();
  if (!USER_ID.test(input.userId) || !name) throw new FitDataError("invalid", "The pilot is not valid.");
  await db.query(
    `INSERT INTO pilots (user_id, name, avatar_url) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, updated_at = now()
       WHERE (pilots.name, pilots.avatar_url) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.avatar_url)`,
    [input.userId, name, safeAvatarUrl(input.avatarUrl)],
  );
}

type Row = Record<string, any>;

/** One pilot's header: who they are and the totals of what they published, all counted in SQL. Null when there is no such pilot. */
export async function getPilotProfile(db: Queryable, userId: string, viewer: Viewer): Promise<PilotProfile | null> {
  if (!USER_ID.test(userId)) return null;
  const { rows } = await db.query<Row>(
    `SELECT p.user_id, p.name, p.avatar_url, p.bio,
       (SELECT count(*)::int FROM fits f WHERE f.author_user_id = p.user_id AND f.status = 'published') AS published_fits,
       (SELECT count(*)::int FROM fit_votes v JOIN fits f ON f.id = v.fit_id
          WHERE f.author_user_id = p.user_id AND f.status = 'published') AS upvotes_received,
       (SELECT jsonb_build_object('id', t.id, 'title', t.title, 'votes', t.votes)
          FROM (SELECT f.id, f.title, f.published_at, (SELECT count(*)::int FROM fit_votes v WHERE v.fit_id = f.id) AS votes
                FROM fits f WHERE f.author_user_id = p.user_id AND f.status = 'published') t
          WHERE t.votes > 0
          ORDER BY t.votes DESC, t.published_at, t.id LIMIT 1) AS top_fit,
       (SELECT count(*)::int FROM pilot_follows pf WHERE pf.followee_user_id = p.user_id) AS followers,
       (SELECT count(*)::int FROM pilot_follows pf WHERE pf.follower_user_id = p.user_id) AS following,
       EXISTS (SELECT 1 FROM pilot_follows pf WHERE pf.follower_user_id = $2::text AND pf.followee_user_id = p.user_id) AS viewer_follows
     FROM pilots p WHERE p.user_id = $1`,
    [userId, viewer.userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    name: row.name,
    avatarUrl: safeAvatarUrl(row.avatar_url),
    bio: row.bio,
    publishedFits: row.published_fits,
    upvotesReceived: row.upvotes_received,
    topFit: row.top_fit ? { id: row.top_fit.id, title: row.top_fit.title, votes: row.top_fit.votes } : null,
    followers: row.followers,
    following: row.following,
    viewerFollows: row.viewer_follows,
  };
}

export type FollowResult = { following: boolean; followers: number };

/**
 * Sets whether `follower` follows `followeeUserId`. Idempotent like a vote: asking for the state they are
 * already in changes nothing. A pilot can't follow themself, and only a pilot with a row can be followed.
 */
export async function setFollow(
  db: Db,
  input: { follower: PilotIdentity; followeeUserId: string; following: boolean },
): Promise<FollowResult> {
  if (!USER_ID.test(input.followeeUserId)) throw new FitDataError("not_found", "No such pilot.");
  if (input.follower.userId === input.followeeUserId) throw new FitDataError("invalid", "You can't follow yourself.");
  return db.transaction(async (tx) => {
    await ensurePilot(tx, input.follower);
    if (input.following) {
      const { rows } = await tx.query(
        `INSERT INTO pilot_follows (follower_user_id, followee_user_id)
         SELECT $1, user_id FROM pilots WHERE user_id = $2
         ON CONFLICT DO NOTHING RETURNING followee_user_id`,
        [input.follower.userId, input.followeeUserId],
      );
      if (rows.length === 0) {
        const { rows: exists } = await tx.query(`SELECT 1 FROM pilots WHERE user_id = $1`, [input.followeeUserId]);
        if (exists.length === 0) throw new FitDataError("not_found", "No such pilot.");
      }
    } else {
      await tx.query(`DELETE FROM pilot_follows WHERE follower_user_id = $1 AND followee_user_id = $2`, [input.follower.userId, input.followeeUserId]);
    }
    const { rows } = await tx.query<Row>(
      `SELECT EXISTS (SELECT 1 FROM pilot_follows WHERE follower_user_id = $1 AND followee_user_id = $2) AS following,
         (SELECT count(*)::int FROM pilot_follows WHERE followee_user_id = $2) AS followers`,
      [input.follower.userId, input.followeeUserId],
    );
    return { following: rows[0]!.following, followers: rows[0]!.followers };
  });
}

/** Plain text up to BIO_MAX characters: lines are kept, other control characters are refused. */
export function validateBio(raw: string): string {
  const bio = raw.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
  if (/[^\P{Cc}\n]/u.test(bio)) throw new FitDataError("invalid", "The bio must be plain text.");
  if ([...bio].length > BIO_MAX) throw new FitDataError("invalid", `A bio can be at most ${BIO_MAX} characters.`);
  return bio;
}

/** The pilot sets their own bio; an empty one clears it. Their row is the only one the WHERE can touch. */
export async function setBio(db: Db, input: { pilot: PilotIdentity; bio: string }): Promise<string> {
  const bio = validateBio(input.bio);
  return db.transaction(async (tx) => {
    await ensurePilot(tx, input.pilot);
    const { rows } = await tx.query<Row>(`UPDATE pilots SET bio = $2, updated_at = now() WHERE user_id = $1 RETURNING bio`, [input.pilot.userId, bio]);
    return rows[0]!.bio;
  });
}
