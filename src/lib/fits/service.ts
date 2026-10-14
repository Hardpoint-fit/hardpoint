// Fit workflows that need both the database and the engine: saving a draft, publishing, re-evaluating.
// The engine decides validity, stats and rating; the database stores what it said. Nothing here
// authenticates: every function takes the acting user's id as a parameter and trusts it. Callers (the
// server actions of Task 5) must pass the id of the authenticated session user, never one from the request.

import type { EngineClient, EngineError } from "../engine/client.ts";
import type { EvaluationIssue, EvaluationResponse, OpenFit } from "../engine/types.ts";
import {
  FitDataError,
  createFit,
  getFit,
  getFitForEvaluation,
  publishFit,
  recordEvaluation,
  updateFit,
  type EvaluationInput,
  type FitDataErrorCode,
  type FitDetail,
} from "./queries.ts";
import type { Db } from "./db.ts";

export type FitServiceDeps = {
  db: Db;
  /** Only evaluate is used. */
  engine: Pick<EngineClient, "evaluate">;
};

/**
 * What is stored in a fit's evaluation `stats` column: everything the engine computed except the verdict,
 * hull specs included, so a fit page draws them with the engine down. A row stored before the engine sent
 * `sections` lacks the key; the re-evaluation job asks again for those (queries.ts fitsNeedingEvaluation).
 */
export type StoredStats = Pick<EvaluationResponse, "stats" | "conduits" | "regaliaSets" | "sections">;

/** The engine's answer as the database stores it. A fit that fails has no rating. */
export function toEvaluationInput(response: EvaluationResponse): EvaluationInput {
  const stats: StoredStats = {
    stats: response.stats,
    conduits: response.conduits,
    regaliaSets: response.regaliaSets,
    sections: Array.isArray(response.sections) ? response.sections : [],
  };
  return {
    buildSha: response.buildSha,
    valid: response.valid,
    rating: response.valid ? response.rating : null,
    stats,
    issues: response.issues,
  };
}

export const ENGINE_DOWN_MESSAGE =
  "The loadout engine can't be reached right now, so this fit can't be checked. Your draft is saved; try publishing again in a moment.";

/** A refusal the page can show. `message` is safe for the user. */
export type Refusal =
  | { reason: FitDataErrorCode; message: string }
  /** The engine couldn't answer (down, slow, rate limited, or refused the input). */
  | { reason: "engine"; message: string; engineError: EngineError }
  /** The engine answered and the fit is not legal. */
  | { reason: "invalid_fit"; message: string; issues: EvaluationIssue[] };

export type SaveDraftResult =
  | {
      ok: true;
      fit: FitDetail;
      /** "stored": the engine's verdict was saved with the fit. "skipped": no new content, or the engine didn't answer. */
      evaluation: "stored" | "skipped";
      /** Why the evaluation was skipped, when the engine failed. The draft is saved regardless. */
      engineError: EngineError | null;
    }
  | ({ ok: false } & Refusal);

export type SaveDraftInput = {
  /** The authenticated user. */
  authorUserId: string;
  /** The session's name: only creates the author's pilot row when it is missing; never stored on the fit. */
  authorName: string;
  /** Absent: create a new draft. Present: edit this fit (which must be the author's). */
  fitId?: string;
  title: string;
  description?: string;
  tags?: readonly string[];
  /** The hull is `fit.hull.def`. Absent on an edit: only the title, description and tags change. */
  fit?: OpenFit;
  /** The build the author's catalog came from; used for a new draft when the engine can't be asked. */
  buildSha?: string | null;
};

const UNKNOWN_BUILD = "unknown";

function dataRefusal(error: unknown): Refusal | null {
  return error instanceof FitDataError ? { reason: error.code, message: error.message } : null;
}

/**
 * Saves a draft whatever the engine says: an invalid fit is a draft the author is still working on. When
 * the engine answers, its verdict is stored with the fit; when it doesn't, the fit is stored with no
 * verdict. Editing a published fit's content needs a valid verdict (the data layer refuses otherwise), so
 * that is refused with `not_valid` while the engine is down or the new content is illegal.
 */
