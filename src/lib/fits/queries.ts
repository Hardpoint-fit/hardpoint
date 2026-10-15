// Every read and write on the fits database. Server code only (nothing here imports a client), but
// pure of Next so node --test can run it against pglite. Takes a `Db`; see db.ts for the real one.
//
// Rules this module owns:
//  - hidden fits and comments never come back from a public read; an admin viewer sees them, and an
//    author also sees their own drafts;
//  - a vote is one row per (fit, user): counts are computed by query, nothing is stored;
//  - a pilot's name lives only in `pilots` (pilots.ts); fits and comments join it, and every write by a
//    pilot first makes sure their row exists (ensurePilot);
//  - fit_evaluations is a cache of the engine's verdict on the stored JSON for one build; changing a
//    fit's content drops its cached rows, and a published fit can't hold content the engine rejected.
import { randomBytes } from "node:crypto";
import {
  decodeCursor,
  encodeCursor,
  filtersKey,
  normalizeTag,
  MAX_TAGS,
  type BrowseQuery,
} from "./filters.ts";
import type { Db, Queryable } from "./db.ts";
import { notifyBroken, notifyComment, notifyFollowers } from "./notifications.ts";
import { COMMENT_MAX, DESCRIPTION_MAX, FIT_JSON_MAX_BYTES, REPORT_REASON_MAX, REVISION_NOTE_MAX, TITLE_MAX } from "./limits.ts";

// ---------------------------------------------------------------------------------------------------
// Types

export type FitStatus = "draft" | "published" | "hidden";

/** Who is asking. Anonymous readers pass nothing. */
export type Viewer = { userId: string | null; isAdmin: boolean };
export const ANONYMOUS: Viewer = { userId: null, isAdmin: false };

/** Hull item GUID (decimal string) to the catalog's class and role. Comes from the engine; never stored. */
export type HullLookup = ReadonlyMap<string, { hullClass: string; role: string }>;

export type Evaluation = {
  buildSha: string;
  valid: boolean;
  rating: number | null;
  stats: unknown;
  issues: unknown;
  evaluatedAt: string;
};

export type EvaluationInput = {
  buildSha: string;
  valid: boolean;
  rating: number | null;
  stats: unknown;
  issues: unknown;
};

export type FitSummary = {
  id: string;
  authorUserId: string;
  /** The author's current name, from `pilots`. */
  authorName: string;
  title: string;
  hullItem: string;
  tags: string[];
  status: FitStatus;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  votes: number;
  comments: number;
  viewerVoted: boolean;
  /** Whether the viewer has bookmarked it (always false signed out). */
  viewerBookmarked: boolean;
  /** The verdict for the build asked about (`buildSha`), or null when that build hasn't evaluated it. */
  evaluation: Evaluation | null;
  /** The newest valid verdict on any build: what an outdated fit still shows for reference. */
  lastValidEvaluation: Evaluation | null;
  /** Each fitted module's item, in mount order: what a fit card shows the icons of. Read from `fits.fit`. */
  moduleItems: ModuleItemRef[];
  /** `progression.affinityType` of the stored fit ("None" without an affinity), or null when the JSON has none. Read from `fits.fit`. */
  affinityType: string | null;
  /** `progression.affinityXp`, null when the JSON has none; a card turns it into a level with the catalog. */
  affinityXp: number | null;
  /** `progression.allocatedPoints` when it is a short array of whole numbers (the layout has 44 slots), else null: the card names the type holding the most. */
  affinityPoints: number[] | null;
};

/** The parts of a fitted module's item that pick its icon (art/item-icon.ts). */
export type ModuleItemRef = { def: string; rarity: string; isIdentified: boolean; artifact: string | null };

export type FitDetail = FitSummary & {
  /** Markdown source; render with renderMarkdown. */
  description: string;
  /** The open fit JSON, as stored. */
  fit: unknown;
  createdBuildSha: string;
};

export type FitPage = { fits: FitSummary[]; nextCursor: string | null };

export type Comment = {
  id: string;
  fitId: string;
  parentId: string | null;
  authorUserId: string;
  authorName: string;
  /** Markdown source; render with renderMarkdown. */
  body: string;
  createdAt: string;
  editedAt: string | null;
  hidden: boolean;
  /** Set when the author deleted it but replies keep it on the page; `body` is then empty and never the stored text. */
  deletedAt: string | null;
};

export type CommentThread = Comment & { replies: Comment[] };

export type ReportTargetKind = "fit" | "comment";

export type Report = {
  id: string;
  targetKind: ReportTargetKind;
  targetId: string;
  reporterUserId: string;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
  /** What was reported, for the queue; null when it no longer exists. */
  target: { fitId: string; preview: string; hidden: boolean; authorUserId: string; authorName: string } | null;
};

export type FitNeedingEvaluation = {
  id: string;
  hullItem: string;
  fit: unknown;
  /** Pass back to recordEvaluation so a verdict on content the author has since changed is dropped. */
  revision: string;
};

export type FitDataErrorCode = "invalid" | "not_found" | "forbidden" | "not_valid";

