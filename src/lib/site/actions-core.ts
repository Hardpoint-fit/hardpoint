// The work behind the site's server actions, over injected dependencies so tests can run it on pglite
// with any auth state. Every write authenticates first (requireAuthor / requireAdmin), so a site
// without sign-in refuses with 503 before touching the database. Results are values, never throws:
// the UI shows `message`. Nothing here logs a body, a comment or a token.
import { AuthError, toAuthRefusal, type AuthErrorReason } from "../auth-errors";
import type { Author } from "../auth-core";
import type { EngineClient } from "../engine/client";
import type { EvaluationIssue, OpenFit } from "../engine/types";
import type { DatabaseState, Db } from "../fits/db";
import { spendWriteBudget, type WriteAction } from "../fits/write-limits";
import { slowDownMessage } from "../slow-down";
import { publish as publishService, saveDraft, type Refusal } from "../fits/service";
import { setBookmark } from "../fits/bookmarks";
import { setBio, setFollow } from "../fits/pilots";
import { markAllRead, openNotification as openNotificationRow, type OpenedNotification } from "../fits/notifications";
import {
  FitDataError,
  createComment,
  createReport,
  deleteComment as deleteCommentRow,
  deleteFit as deleteFitRow,
  unpublishFit as unpublishFitRow,
  editComment as editCommentRow,
  resolveReport as resolveReportRow,
  resolveReportsForTarget,
  setCommentHidden,
  setFitHidden,
  setVote,
  type Comment,
  type CommentDeletion,
  type FitStatus,
  type ReportTargetKind,
} from "../fits/queries";

export type ActionAuth = { requireAuthor(): Promise<Author>; requireAdmin(): Promise<Author> };

export type ActionDeps = {
  database: () => DatabaseState;
  auth: ActionAuth;
  engine: Pick<EngineClient, "evaluate">;
  /** The build of the catalog the server holds: what a draft the engine couldn't check is recorded against. */
  currentBuild?: () => string | null;
  /** For tests: the clock write budgets count by. */
  now?: () => Date;
};

export type ActionRefusal = {
  ok: false;
  reason: AuthErrorReason | FitDataError["code"] | "unavailable" | "engine" | "invalid_fit" | "rate_limited" | "error";
  status: number;
  message: string;
  /** Why the engine says the fit isn't valid, when that is the refusal. */
  issues?: EvaluationIssue[];
  /** rate_limited only: how long until the author's write budget allows this write again. */
  retryAfterMs?: number;
};

export type ActionResult<T extends object = object> = ({ ok: true } & T) | ActionRefusal;

export const DATABASE_DOWN_MESSAGE = "Fits are unavailable right now. Try again in a moment.";

const DATA_STATUS: Record<FitDataError["code"], number> = { invalid: 400, not_found: 404, forbidden: 403, not_valid: 409 };

function refuse(reason: ActionRefusal["reason"], status: number, message: string): ActionRefusal {
  return { ok: false, reason, status, message };
}

function databaseOf(deps: ActionDeps): Db | null {
  const database = deps.database();
  return database.status === "ready" ? database.db : null;
}

/** Runs one action: auth refusals, data refusals and outages become values. */
async function run<T extends object>(what: string, work: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AuthError) return toAuthRefusal(error);
    if (error instanceof FitDataError) return refuse(error.code, DATA_STATUS[error.code], error.message);
    const code = (error as { code?: unknown }).code;
    console.error(`${what} failed:`, code ?? (error as Error).message);
    return refuse("unavailable", 503, DATABASE_DOWN_MESSAGE);
  }
}

/**
 * Runs a signed-in write: authenticates, then spends one from the author's `budget` (write-limits.ts)
 * before the work, so a refused write changes nothing. Moderation passes `admin` and no budget. `own` is for
 * a pilot's marker on their own rows (reading a notification): signed in, no budget, and the work's SQL
 * is scoped to the viewer.
 */
async function withAuthor<T extends object>(
  deps: ActionDeps,
  what: string,
  access: { budget: WriteAction } | { admin: true } | { own: true },
  work: (db: Db, author: Author) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  return run(what, async () => {
    const author = "admin" in access ? await deps.auth.requireAdmin() : await deps.auth.requireAuthor();
    const db = databaseOf(deps);
    if (!db) return refuse("unavailable", 503, DATABASE_DOWN_MESSAGE);
    if ("budget" in access) {
      const spent = await spendWriteBudget(db, author.userId, access.budget, deps.now?.());
      if (!spent.ok) return { ...refuse("rate_limited", 429, slowDownMessage(spent.retryAfterMs)), retryAfterMs: spent.retryAfterMs };
    }
    return work(db, author);
  });
}

