// The work behind the site's server actions, over injected dependencies so tests can run it on pglite
// with any auth state. Every write authenticates first (requireAuthor / requireAdmin), so a site
// without sign-in refuses with 503 before touching the database. Results are values, never throws:
// the UI shows `message`. Nothing here logs a body, a comment or a token.
import { AuthError, toAuthRefusal, type AuthErrorReason } from "../auth-errors";
import type { Author } from "../auth-core";
import type { EngineClient } from "../engine/client";
import type { EvaluationIssue, OpenFit } from "../engine/types";
import type { DatabaseState, Db } from "../fits/db";
import { publish as publishService, saveDraft, type Refusal } from "../fits/service";
import {
  FitDataError,
  createComment,
  createReport,
  editComment as editCommentRow,
  getFit,
  resolveReport as resolveReportRow,
  resolveReportsForTarget,
  setCommentHidden,
  setFitHidden,
  setVote,
  type Comment,
  type FitStatus,
  type ReportTargetKind,
  type Viewer,
} from "../fits/queries";
import { isOpenFit } from "../engine/open-fit";

export type ActionAuth = { requireAuthor(): Promise<Author>; requireAdmin(): Promise<Author> };

export type ActionDeps = {
  database: () => DatabaseState;
  auth: ActionAuth;
  engine: Pick<EngineClient, "exportFitString" | "evaluate">;
};

export type ActionRefusal = {
  ok: false;
  reason: AuthErrorReason | FitDataError["code"] | "unavailable" | "engine" | "invalid_fit" | "error";
  status: number;
  message: string;
  /** Why the engine says the fit isn't valid, when that is the refusal. */
  issues?: EvaluationIssue[];
};

export type ActionResult<T extends object = object> = ({ ok: true } & T) | ActionRefusal;

export const DATABASE_DOWN_MESSAGE = "Fits are unavailable right now. Try again in a moment.";
export const ENGINE_DOWN_FOR_EXPORT = "The loadout engine can't be reached right now, so the fit string can't be made.";

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

async function withAuthor<T extends object>(
  deps: ActionDeps,
  what: string,
  work: (db: Db, author: Author) => Promise<ActionResult<T>>,
  admin = false,
): Promise<ActionResult<T>> {
  return run(what, async () => {
    const author = admin ? await deps.auth.requireAdmin() : await deps.auth.requireAuthor();
    const db = databaseOf(deps);
    if (!db) return refuse("unavailable", 503, DATABASE_DOWN_MESSAGE);
    return work(db, author);
  });
}

export function vote(deps: ActionDeps, input: { fitId: string; voted: boolean }): Promise<ActionResult<{ voted: boolean; votes: number }>> {
  return withAuthor(deps, "vote", async (db, author) => ({ ok: true, ...(await setVote(db, { fitId: input.fitId, userId: author.userId, voted: input.voted })) }));
}

export function addComment(deps: ActionDeps, input: { fitId: string; parentId: string | null; body: string }): Promise<ActionResult<{ comment: Comment }>> {
  return withAuthor(deps, "comment", async (db, author) => ({
    ok: true,
    comment: await createComment(db, { fitId: input.fitId, parentId: input.parentId, authorUserId: author.userId, authorName: author.name, body: input.body }),
  }));
}

export function editComment(deps: ActionDeps, input: { id: string; body: string }): Promise<ActionResult<{ comment: Comment }>> {
  return withAuthor(deps, "comment edit", async (db, author) => ({
    ok: true,
    comment: await editCommentRow(db, { id: input.id, authorUserId: author.userId, body: input.body }),
  }));
}

export function report(
  deps: ActionDeps,
  input: { targetKind: ReportTargetKind; targetId: string; reason: string },
): Promise<ActionResult<{ created: boolean }>> {
  return withAuthor(deps, "report", async (db, author) => {
    const { created } = await createReport(db, { ...input, reporterUserId: author.userId });
    return { ok: true, created };
  });
}

/** Admin: hides or restores a fit or a comment. Hiding closes the open reports about it. */
export function moderate(
  deps: ActionDeps,
  input: { targetKind: ReportTargetKind; targetId: string; hidden: boolean },
): Promise<ActionResult<{ changed: boolean; resolved: number }>> {
  return withAuthor(
    deps,
    "moderation",
    async (db) => {
      const changed =
        input.targetKind === "fit" ? await setFitHidden(db, input.targetId, input.hidden) : await setCommentHidden(db, input.targetId, input.hidden);
      const resolved = input.hidden ? await resolveReportsForTarget(db, input.targetKind, input.targetId) : 0;
      return { ok: true, changed, resolved };
    },
    true,
  );
}

/** Admin: closes a report without acting on what it reported. */
export function resolveReport(deps: ActionDeps, input: { reportId: string }): Promise<ActionResult<{ resolved: boolean }>> {
  return withAuthor(deps, "report resolve", async (db) => ({ ok: true, resolved: await resolveReportRow(db, input.reportId) }), true);
}

/** The fit string of a fit the viewer can see, from the engine. Needs no sign-in. */
export function copyFitString(deps: ActionDeps, input: { fitId: string; viewer: Viewer }): Promise<ActionResult<{ fitString: string }>> {
  return run("fit string", async () => {
    const db = databaseOf(deps);
    if (!db) return refuse("unavailable", 503, DATABASE_DOWN_MESSAGE);
    const fit = await getFit(db, input.fitId, { viewer: input.viewer });
    if (!fit) return refuse("not_found", 404, "No such fit.");
    if (!isOpenFit(fit.fit)) return refuse("invalid", 400, "This fit can't be turned into a fit string.");
    const result = await deps.engine.exportFitString(fit.fit);
    if (!result.ok) {
      return result.error.kind === "rejected"
        ? refuse("engine", 422, `The engine can't export this fit: ${result.error.message}`)
        : refuse("engine", 503, ENGINE_DOWN_FOR_EXPORT);
    }
    return { ok: true, fitString: result.value.fitString };
  });
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
 * verdict when it answers. Editing a published fit keeps it published, so the new content must pass.
 */
export function saveFit(
  deps: ActionDeps,
  input: { fitId: string | null; title: string; description: string; tags: readonly string[]; fit: OpenFit; buildSha: string | null },
): Promise<ActionResult<{ fit: SavedFit }>> {
  return withAuthor(deps, "fit save", async (db, author) => {
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
        buildSha: input.buildSha,
      },
    );
    if (!result.ok) return serviceRefusal(result);
    return { ok: true, fit: { fitId: result.fit.id, status: result.fit.status, updatedAt: result.fit.updatedAt, evaluation: result.evaluation } };
  });
}

/** Publishes the author's saved fit if the engine, asked now, says it is valid; otherwise says why. */
export function publishFit(deps: ActionDeps, input: { fitId: string }): Promise<ActionResult<{ fitId: string }>> {
  return withAuthor(deps, "fit publish", async (db, author) => {
    const result = await publishService({ db, engine: deps.engine }, { fitId: input.fitId, authorUserId: author.userId });
    return result.ok ? { ok: true, fitId: result.fit.id } : serviceRefusal(result);
  });
}