/** A refused write. `invalid` carries a message safe to show; the others map to 400/404/403/409. */
export class FitDataError extends Error {
  code: FitDataErrorCode;
  constructor(code: FitDataErrorCode, message: string) {
    super(message);
    this.name = "FitDataError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------------
// Limits and validation

export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;

const GUID = /^\d{1,20}$/;
const ID = /^[0-9A-Za-z]{10}$/;
const NUMERIC_ID = /^\d{1,15}$/;

function length(text: string): number {
  return [...text].length;
}

function invalid(message: string): never {
  throw new FitDataError("invalid", message);
}

export function validateTitle(raw: string): string {
  const title = raw.trim();
  if (title === "") invalid("Give the fit a title.");
  if (/\p{Cc}/u.test(title)) invalid("The title must be a single line of plain text.");
  if (length(title) > TITLE_MAX) invalid(`The title can be at most ${TITLE_MAX} characters.`);
  return title;
}

function cleanBody(raw: string): string {
  return raw.replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
}

export function validateDescription(raw: string): string {
  const description = cleanBody(raw).trim();
  if (length(description) > DESCRIPTION_MAX) invalid(`The description can be at most ${DESCRIPTION_MAX} characters.`);
  return description;
}

export function validateComment(raw: string): string {
  const body = cleanBody(raw).trim();
  if (body === "") invalid("Write something first.");
  if (length(body) > COMMENT_MAX) invalid(`A comment can be at most ${COMMENT_MAX} characters.`);
  return body;
}

export function validateTags(raw: readonly string[]): string[] {
  const tags: string[] = [];
  for (const value of raw) {
    const tag = normalizeTag(value);
    if (tag === null) invalid(`"${value.slice(0, 30)}" isn't a valid tag (letters, digits and dashes, up to 24).`);
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) invalid(`A fit can have at most ${MAX_TAGS} tags.`);
  return tags;
}

/** The author's "what changed?": trimmed, at most REVISION_NOTE_MAX characters, null when empty. */
export function validateRevisionNote(raw: string | null | undefined): string | null {
  const note = cleanBody(raw ?? "").trim();
  if (note === "") return null;
  if (/\p{Cc}/u.test(note)) invalid("The note must be a single line of plain text.");
  if (length(note) > REVISION_NOTE_MAX) invalid(`The note can be at most ${REVISION_NOTE_MAX} characters.`);
  return note;
}

function validateContent(hullItem: string, fit: unknown): { hullItem: string; json: string } {
  if (!GUID.test(hullItem)) invalid("The hull is not valid.");
  if (typeof fit !== "object" || fit === null || Array.isArray(fit)) invalid("The fit is not valid.");
  const json = JSON.stringify(fit);
  if (json.length > FIT_JSON_MAX_BYTES) invalid("The fit is too large.");
  return { hullItem, json };
}

function validateEvaluation(input: EvaluationInput): void {
  if (!input.buildSha || input.buildSha.length > 100) invalid("The build is not valid.");
  if (input.rating !== null && !Number.isFinite(input.rating)) invalid("The rating is not valid.");
}

// ---------------------------------------------------------------------------------------------------
// Helpers

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A 10-character URL-safe id (~59 bits). Rejection sampling keeps the alphabet uniform. */
export function generateFitId(): string {
  let id = "";
  while (id.length < 10) {
    for (const byte of randomBytes(16)) {
      if (byte < 248 && id.length < 10) id += BASE62[byte % 62];
    }
  }
  return id;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function sqlParams() {
  const values: unknown[] = [];
  return {
    values,
    add(value: unknown): string {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

type Row = Record<string, any>;

function pageSize(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
}

// ---------------------------------------------------------------------------------------------------
// Pilots

/** The signed-in pilot a write is made for: their id, and the session's name for a row they lack. */
export type PilotIdentity = { userId: string; name: string };

/**
 * Makes sure the pilot has a `pilots` row before something of theirs is written, creating it from the
 * session's name when it is missing (a session issued before pilot rows existed). Never changes an
 * existing row: sign-in owns the name. Call it inside the write's own transaction.
 */
export async function ensurePilot(db: Queryable, pilot: PilotIdentity): Promise<void> {
  const name = pilot.name.trim();
  if (!pilot.userId || !name) invalid("The author is not valid.");
  await db.query(`INSERT INTO pilots (user_id, name) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [pilot.userId, name]);
}

// ---------------------------------------------------------------------------------------------------
// Fit reads

const EVALUATION_JSON = `jsonb_build_object('buildSha', e.build_sha, 'valid', e.valid, 'rating', e.rating,
  'stats', e.stats, 'issues', e.issues, 'evaluatedAt', e.evaluated_at)`;

const VOTES_SQL = `(SELECT count(*)::int FROM fit_votes v WHERE v.fit_id = f.id)`;
// What listComments shows the public: visible comments, less replies under a hidden comment. Tombstones aren't counted.
const COMMENTS_SQL = `(SELECT count(*)::int FROM fit_comments c WHERE c.fit_id = f.id AND NOT c.hidden AND c.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM fit_comments p WHERE p.id = c.parent_id AND p.hidden))`;

// The icon-picking parts of each module's item, in the fit's mount order. Lax JSON path: a fit without a
// modules array gives none rather than an error.
const MODULE_ITEMS_SQL = `COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'def', m.value #>> '{item,def}', 'rarity', m.value #>> '{item,roll,rarity}',
      'isIdentified', m.value #> '{item,roll,isIdentified}', 'artifact', m.value #>> '{item,roll,artifact}') ORDER BY m.n)
    FROM jsonb_path_query(f.fit, 'lax $.modules[*]') WITH ORDINALITY AS m(value, n)), '[]'::jsonb)`;

// Only the two progression fields a card needs, bounded, not the whole progression: type capped in length,
// XP only when it is a sane number (a hostile or damaged value reads as null rather than failing the query).
const AFFINITY_TYPE_SQL = `CASE WHEN jsonb_typeof(f.fit #> '{progression,affinityType}') = 'string' THEN left(f.fit #>> '{progression,affinityType}', 40) END`;
const AFFINITY_XP_SQL = `CASE WHEN jsonb_typeof(f.fit #> '{progression,affinityXp}') = 'number' THEN
    CASE WHEN (f.fit #>> '{progression,affinityXp}')::numeric BETWEEN 0 AND 1000000000 THEN (f.fit #>> '{progression,affinityXp}')::float8 END END`;

// The first 64 allocated-point slots, as numbers only: a slot holding anything else (a string, an object, null)
// reads as 0 so the others keep their positions (a slot's index is its module type and option). The payload
// per card is at most 64 numbers however large the stored array is. Every cast sits inside the type check.
const AFFINITY_POINTS_SQL = `CASE WHEN jsonb_typeof(f.fit #> '{progression,allocatedPoints}') = 'array' THEN
    (SELECT jsonb_agg(CASE WHEN jsonb_typeof(p.value) = 'number' THEN p.value ELSE '0'::jsonb END ORDER BY p.n)
     FROM (SELECT e.value, e.n FROM jsonb_array_elements(f.fit #> '{progression,allocatedPoints}') WITH ORDINALITY AS e(value, n)
           ORDER BY e.n LIMIT 64) AS p) END`;

export function summaryColumns(shaRef: string, viewerRef: string): string {
  return `f.id, f.author_user_id, p.name AS author_name, f.title, f.hull_item, f.tags, f.status,
    f.created_at, f.updated_at, f.published_at,
    ${VOTES_SQL} AS votes,
    ${COMMENTS_SQL} AS comments,
    EXISTS (SELECT 1 FROM fit_votes v WHERE v.fit_id = f.id AND v.user_id = ${viewerRef}::text) AS viewer_voted,
    EXISTS (SELECT 1 FROM fit_bookmarks bm WHERE bm.fit_id = f.id AND bm.user_id = ${viewerRef}::text) AS viewer_bookmarked,
    (SELECT ${EVALUATION_JSON} FROM fit_evaluations e WHERE e.fit_id = f.id AND e.build_sha = ${shaRef}::text) AS evaluation,
    (SELECT ${EVALUATION_JSON} FROM fit_evaluations e WHERE e.fit_id = f.id AND e.valid
       ORDER BY e.evaluated_at DESC, e.build_sha DESC LIMIT 1) AS last_valid_evaluation,
    ${MODULE_ITEMS_SQL} AS module_items,
    ${AFFINITY_TYPE_SQL} AS affinity_type,
    ${AFFINITY_XP_SQL} AS affinity_xp,
    ${AFFINITY_POINTS_SQL} AS affinity_points`;
}

function mapModuleItems(value: unknown): ModuleItemRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: Row) =>
    typeof entry?.def === "string"
      ? [{ def: entry.def, rarity: typeof entry.rarity === "string" ? entry.rarity : "Normal", isIdentified: entry.isIdentified === true, artifact: typeof entry.artifact === "string" ? entry.artifact : null }]
      : [],
  );
}

function mapEvaluation(value: unknown): Evaluation | null {
  if (value === null || value === undefined) return null;
  const e = value as Row;
  return {
    buildSha: e.buildSha,
    valid: e.valid,
    rating: e.rating ?? null,
    stats: e.stats,
    issues: e.issues,
    evaluatedAt: iso(e.evaluatedAt),
  };
}

export function mapSummary(row: Row): FitSummary {
  return {
    id: row.id,
    authorUserId: row.author_user_id,
    authorName: row.author_name,
    title: row.title,
    hullItem: row.hull_item,
    tags: row.tags,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    publishedAt: isoOrNull(row.published_at),
    votes: row.votes,
    comments: row.comments,
    viewerVoted: row.viewer_voted,
    viewerBookmarked: row.viewer_bookmarked,
    evaluation: mapEvaluation(row.evaluation),
    lastValidEvaluation: mapEvaluation(row.last_valid_evaluation),
    moduleItems: mapModuleItems(row.module_items),
    affinityType: typeof row.affinity_type === "string" ? row.affinity_type : null,
    affinityXp: row.affinity_xp === null || row.affinity_xp === undefined ? null : Number(row.affinity_xp),
    affinityPoints: Array.isArray(row.affinity_points) && row.affinity_points.every((each: unknown) => Number.isInteger(each)) ? row.affinity_points : null,
  };
}

export type GetFitOptions = { viewer?: Viewer; buildSha?: string | null };

/**
 * One fit, or null when it doesn't exist or this viewer may not see it. Published fits are public; the
 * author also sees their drafts; an admin sees everything, hidden included.
 */
export async function getFit(db: Queryable, id: string, options: GetFitOptions = {}): Promise<FitDetail | null> {
  if (!ID.test(id)) return null;
  const viewer = options.viewer ?? ANONYMOUS;
  const { rows } = await db.query<Row>(
    `SELECT ${summaryColumns("$2", "$3")}, f.description, f.fit, f.created_build_sha
     FROM fits f JOIN pilots p ON p.user_id = f.author_user_id
     WHERE f.id = $1
       AND (f.status = 'published' OR $4::boolean OR (f.status IN ('draft', 'hidden') AND f.author_user_id = $3::text))`,
    [id, options.buildSha ?? null, viewer.userId, viewer.isAdmin],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...mapSummary(row), description: row.description, fit: row.fit, createdBuildSha: row.created_build_sha };
}

export type BrowseOptions = {
  query: BrowseQuery;
  /** The opaque cursor from the previous page's `nextCursor`. A cursor made for another sort or other filters is ignored. */
  cursor?: string;
  limit?: number;
  /** The engine's current build. Needed for "works on current build" and for each fit's `evaluation`. */
  buildSha?: string | null;
  /** Needed to filter by hull class or role (both are derived from the hull, never stored). */
  hulls?: HullLookup;
  viewer?: Viewer;
  /** For tests: the clock "top this week" counts back from. */
  now?: Date;
};

/**
 * Published fits (plus the viewer's own drafts when they browse their own author page), filtered and
 * sorted. Every sort orders by (score desc, time desc, id desc), a total order, so paging by cursor
 * neither repeats nor skips a fit that wasn't changed between requests.
 */
export async function browseFits(db: Queryable, options: BrowseOptions): Promise<FitPage> {
  const { query } = options;
  const viewer = options.viewer ?? ANONYMOUS;
  const size = pageSize(options.limit);
  const p = sqlParams();
  const sha = p.add(options.buildSha ?? null);
  const viewerRef = p.add(viewer.userId);

  const where: string[] = [];
  const own = viewer.userId !== null && query.author === viewer.userId;
  // Your own page lists everything of yours, labelled by status; anyone else's lists only what is published.
  if (!own) where.push(`f.status = 'published'`);

  if (query.author) where.push(`f.author_user_id = ${p.add(query.author)}`);
  if (query.hull) where.push(`f.hull_item = ${p.add(query.hull)}`);
  if (query.tags.length > 0) where.push(`f.tags @> ${p.add(query.tags)}::text[]`);
  // Only a signed-in viewer follows anyone; signed out, the filter is ignored.
  if (query.following && viewer.userId !== null) {
    where.push(`f.author_user_id IN (SELECT followee_user_id FROM pilot_follows WHERE follower_user_id = ${viewerRef}::text)`);
  }

  if (query.q) {
    // One branch per column so each can use its trigram index; the pattern is escaped and the query capped.
    const pattern = p.add(`%${query.q.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`f.id IN (
      SELECT id FROM fits WHERE title ILIKE ${pattern}
      UNION SELECT id FROM fits WHERE description ILIKE ${pattern}
      UNION SELECT fp.id FROM fits fp JOIN pilots pp ON pp.user_id = fp.author_user_id WHERE pp.name ILIKE ${pattern})`);
  }
  if (query.modules.length > 0) {
    // The fit JSON owns its modules: containment on fits.fit, answered by the jsonb_path_ops index.
    const wanted = { modules: query.modules.map((def) => ({ item: { def } })) };
    where.push(`f.fit @> ${p.add(JSON.stringify(wanted))}::jsonb`);
  }

  if (query.hullClass || query.role) {
    const hulls = [...(options.hulls ?? [])]
      .filter(([, h]) => (!query.hullClass || h.hullClass === query.hullClass) && (!query.role || h.role === query.role))
      .map(([item]) => item);
    where.push(`f.hull_item = ANY(${p.add(hulls)}::text[])`);
  }

  if (query.currentBuild) {
    where.push(
      options.buildSha
        ? `EXISTS (SELECT 1 FROM fit_evaluations e WHERE e.fit_id = f.id AND e.build_sha = ${sha}::text AND e.valid)`
        : `false`,
    );
  }

  const cursor = options.cursor ? decodeCursor(options.cursor, query.sort, filtersKey(query)) : undefined;
  // A later page of "top this week" keeps the week its first page counted.
  const now = cursor?.now ?? (options.now ?? new Date()).toISOString();
  const scoreSql =
    query.sort === "top-all"
      ? VOTES_SQL
      : query.sort === "discussed"
        ? COMMENTS_SQL
        : query.sort === "new"
          ? `0`
          : `(SELECT count(*)::int FROM fit_votes v WHERE v.fit_id = f.id
               AND v.created_at > ${p.add(now)}::timestamptz - interval '7 days')`;

  const after = cursor
    ? `WHERE (score, sort_at, id) < (${p.add(cursor.score)}::int, ${p.add(cursor.at)}::timestamptz, ${p.add(cursor.id)}::text)`
    : "";

  const { rows } = await db.query<Row>(
    `WITH base AS (
       SELECT ${summaryColumns(sha, viewerRef)},
         ${scoreSql} AS score,
         COALESCE(f.published_at, f.updated_at) AS sort_at,
         COALESCE(f.published_at, f.updated_at)::text AS sort_at_text
       FROM fits f JOIN pilots p ON p.user_id = f.author_user_id
       WHERE ${where.join(" AND ")}
     )
     SELECT * FROM base ${after}
     ORDER BY score DESC, sort_at DESC, id DESC
     LIMIT ${size + 1}`,
    p.values,
  );

  const pageRows = rows.slice(0, size);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > size && last
      ? encodeCursor({
          sort: query.sort,
          score: last.score,
          at: last.sort_at_text,
          id: last.id,
          filters: filtersKey(query),
          ...(query.sort === "top-week" ? { now } : {}),
        })
      : null;
  return { fits: pageRows.map(mapSummary), nextCursor };
}

// ---------------------------------------------------------------------------------------------------
// Fit writes

export type FitContent = { hullItem: string; fit: unknown };

export type CreateFitInput = {
  authorUserId: string;
  /** The session's name: only creates the author's pilot row when it is missing (ensurePilot); never stored on the fit. */
  authorName: string;
  title: string;
  description?: string;
  tags?: readonly string[];
  content: FitContent;
  /** The engine build the author built against. */
  buildSha: string;
  /** The engine's verdict on `content` for `buildSha`, stored with the fit. */
  evaluation?: EvaluationInput;
  /**
   * The fit this one was copied from. Recorded only when that fit exists and the author may see it (published,
   * or their own); anything else stores no credit and is not an error.
   */
  forkedFrom?: string | null;
};

/**
 * Appends the fit's current content as its next revision (1, 2, 3, ...). Call it inside the transaction that
 * holds the fit row's lock (`SELECT ... FOR UPDATE`) and has just made the change being recorded, so the
 * numbers never collide and a revision exists exactly when its change does. `buildSha` is the build the
 * content was checked against; without one the previous revision's (or the fit's creation) build is kept.
 */
async function appendRevision(tx: Queryable, input: { fitId: string; buildSha: string | null; note: string | null }): Promise<void> {
  await tx.query(
    `INSERT INTO fit_revisions (fit_id, revision, title, description, tags, hull_item, fit, build_sha, note)
     SELECT f.id, COALESCE((SELECT max(r.revision) FROM fit_revisions r WHERE r.fit_id = f.id), 0) + 1,
            f.title, f.description, f.tags, f.hull_item, f.fit,
            COALESCE($2::text,
                     (SELECT r.build_sha FROM fit_revisions r WHERE r.fit_id = f.id ORDER BY r.revision DESC LIMIT 1),
                     f.created_build_sha),
            $3::text
     FROM fits f WHERE f.id = $1`,
    [input.fitId, input.buildSha, input.note],
  );
}

async function insertEvaluation(db: Queryable, fitId: string, e: EvaluationInput): Promise<void> {
  validateEvaluation(e);
  await db.query(
    `INSERT INTO fit_evaluations (fit_id, build_sha, valid, rating, stats, issues)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     ON CONFLICT (fit_id, build_sha) DO UPDATE
       SET valid = EXCLUDED.valid, rating = EXCLUDED.rating, stats = EXCLUDED.stats,
           issues = EXCLUDED.issues, evaluated_at = now()`,
    [fitId, e.buildSha, e.valid, e.rating, JSON.stringify(e.stats ?? {}), JSON.stringify(e.issues ?? [])],
  );
}

/** Creates a draft owned by the author. Returns the stored fit. */
export async function createFit(db: Db, input: CreateFitInput): Promise<FitDetail> {
  const title = validateTitle(input.title);
  const description = validateDescription(input.description ?? "");
  const tags = validateTags(input.tags ?? []);
  const { hullItem, json } = validateContent(input.content.hullItem, input.content.fit);
  if (!input.buildSha) invalid("The build is not valid.");
  if (!input.authorUserId || !input.authorName.trim()) invalid("The author is not valid.");

  for (let attempt = 0; ; attempt++) {
    const id = generateFitId();
    try {
      return await db.transaction(async (tx) => {
        await ensurePilot(tx, { userId: input.authorUserId, name: input.authorName });
        // The fork credit is a convenience, never a reason to fail: FOR KEY SHARE keeps the source from being
        // deleted under the insert, and if it still is (23503), the insert runs again inside a savepoint
        // with no credit. Only this statement is retried.
        const insertSql = (credit: boolean) =>
          `INSERT INTO fits (id, author_user_id, title, description, hull_item, tags, fit, created_build_sha, forked_from)
           VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8,
             ${credit ? "(SELECT s.id FROM fits s WHERE s.id = $9::text AND (s.status = 'published' OR s.author_user_id = $2) FOR KEY SHARE)" : "$9::text"})`;
        const source = input.forkedFrom && ID.test(input.forkedFrom) ? input.forkedFrom : null;
        const args = [id, input.authorUserId, title, description, hullItem, tags, json, input.buildSha];
        await tx.query("SAVEPOINT fork_credit");
        try {
          await tx.query(insertSql(true), [...args, source]);
        } catch (error) {
          if (errorCode(error) !== "23503") throw error;
          await tx.query("ROLLBACK TO SAVEPOINT fork_credit");
          await tx.query(insertSql(false), [...args, null]);
        }
        await tx.query("RELEASE SAVEPOINT fork_credit");
        if (input.evaluation) await insertEvaluation(tx, id, input.evaluation);
        const fit = await getFit(tx, id, { viewer: { userId: input.authorUserId, isAdmin: false }, buildSha: input.buildSha });
        return fit!;
      });
    } catch (error) {
      // A 59-bit id collides about never; retry rather than surface it.
      if (errorCode(error) === "23505" && attempt < 4) continue;
      throw error;
    }
  }
}

export type UpdateFitInput = {
  id: string;
  /** Must be the fit's author. */
  authorUserId: string;
  title?: string;
  description?: string;
  tags?: readonly string[];
  /** New fit content. Drops the fit's cached evaluations; pass `evaluation` to store the new verdict. */
  content?: FitContent;
  evaluation?: EvaluationInput;
  /** "What changed?", recorded with the revision a save of a published fit appends. Ignored for a draft. */
  note?: string | null;
};

/**
 * Edits the author's own fit and keeps its id, votes and comments. A published fit can only change
 * content to something the engine accepted (`evaluation.valid`); unpublish it first to save a broken one.
 * Hidden fits can't be edited. Every save of a published fit appends a revision (appendRevision) in the same
 * transaction; a draft's saves leave no history.
 */
export async function updateFit(db: Db, input: UpdateFitInput): Promise<FitDetail> {
  const title = input.title === undefined ? undefined : validateTitle(input.title);
  const description = input.description === undefined ? undefined : validateDescription(input.description);
  const tags = input.tags === undefined ? undefined : validateTags(input.tags);
  const content = input.content === undefined ? undefined : validateContent(input.content.hullItem, input.content.fit);
  if (input.evaluation && !content) invalid("An evaluation needs new content to belong to.");

  return db.transaction(async (tx) => {
    const { rows } = await tx.query<Row>(`SELECT author_user_id, status FROM fits WHERE id = $1 FOR UPDATE`, [input.id]);
    const current = rows[0];
    if (!current || !ID.test(input.id)) throw new FitDataError("not_found", "No such fit.");
    if (current.author_user_id !== input.authorUserId || current.status === "hidden") {
      throw new FitDataError("forbidden", "You can't edit this fit.");
    }
    if (content && current.status === "published" && input.evaluation?.valid !== true) {
      throw new FitDataError("not_valid", "A published fit can only change to a fit that passes validation.");
    }

    await tx.query(
      `UPDATE fits SET
         title = COALESCE($2, title),
         description = COALESCE($3, description),
         tags = COALESCE($4::text[], tags),
         hull_item = COALESCE($5, hull_item),
         fit = COALESCE($6::jsonb, fit),
         updated_at = now()
       WHERE id = $1`,
      [input.id, title ?? null, description ?? null, tags ?? null, content?.hullItem ?? null, content?.json ?? null],
    );
    if (content) {
      await tx.query(`DELETE FROM fit_evaluations WHERE fit_id = $1`, [input.id]);
      if (input.evaluation) await insertEvaluation(tx, input.id, input.evaluation);
    }
    // Only a note that will be stored is checked: a draft's save ignores it.
    if (current.status === "published") {
      await appendRevision(tx, { fitId: input.id, buildSha: input.evaluation?.buildSha ?? null, note: validateRevisionNote(input.note) });
    }
    const fit = await getFit(tx, input.id, {
      viewer: { userId: input.authorUserId, isAdmin: false },
      buildSha: input.evaluation?.buildSha ?? null,
    });
    return fit!;
  });
}

/**
 * Publishes the author's draft. Refused unless the engine's cached verdict for `buildSha` says the fit
 * is valid. Publishing again keeps the original publication time. Going from draft to published appends
 * a revision, including a re-publish after an unpublish; publishing a fit that is already published
 * changes nothing and appends none.
 */
export async function publishFit(db: Db, input: { id: string; authorUserId: string; buildSha: string; note?: string | null }): Promise<FitDetail> {
  const note = validateRevisionNote(input.note);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<Row>(`SELECT author_user_id, status, published_at FROM fits WHERE id = $1 FOR UPDATE`, [input.id]);
    const current = rows[0];
    if (!current || !ID.test(input.id)) throw new FitDataError("not_found", "No such fit.");
    if (current.author_user_id !== input.authorUserId || current.status === "hidden") {
      throw new FitDataError("forbidden", "You can't publish this fit.");
    }
    const { rows: valid } = await tx.query(
      `SELECT 1 FROM fit_evaluations WHERE fit_id = $1 AND build_sha = $2 AND valid`,
      [input.id, input.buildSha],
    );
    if (valid.length === 0) throw new FitDataError("not_valid", "Only a fit that passes validation can be published.");
    await tx.query(
      `UPDATE fits SET status = 'published', published_at = COALESCE(published_at, now()), updated_at = now() WHERE id = $1`,
      [input.id],
    );
    if (current.status !== "published") {
      await appendRevision(tx, { fitId: input.id, buildSha: input.buildSha, note });
      // Followers hear of a fit once: a republish after an unpublish is not news.
      if (current.published_at === null) await notifyFollowers(tx, { fitId: input.id, authorUserId: input.authorUserId });
    }
    return (await getFit(tx, input.id, { viewer: { userId: input.authorUserId, isAdmin: false }, buildSha: input.buildSha }))!;
  });
}

/**
 * Takes the author's own published fit back to a draft. Votes and comments stay. `published_at` is kept
 * (the CHECK allows a draft to carry it): publishFit's COALESCE then restores the original publication
 * time on a re-publish, so the fit returns to where it ranked rather than jumping to the top as new.
 * A hidden fit is the moderators' to restore, so only status 'published' matches. Ownership is the WHERE.
 */
export async function unpublishFit(db: Queryable, input: { id: string; authorUserId: string }): Promise<boolean> {
  const { rows } = await db.query(
    `WITH gone AS (
       UPDATE fits SET status = 'draft', updated_at = now()
       WHERE id = $1 AND author_user_id = $2 AND status = 'published' RETURNING id
     ),
     told AS (DELETE FROM notifications WHERE fit_id IN (SELECT id FROM gone))
     SELECT id FROM gone`,
    [input.id, input.authorUserId],
  );
  return rows.length > 0;
}

/**
 * Deletes the author's own fit in whatever status, with its votes, bookmarks, revisions, comments,
 * evaluations (all cascade) and every report about the fit or its comments (target_id is text, not a foreign
 * key, so they are deleted here). Its forks keep working: the same statement nulls their `forked_from` and marks
 * them `forked_from_deleted` (the foreign key's SET NULL is then a no-op, and the CHECK that the two never
 * coexist holds throughout), so the page can say the source no longer exists. One
 * statement: ownership is the WHERE and the reports and marks go in the same snapshot as the fit.
 * False when there is no such fit of theirs.
 */
export async function deleteFit(db: Queryable, input: { id: string; authorUserId: string }): Promise<boolean> {
  if (!ID.test(input.id)) return false;
  const { rows } = await db.query(
    `WITH gone AS (DELETE FROM fits WHERE id = $1 AND author_user_id = $2 RETURNING id),
     forks AS (UPDATE fits SET forked_from = NULL, forked_from_deleted = true WHERE forked_from IN (SELECT id FROM gone)),
     reports AS (
       DELETE FROM fit_reports r
       WHERE (r.target_kind = 'fit' AND r.target_id IN (SELECT id FROM gone))
          OR (r.target_kind = 'comment' AND r.target_id IN
              (SELECT c.id::text FROM fit_comments c WHERE c.fit_id IN (SELECT id FROM gone)))
     )
     SELECT id FROM gone`,
    [input.id, input.authorUserId],
  );
  return rows.length > 0;
}

/**
 * Moderation: hides a published fit from every public read, or restores a hidden one. False if nothing changed.
 * Hiding deletes the fit's notifications in the same statement; restoring does not bring them back.
 */
export async function setFitHidden(db: Queryable, id: string, hidden: boolean): Promise<boolean> {
  const { rows } = await db.query(
    hidden
      ? `WITH hid AS (UPDATE fits SET status = 'hidden' WHERE id = $1 AND status = 'published' RETURNING id),
           told AS (DELETE FROM notifications WHERE fit_id IN (SELECT id FROM hid))
         SELECT id FROM hid`
      : `UPDATE fits SET status = 'published' WHERE id = $1 AND status = 'hidden' RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------------
// Votes

export type VoteResult = { voted: boolean; votes: number };

async function countVotes(db: Queryable, fitId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM fit_votes WHERE fit_id = $1`, [fitId]);
  return rows[0]!.n;
}

/**
 * Sets whether `userId` has voted for a published fit. Idempotent: asking for the state they're already
 * in changes nothing, and a user has at most one vote per fit however often or concurrently they ask.
 * An author may vote for their own fit, once like anyone else.
 */
export async function setVote(db: Queryable, input: { fitId: string; userId: string; voted: boolean }): Promise<VoteResult> {
  if (!input.userId) invalid("Sign in to vote.");
  if (input.voted) {
    const { rows } = await db.query(
      `INSERT INTO fit_votes (fit_id, user_id)
       SELECT id, $2 FROM fits WHERE id = $1 AND status = 'published'
       ON CONFLICT (fit_id, user_id) DO NOTHING RETURNING fit_id`,
      [input.fitId, input.userId],
    );
    if (rows.length === 0) {
      const { rows: exists } = await db.query(`SELECT 1 FROM fits WHERE id = $1 AND status = 'published'`, [input.fitId]);
      if (exists.length === 0) throw new FitDataError("not_found", "No such fit.");
    }
  } else {
    await db.query(`DELETE FROM fit_votes WHERE fit_id = $1 AND user_id = $2`, [input.fitId, input.userId]);
  }
  const { rows } = await db.query(`SELECT 1 FROM fit_votes WHERE fit_id = $1 AND user_id = $2`, [input.fitId, input.userId]);
  return { voted: rows.length > 0, votes: await countVotes(db, input.fitId) };
}

/** Flips the user's vote. Use setVote when the client knows which state it wants (double clicks). */
export async function toggleVote(db: Db, input: { fitId: string; userId: string }): Promise<VoteResult> {
  return db.transaction(async (tx) => {
    // Lock the fit row so two concurrent toggles from one user serialize instead of both inserting.
    await tx.query(`SELECT 1 FROM fits WHERE id = $1 FOR UPDATE`, [input.fitId]);
    const { rows } = await tx.query(`SELECT 1 FROM fit_votes WHERE fit_id = $1 AND user_id = $2`, [input.fitId, input.userId]);
    return setVote(tx, { ...input, voted: rows.length === 0 });
  });
}

// ---------------------------------------------------------------------------------------------------
// Comments

function mapComment(row: Row): Comment {
  return {
    id: row.id,
    fitId: row.fit_id,
    parentId: row.parent_id ?? null,
    authorUserId: row.author_user_id,
    authorName: row.author_name,
    // A tombstone's stored body is only the placeholder that satisfies the CHECK; it is never read out.
    body: row.deleted_at ? "" : row.body,
    createdAt: iso(row.created_at),
    editedAt: isoOrNull(row.edited_at),
    hidden: row.hidden,
    deletedAt: isoOrNull(row.deleted_at),
  };
}

// Unqualified so it also serves as a RETURNING list; the author's name is read from `pilots`.
const COMMENT_COLUMNS = `id::text AS id, fit_id, parent_id::text AS parent_id, author_user_id,
  (SELECT p.name FROM pilots p WHERE p.user_id = fit_comments.author_user_id) AS author_name, body,
  created_at, edited_at, hidden, deleted_at`;

export type CreateCommentInput = {
  fitId: string;
  /** A top-level comment of the same fit, or omitted for a new top-level comment. */
  parentId?: string | null;
  authorUserId: string;
  /** The session's name: only creates the author's pilot row when it is missing (ensurePilot). */
  authorName: string;
  body: string;
};

export async function createComment(db: Db, input: CreateCommentInput): Promise<Comment> {
  const body = validateComment(input.body);
  if (!input.authorUserId || !input.authorName.trim()) invalid("The author is not valid.");
  const parentId = input.parentId ?? null;
  if (parentId !== null && !NUMERIC_ID.test(parentId)) invalid("That comment can't be replied to.");

  return db.transaction(async (tx) => {
    const { rows: fits } = await tx.query(`SELECT 1 FROM fits WHERE id = $1 AND status = 'published'`, [input.fitId]);
    if (fits.length === 0) throw new FitDataError("not_found", "No such fit.");
    let parentAuthor: string | null = null;
    if (parentId !== null) {
      const { rows } = await tx.query<Row>(
        `SELECT fit_id, parent_id, author_user_id, hidden, deleted_at FROM fit_comments WHERE id = $1::bigint`,
        [parentId],
      );
      const parent = rows[0];
      if (!parent || parent.fit_id !== input.fitId || parent.parent_id !== null || parent.hidden || parent.deleted_at) {
        invalid("That comment can't be replied to.");
      }
      parentAuthor = parent.author_user_id;
    }
    await ensurePilot(tx, { userId: input.authorUserId, name: input.authorName });
    const { rows } = await tx.query<Row>(
      `INSERT INTO fit_comments (fit_id, parent_id, author_user_id, body)
       VALUES ($1, $2::bigint, $3, $4) RETURNING ${COMMENT_COLUMNS}`,
      [input.fitId, parentId, input.authorUserId, body],
    );
    const comment = mapComment(rows[0]!);
    await notifyComment(tx, { fitId: input.fitId, commentId: comment.id, actorUserId: input.authorUserId, parentAuthorUserId: parentAuthor });
    return comment;
  });
}

/** The author edits their own visible comment; `edited_at` records it. */
export async function editComment(db: Queryable, input: { id: string; authorUserId: string; body: string }): Promise<Comment> {
  const body = validateComment(input.body);
  if (!NUMERIC_ID.test(input.id)) throw new FitDataError("not_found", "No such comment.");
  const { rows } = await db.query<Row>(
    `UPDATE fit_comments SET body = $3, edited_at = now()
     WHERE id = $1::bigint AND author_user_id = $2 AND NOT hidden AND deleted_at IS NULL RETURNING ${COMMENT_COLUMNS}`,
    [input.id, input.authorUserId, body],
  );
  if (rows[0]) return mapComment(rows[0]);
  const { rows: existing } = await db.query(`SELECT 1 FROM fit_comments WHERE id = $1::bigint`, [input.id]);
  throw existing.length === 0
    ? new FitDataError("not_found", "No such comment.")
    : new FitDataError("forbidden", "You can't edit this comment.");
}

export type CommentDeletion = "removed" | "tombstoned";

/**
 * The author deletes their own comment. With replies it becomes a tombstone (deleted_at set, body the
 * placeholder '[deleted]') so the replies keep their place; without, the row is removed. Either way its
 * open reports are resolved, since the reported text is gone. Deleting the last reply under a tombstone
 * removes the tombstone too. Null when there is no such live comment of theirs. The row lock is taken
 * with ownership in the WHERE and also stops a reply from landing between the replies check and a DELETE.
 */
export async function deleteComment(db: Db, input: { id: string; authorUserId: string }): Promise<CommentDeletion | null> {
  if (!NUMERIC_ID.test(input.id)) return null;
  return db.transaction(async (tx) => {
    const { rows: mine } = await tx.query<Row>(
      `SELECT parent_id::text AS parent_id FROM fit_comments
       WHERE id = $1::bigint AND author_user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [input.id, input.authorUserId],
    );
    if (mine.length === 0) return null;
    const closeReports = (id: string) =>
      tx.query(`UPDATE fit_reports SET resolved_at = now() WHERE target_kind = 'comment' AND target_id = $1 AND resolved_at IS NULL`, [id]);
    const { rows: tombstoned } = await tx.query(
      `UPDATE fit_comments SET body = '[deleted]', deleted_at = now()
       WHERE id = $1::bigint AND author_user_id = $2 AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM fit_comments r WHERE r.parent_id = fit_comments.id)
       RETURNING id`,
      [input.id, input.authorUserId],
    );
    if (tombstoned.length > 0) {
      await closeReports(input.id);
      // The comment is gone from the page, and so is what it told anyone.
      await tx.query(`DELETE FROM notifications WHERE comment_id = $1::bigint`, [input.id]);
      return "tombstoned" as const;
    }
    await tx.query(`DELETE FROM fit_comments WHERE id = $1::bigint AND author_user_id = $2`, [input.id, input.authorUserId]);
    await closeReports(input.id);
    const parentId = mine[0]!.parent_id;
    if (parentId) {
      // A tombstone with no replies left has nothing to hold up.
      await tx.query(
        `DELETE FROM fit_comments p WHERE p.id = $1::bigint AND p.deleted_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM fit_comments r WHERE r.parent_id = p.id)`,
        [parentId],
      );
    }
    return "removed" as const;
  });
}

/** Moderation: hides a comment (and so its replies) from public reads, or restores it. The caller checks admin. */
export async function setCommentHidden(db: Queryable, id: string, hidden: boolean): Promise<boolean> {
  if (!NUMERIC_ID.test(id)) return false;
  // Hiding a comment hides its replies too, so the notifications about either go with it.
  const { rows } = await db.query(
    `WITH changed AS (UPDATE fit_comments SET hidden = $2 WHERE id = $1::bigint AND hidden <> $2 RETURNING id),
     told AS (
       DELETE FROM notifications
       WHERE $2::boolean AND (comment_id IN (SELECT id FROM changed)
          OR comment_id IN (SELECT r.id FROM fit_comments r WHERE r.parent_id IN (SELECT id FROM changed)))
     )
     SELECT id FROM changed`,
    [id, hidden],
  );
  return rows.length > 0;
}

/**
 * A fit's comments, oldest first: top-level comments each with their replies. Hidden comments are left
 * out for everyone but an admin, and a hidden top-level comment takes its replies with it. The caller
 * has already checked the viewer may see the fit. `limit` caps top-level comments.
 */
export async function listComments(
  db: Queryable,
  fitId: string,
  options: { viewer?: Viewer; limit?: number } = {},
): Promise<CommentThread[]> {
  const showHidden = options.viewer?.isAdmin === true;
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 500);
  const { rows: tops } = await db.query<Row>(
    `SELECT ${COMMENT_COLUMNS} FROM fit_comments
     WHERE fit_id = $1 AND parent_id IS NULL AND ($2::boolean OR NOT hidden)
     ORDER BY created_at, id LIMIT ${limit}`,
    [fitId, showHidden],
  );
  if (tops.length === 0) return [];
  const { rows: replies } = await db.query<Row>(
    `SELECT ${COMMENT_COLUMNS} FROM fit_comments
     WHERE parent_id = ANY($1::bigint[]) AND ($2::boolean OR NOT hidden)
     ORDER BY created_at, id`,
    [tops.map((row) => row.id), showHidden],
  );
  const byParent = new Map<string, Comment[]>();
  for (const row of replies) {
    const reply = mapComment(row);
    byParent.set(reply.parentId!, [...(byParent.get(reply.parentId!) ?? []), reply]);
  }
  return tops.map((row) => ({ ...mapComment(row), replies: byParent.get(row.id) ?? [] }));
}

// ---------------------------------------------------------------------------------------------------
// Reports

/**
 * Files a report. A reporter has at most one open report per target: a second call returns the existing
 * one with `created: false` rather than a duplicate. Once an admin resolves it they may report again.
 */
export async function createReport(
  db: Queryable,
  input: { targetKind: ReportTargetKind; targetId: string; reporterUserId: string; reason: string },
): Promise<{ id: string; created: boolean }> {
  const reason = input.reason.replace(/\u0000/g, "").trim();
  if (reason === "") invalid("Say what's wrong.");
  if (length(reason) > REPORT_REASON_MAX) invalid(`A reason can be at most ${REPORT_REASON_MAX} characters.`);
  if (input.targetKind !== "fit" && input.targetKind !== "comment") invalid("You can't report that.");
  if (!input.reporterUserId) invalid("Sign in to report.");

  const { rows: target } =
    input.targetKind === "fit"
      ? await db.query(`SELECT 1 FROM fits WHERE id = $1 AND status = 'published'`, [input.targetId])
      : NUMERIC_ID.test(input.targetId)
        ? await db.query(
            `SELECT 1 FROM fit_comments c JOIN fits f ON f.id = c.fit_id
             WHERE c.id = $1::bigint AND NOT c.hidden AND c.deleted_at IS NULL AND f.status = 'published'`,
            [input.targetId],
          )
        : { rows: [] };
  if (target.length === 0) throw new FitDataError("not_found", "That no longer exists.");

  const values = [input.targetKind, input.targetId, input.reporterUserId, reason];
  // The open report that blocked the insert can be resolved before it is read back; then insert again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO fit_reports (target_kind, target_id, reporter_user_id, reason)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id::text AS id`,
      values,
    );
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
    const { rows } = await db.query<{ id: string }>(
      `SELECT id::text AS id FROM fit_reports
       WHERE target_kind = $1 AND target_id = $2 AND reporter_user_id = $3 AND resolved_at IS NULL`,
      values.slice(0, 3),
    );
    if (rows[0]) return { id: rows[0].id, created: false };
  }
  throw new Error("The report was resolved and reopened under it three times running.");
}