export function vote(deps: ActionDeps, input: { fitId: string; voted: boolean }): Promise<ActionResult<{ voted: boolean; votes: number }>> {
  return withAuthor(deps, "vote", { budget: "vote" }, async (db, author) => ({ ok: true, ...(await setVote(db, { fitId: input.fitId, userId: author.userId, voted: input.voted })) }));
}

/** Marks one of the pilot's own notifications read and says where it points (null: not theirs, or gone). */
export function openNotification(deps: ActionDeps, input: { id: string }): Promise<ActionResult<{ target: OpenedNotification | null }>> {
  return withAuthor(deps, "notification open", { own: true }, async (db, author) => ({
    ok: true,
    target: await openNotificationRow(db, { userId: author.userId, id: input.id }),
  }));
}

/** Marks all of the pilot's notifications read. */
export function markAllNotificationsRead(deps: ActionDeps): Promise<ActionResult<{ marked: number }>> {
  return withAuthor(deps, "notifications read", { own: true }, async (db, author) => ({ ok: true, marked: await markAllRead(db, author.userId) }));
}

/** Bookmarks or un-bookmarks a published fit for the signed-in pilot. Idempotent, like vote. */
export function bookmark(deps: ActionDeps, input: { fitId: string; bookmarked: boolean }): Promise<ActionResult<{ bookmarked: boolean }>> {
  return withAuthor(deps, "bookmark", { budget: "bookmark" }, async (db, author) => ({
    ok: true,
    ...(await setBookmark(db, { fitId: input.fitId, userId: author.userId, bookmarked: input.bookmarked })),
  }));
}

export function addComment(deps: ActionDeps, input: { fitId: string; parentId: string | null; body: string }): Promise<ActionResult<{ comment: Comment }>> {
  return withAuthor(deps, "comment", { budget: "comment" }, async (db, author) => ({
    ok: true,
    comment: await createComment(db, { fitId: input.fitId, parentId: input.parentId, authorUserId: author.userId, authorName: author.name, body: input.body }),
  }));
}

export function editComment(deps: ActionDeps, input: { id: string; body: string }): Promise<ActionResult<{ comment: Comment }>> {
  return withAuthor(deps, "comment edit", { budget: "comment" }, async (db, author) => ({
    ok: true,
    comment: await editCommentRow(db, { id: input.id, authorUserId: author.userId, body: input.body }),
  }));
}

export function deleteComment(deps: ActionDeps, input: { id: string }): Promise<ActionResult<{ deletion: CommentDeletion }>> {
  return withAuthor(deps, "comment delete", { budget: "comment" }, async (db, author) => {
    const deletion = await deleteCommentRow(db, { id: input.id, authorUserId: author.userId });
    // The same answer for a comment that doesn't exist and one that isn't theirs.
    return deletion ? { ok: true, deletion } : refuse("not_found", 404, "No such comment of yours.");
  });
}

export function report(
  deps: ActionDeps,
  input: { targetKind: ReportTargetKind; targetId: string; reason: string },
): Promise<ActionResult<{ created: boolean }>> {
  return withAuthor(deps, "report", { budget: "report" }, async (db, author) => {
    const { created } = await createReport(db, { ...input, reporterUserId: author.userId });
    return { ok: true, created };
  });
}

/** Admin: hides or restores a fit or a comment. Hiding closes the open reports about it. */
export function moderate(
  deps: ActionDeps,
  input: { targetKind: ReportTargetKind; targetId: string; hidden: boolean },
): Promise<ActionResult<{ changed: boolean; resolved: number }>> {
  return withAuthor(deps, "moderation", { admin: true }, async (db) => {
    const changed =
      input.targetKind === "fit" ? await setFitHidden(db, input.targetId, input.hidden) : await setCommentHidden(db, input.targetId, input.hidden);
    const resolved = input.hidden ? await resolveReportsForTarget(db, input.targetKind, input.targetId) : 0;
    return { ok: true, changed, resolved };
  });
}

/** Admin: closes a report without acting on what it reported. */
export function resolveReport(deps: ActionDeps, input: { reportId: string }): Promise<ActionResult<{ resolved: boolean }>> {
  return withAuthor(deps, "report resolve", { admin: true }, async (db) => ({ ok: true, resolved: await resolveReportRow(db, input.reportId) }));
}