export async function saveDraft({ db, engine }: FitServiceDeps, input: SaveDraftInput): Promise<SaveDraftResult> {
  try {
    let evaluation: EvaluationInput | undefined;
    let engineError: EngineError | null = null;
    if (input.fit) {
      const result = await engine.evaluate(input.fit);
      if (result.ok) evaluation = toEvaluationInput(result.value);
      else engineError = result.error;
    }
    const content = input.fit ? { hullItem: input.fit.hull.def, fit: input.fit } : undefined;

    const fit = input.fitId
      ? await updateFit(db, {
          id: input.fitId,
          authorUserId: input.authorUserId,
          title: input.title,
          description: input.description,
          tags: input.tags,
          content,
          evaluation,
        })
      : await createFit(db, {
          authorUserId: input.authorUserId,
          authorName: input.authorName,
          title: input.title,
          description: input.description,
          tags: input.tags,
          content: content ?? invalid("A new fit needs its loadout."),
          buildSha: evaluation?.buildSha ?? input.buildSha ?? UNKNOWN_BUILD,
          evaluation,
        });
    return { ok: true, fit, evaluation: evaluation ? "stored" : "skipped", engineError };
  } catch (error) {
    const refusal = dataRefusal(error);
    if (refusal) return { ok: false, ...refusal };
    throw error;
  }
}

function invalid(message: string): never {
  throw new FitDataError("invalid", message);
}

export type PublishResult = { ok: true; fit: FitDetail } | ({ ok: false } & Refusal);

/**
 * Publishes the author's fit, but only on the engine's say-so: the stored fit is evaluated now, against
 * the engine's current build, and published only if it is valid. If the engine can't answer, nothing
 * changes and the refusal says so (`reason: "engine"`). If it answers "invalid", the verdict is stored
 * (so the page can show the issues) and the refusal carries them.
 */
export async function publish({ db, engine }: FitServiceDeps, input: { fitId: string; authorUserId: string }): Promise<PublishResult> {
  try {
    const current = await getFit(db, input.fitId, { viewer: { userId: input.authorUserId, isAdmin: false } });
    if (!current) return { ok: false, reason: "not_found", message: "No such fit." };
    if (current.authorUserId !== input.authorUserId || current.status === "hidden") {
      return { ok: false, reason: "forbidden", message: "You can't publish this fit." };
    }
    // Content and revision read together: if the author edits while the engine thinks, the verdict is dropped.
    const stored = await getFitForEvaluation(db, input.fitId);
    if (!stored) return { ok: false, reason: "not_found", message: "No such fit." };

    const result = await engine.evaluate(stored.fit as OpenFit);
    if (!result.ok) return { ok: false, reason: "engine", message: engineRefusal(result.error), engineError: result.error };

    const evaluation = toEvaluationInput(result.value);
    const recorded = await recordEvaluation(db, input.fitId, evaluation, { revision: stored.revision });
    if (!recorded) {
      return { ok: false, reason: "not_valid", message: "This fit changed while it was being checked. Publish it again." };
    }
    if (!evaluation.valid) {
      return {
        ok: false,
        reason: "invalid_fit",
        message: "This fit doesn't pass validation, so it can't be published.",
        issues: result.value.issues,
      };
    }
    const fit = await publishFit(db, { id: input.fitId, authorUserId: input.authorUserId, buildSha: evaluation.buildSha });
    return { ok: true, fit };
  } catch (error) {
    const refusal = dataRefusal(error);
    if (refusal) return { ok: false, ...refusal };
    throw error;
  }
}

function engineRefusal(error: EngineError): string {
  return error.kind === "rejected" ? `The engine couldn't read this fit: ${error.message}` : ENGINE_DOWN_MESSAGE;
}

export type ReevaluateResult =
  | {
      ok: true;
      evaluation: EvaluationInput;
      /** False when the fit was edited (or removed) while the engine was thinking; nothing was stored. */
      recorded: boolean;
    }
  | ({ ok: false } & Refusal);

/**
 * Evaluates a stored fit against the engine's current build and stores the verdict, valid or not. For the
 * re-evaluation job and for admins: it doesn't check ownership, so callers must authorise it themselves.
 */
export async function reevaluate({ db, engine }: FitServiceDeps, fitId: string): Promise<ReevaluateResult> {
  const stored = await getFitForEvaluation(db, fitId);
  if (!stored) return { ok: false, reason: "not_found", message: "No such fit." };
  const result = await engine.evaluate(stored.fit as OpenFit);
  if (!result.ok) return { ok: false, reason: "engine", message: engineRefusal(result.error), engineError: result.error };
  const evaluation = toEvaluationInput(result.value);
  const recorded = await recordEvaluation(db, fitId, evaluation, { revision: stored.revision });
  return { ok: true, evaluation, recorded };
}