/** Open reports, oldest first, with a preview of the reported thing. Page with `afterId`. */
export async function listOpenReports(
  db: Queryable,
  options: { limit?: number; afterId?: string } = {},
): Promise<{ reports: Report[]; nextAfterId: string | null }> {
  const size = pageSize(options.limit ?? 50);
  const after = options.afterId && NUMERIC_ID.test(options.afterId) ? options.afterId : "0";
  const { rows } = await db.query<Row>(
    `SELECT r.id::text AS id, r.target_kind, r.target_id, r.reporter_user_id, r.reason, r.created_at, r.resolved_at,
       CASE r.target_kind WHEN 'fit' THEN f.id ELSE cf.id END AS target_fit_id,
       CASE r.target_kind WHEN 'fit' THEN f.title ELSE left(c.body, 200) END AS preview,
       CASE r.target_kind WHEN 'fit' THEN f.status = 'hidden' ELSE c.hidden END AS target_hidden,
       ap.user_id AS target_author_user_id, ap.name AS target_author_name
     FROM fit_reports r
     LEFT JOIN fits f ON r.target_kind = 'fit' AND f.id = r.target_id
     LEFT JOIN fit_comments c ON r.target_kind = 'comment' AND r.target_id ~ '^[0-9]{1,15}$' AND c.id = (CASE WHEN r.target_id ~ '^[0-9]{1,15}$' THEN r.target_id::bigint END)
     LEFT JOIN fits cf ON cf.id = c.fit_id
     LEFT JOIN pilots ap ON ap.user_id = (CASE r.target_kind WHEN 'fit' THEN f.author_user_id ELSE c.author_user_id END)
     WHERE r.resolved_at IS NULL AND r.id > $1::bigint
     ORDER BY r.id
     LIMIT ${size + 1}`,
    [after],
  );
  const page = rows.slice(0, size);
  const reports = page.map(
    (row): Report => ({
      id: row.id,
      targetKind: row.target_kind,
      targetId: row.target_id,
      reporterUserId: row.reporter_user_id,
      reason: row.reason,
      createdAt: iso(row.created_at),
      resolvedAt: isoOrNull(row.resolved_at),
      target: row.target_fit_id
        ? {
            fitId: row.target_fit_id,
            preview: row.preview,
            hidden: row.target_hidden === true,
            authorUserId: row.target_author_user_id,
            authorName: row.target_author_name,
          }
        : null,
    }),
  );
  return { reports, nextAfterId: rows.length > size ? page[page.length - 1]!.id : null };
}