/** A fit service refusal as an action result. */
function serviceRefusal(refusal: Refusal): ActionRefusal {
  switch (refusal.reason) {
    case "engine":
      return refuse("engine", refusal.engineError.kind === "rejected" ? 422 : 503, refusal.message);
    case "invalid_fit":
      return { ...refuse("invalid_fit", 409, refusal.message), issues: refusal.issues };
    default:
      return refuse(refusal.reason, DATA_STATUS[refusal.reason], refusal.message);
  }
}

export type SavedFit = {
  fitId: string;
  status: FitStatus;
  updatedAt: string;
  /** "skipped": the engine didn't answer, so the draft was stored unchecked. */
  evaluation: "stored" | "skipped";
};

/**
 * Saves the builder's fit as the author's draft (a new one, or an edit of theirs), with the engine's
 * verdict when it answers. Editing a published fit keeps it published, so the new content must pass, and
 * each such save appends a revision carrying the optional `note` ("what changed?"). `forkedFrom` is the fit a
 * new fit was copied from; it is credit recorded on the first save only, and dropped when the source isn't
 * one the author may see.
 */
export function saveFit(
  deps: ActionDeps,
  input: { fitId: string | null; title: string; description: string; tags: readonly string[]; fit: OpenFit; note?: string | null; forkedFrom?: string | null },
): Promise<ActionResult<{ fit: SavedFit }>> {
  return withAuthor(deps, "fit save", { budget: "fit" }, async (db, author) => {
    const result = await saveDraft(
      { db, engine: deps.engine },
      {
        authorUserId: author.userId,
        authorName: author.name,
        fitId: input.fitId ?? undefined,
        title: input.title,
        description: input.description,
        tags: input.tags,
        fit: input.fit,
        buildSha: deps.currentBuild?.() ?? null,
        note: input.note,
        forkedFrom: input.fitId === null ? input.forkedFrom : null,
      },
    );
    if (!result.ok) return serviceRefusal(result);
    return { ok: true, fit: { fitId: result.fit.id, status: result.fit.status, updatedAt: result.fit.updatedAt, evaluation: result.evaluation } };
  });
}

/** Publishes the author's saved fit if the engine, asked now, says it is valid; otherwise says why. */
export function publishFit(deps: ActionDeps, input: { fitId: string }): Promise<ActionResult<{ fitId: string }>> {
  return withAuthor(deps, "fit publish", { budget: "fit" }, async (db, author) => {
    const result = await publishService({ db, engine: deps.engine }, { fitId: input.fitId, authorUserId: author.userId });
    return result.ok ? { ok: true, fitId: result.fit.id } : serviceRefusal(result);
  });
}

/** Takes the author's own published fit back to a draft; votes and comments stay. */
export function unpublishFit(deps: ActionDeps, input: { fitId: string }): Promise<ActionResult<{ fitId: string }>> {
  return withAuthor(deps, "fit unpublish", { budget: "fit" }, async (db, author) =>
    (await unpublishFitRow(db, { id: input.fitId, authorUserId: author.userId }))
      ? { ok: true, fitId: input.fitId }
      : refuse("not_found", 404, "No published fit of yours with that id."),
  );
}

/** Deletes the author's own fit, whatever its status, with its votes, comments and reports. */
export function deleteFit(deps: ActionDeps, input: { fitId: string }): Promise<ActionResult<{ fitId: string }>> {
  return withAuthor(deps, "fit delete", { budget: "fit" }, async (db, author) =>
    (await deleteFitRow(db, { id: input.fitId, authorUserId: author.userId }))
      ? { ok: true, fitId: input.fitId }
      : refuse("not_found", 404, "No such fit of yours."),
  );
}

/** Follows or unfollows another pilot. Idempotent; a pilot can't follow themself. */
export function follow(deps: ActionDeps, input: { userId: string; following: boolean }): Promise<ActionResult<{ following: boolean; followers: number }>> {
  return withAuthor(deps, "follow", { budget: "follow" }, async (db, author) => ({
    ok: true,
    ...(await setFollow(db, { follower: author, followeeUserId: input.userId, following: input.following })),
  }));
}

/** Sets the signed-in pilot's own bio; there is no id to forge, the session says whose it is. */
export function editBio(deps: ActionDeps, input: { bio: string }): Promise<ActionResult<{ bio: string }>> {
  return withAuthor(deps, "bio edit", { budget: "profile" }, async (db, author) => ({ ok: true, bio: await setBio(db, { pilot: author, bio: input.bio }) }));
}
