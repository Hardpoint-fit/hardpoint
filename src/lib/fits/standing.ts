// Where a fit stands on the engine's current build, from the verdicts stored for it. The engine is the
// only judge; this only reads what it said. Pure.
import type { ConduitLink, EvaluationIssue, ModifierGroup, RegaliaGroup, SpecSection, StatLine } from "../engine/types";
import type { Evaluation, FitSummary } from "./queries";

export type Standing =
  /** Valid on the current build. */
  | "current"
  /** It failed on the current build after passing on an earlier one: a patch broke it. */
  | "outdated"
  /** It failed on the current build and never passed (only drafts can be here). */
  | "invalid"
  /** The current build hasn't checked it yet; the re-evaluation job will. */
  | "pending"
  /** The engine's build isn't known (it has never answered), so nothing can be called current. */
  | "unknown";

export function standingOf(fit: Pick<FitSummary, "evaluation" | "lastValidEvaluation">, currentSha: string | null): Standing {
  if (currentSha === null) return "unknown";
  const verdict = fit.evaluation?.buildSha === currentSha ? fit.evaluation : null;
  if (verdict === null) return "pending";
  if (verdict.valid) return "current";
  return fit.lastValidEvaluation ? "outdated" : "invalid";
}

/**
 * What `fit_evaluations.stats` holds (service.ts StoredStats); older or odd rows read as empty. `sections`
 * is null for a row stored before the engine sent hull specs, `modifierGroups` for one stored before it
 * sent modifier groups: the next check fills them in. Until then the page lists `stats`, a line per stage.
 */
export type StoredResult = {
  stats: StatLine[];
  conduits: ConduitLink[];
  regaliaSets: RegaliaGroup[];
  sections: SpecSection[] | null;
  modifierGroups: ModifierGroup[] | null;
};

export function storedResult(evaluation: Evaluation | null): StoredResult {
  const stats = evaluation?.stats as Partial<StoredResult> | null | undefined;
  return {
    stats: Array.isArray(stats?.stats) ? stats.stats : [],
    conduits: Array.isArray(stats?.conduits) ? stats.conduits : [],
    regaliaSets: Array.isArray(stats?.regaliaSets) ? stats.regaliaSets : [],
    sections: Array.isArray(stats?.sections) ? stats.sections : null,
    modifierGroups: Array.isArray(stats?.modifierGroups) ? stats.modifierGroups : null,
  };
}

export function storedIssues(evaluation: Evaluation | null): EvaluationIssue[] {
  return Array.isArray(evaluation?.issues) ? (evaluation.issues as EvaluationIssue[]) : [];
}

/**
 * What a fit page shows. Stats, conduits and regalia come from the current verdict when it is valid,
 * otherwise from the last valid one, kept for reference. Issue markers come from the current verdict.
 */
export type Shown = {
  standing: Standing;
  /** The verdict the stats are from, or null when the fit never passed. */
  reference: Evaluation | null;
  /** True when `reference` is an older build's verdict, not the current one. */
  referenceIsOld: boolean;
  result: StoredResult;
  issues: EvaluationIssue[];
};

export function shownEvaluation(fit: Pick<FitSummary, "evaluation" | "lastValidEvaluation">, currentSha: string | null): Shown {
  const standing = standingOf(fit, currentSha);
  const current = currentSha !== null && fit.evaluation?.buildSha === currentSha ? fit.evaluation : null;
  const reference = current?.valid ? current : fit.lastValidEvaluation;
  return {
    standing,
    reference,
    referenceIsOld: reference !== null && reference.buildSha !== currentSha,
    result: storedResult(reference),
    issues: current && !current.valid ? storedIssues(current) : [],
  };
}