/** Closes one open report. False if it was already resolved or doesn't exist. */
export async function resolveReport(db: Queryable, id: string): Promise<boolean> {
  if (!NUMERIC_ID.test(id)) return false;
  const { rows } = await db.query(
    `UPDATE fit_reports SET resolved_at = now() WHERE id = $1::bigint AND resolved_at IS NULL RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/** Closes every open report about one target, for when a moderator acts on the target itself. Returns how many. */
export async function resolveReportsForTarget(db: Queryable, targetKind: ReportTargetKind, targetId: string): Promise<number> {
  const { rows } = await db.query(
    `UPDATE fit_reports SET resolved_at = now()
     WHERE target_kind = $1 AND target_id = $2 AND resolved_at IS NULL RETURNING id`,
    [targetKind, targetId],
  );
  return rows.length;
}

// ---------------------------------------------------------------------------------------------------
// Evaluations (the re-evaluation job)

/**
 * The stored content of one fit at one moment, whatever its status, for the engine to evaluate. The
 * `revision` goes back to recordEvaluation so a verdict for content the author changed meanwhile is dropped.
 * Null when there is no such fit.
 */
export async function getFitForEvaluation(db: Queryable, id: string): Promise<FitNeedingEvaluation | null> {
  if (!ID.test(id)) return null;
  const { rows } = await db.query<Row>(`SELECT id, hull_item, fit, updated_at::text AS revision FROM fits WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? { id: row.id, hullItem: row.hull_item, fit: row.fit, revision: row.revision } : null;
}

/**
 * Published fits with no verdict stored for `buildSha`, oldest first, and those whose valid verdict was
 * stored before the engine sent hull specs or modifier groups (no `sections` or `modifierGroups` key in
 * its stats), so the next run fills them in.
 * Record a verdict for every one you evaluate, failures included (valid: false), or the next call returns
 * it again.
 */
export async function fitsNeedingEvaluation(db: Queryable, buildSha: string, limit = 50): Promise<FitNeedingEvaluation[]> {
  const { rows } = await db.query<Row>(
    `SELECT f.id, f.hull_item, f.fit, f.updated_at::text AS revision
     FROM fits f
     WHERE f.status = 'published'
       AND NOT EXISTS (SELECT 1 FROM fit_evaluations e WHERE e.fit_id = f.id AND e.build_sha = $1
                         AND (NOT e.valid OR (e.stats -> 'sections' IS NOT NULL
                                              AND e.stats -> 'modifierGroups' IS NOT NULL)))
     ORDER BY f.published_at, f.id
     LIMIT ${pageSize(limit)}`,
    [buildSha],
  );
  return rows.map((row) => ({ id: row.id, hullItem: row.hull_item, fit: row.fit, revision: row.revision }));
}

/**
 * Stores (or replaces) the engine's verdict for one fit on one build. With `revision` from
 * fitsNeedingEvaluation, a fit edited since is left alone and this returns false, so a slow batch can't
 * cache a verdict for content that no longer exists. False too when the fit is gone.
 *
 * The fit row is read FOR SHARE: an edit in flight (updateFit holds the row FOR UPDATE) is waited for and
 * its revision is the one compared, and no edit can start until this verdict is stored. So a stale verdict
 * can't replace the fresh one an edit stored for the same build, on insert or on conflict.
 *
 * An invalid verdict on a published fit whose latest verdict on another build was valid tells its author
 * (notifyBroken), in this transaction and once per build.
 */
export async function recordEvaluation(
  db: Db,
  fitId: string,
  evaluation: EvaluationInput,
  options: { revision?: string } = {},
): Promise<boolean> {
  validateEvaluation(evaluation);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<Row>(`SELECT updated_at::text AS revision FROM fits WHERE id = $1 FOR SHARE`, [fitId]);
    const current = rows[0];
    if (!current || (options.revision !== undefined && current.revision !== options.revision)) return false;
    await insertEvaluation(tx, fitId, evaluation);
    // A published fit that was valid on another build and is not on this one: its author is told, once per build.
    await notifyBroken(tx, { fitId, buildSha: evaluation.buildSha, valid: evaluation.valid });
    return true;
  });
}
