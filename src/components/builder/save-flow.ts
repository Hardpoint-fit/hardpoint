// Saving and publishing from the builder, apart from React so the order of steps is tested. The first
// save of a new fit moves the address to its edit page in place (history.replaceState): the builder
// stays mounted, so a publish refusal, its issues and the "SAVED." notice stay on screen.
import type { EvaluationIssue } from "#/lib/engine/types";
import type { ActionResult, SavedFit } from "#/lib/site/actions-core";

export type SavedState = { fitId: string | null; status: "draft" | "published" | "hidden" | null; updatedAt: string | null };

/** Where the builder goes: `replace` changes the address without leaving the page, `push` leaves it. */
export type Navigate = { replace(url: string): void; push(url: string): void };

export type Problem = { message: string; issues?: EvaluationIssue[] } | null;

export type FlowResult = { problem: Problem; notice: string | null };

type Steps = {
  saved: SavedState;
  dirty: boolean;
  save: (fitId: string | null) => Promise<ActionResult<{ fit: SavedFit }>>;
  publish: (fitId: string) => Promise<ActionResult<{ fitId: string }>>;
  onSaved: (saved: SavedState) => void;
  navigate: Navigate;
};

export const editPath = (fitId: string) => `/fits/${fitId}/edit`;

const savedNotice = (fit: SavedFit) =>
  fit.evaluation === "skipped" ? "SAVED. THE ENGINE COULDN'T CHECK IT; IT IS CHECKED AGAIN BEFORE PUBLISHING." : "SAVED.";

async function saveStep(steps: Steps): Promise<{ saved: SavedState; notice: string } | { problem: Problem }> {
  const result = await steps.save(steps.saved.fitId);
  if (!result.ok) return { problem: { message: result.message, issues: result.issues } };
  const next: SavedState = { fitId: result.fit.fitId, status: result.fit.status, updatedAt: result.fit.updatedAt };
  steps.onSaved(next);
  if (steps.saved.fitId === null) steps.navigate.replace(editPath(next.fitId!));
  return { saved: next, notice: savedNotice(result.fit) };
}

export async function saveFlow(steps: Omit<Steps, "publish" | "dirty">): Promise<FlowResult> {
  const result = await saveStep({ ...steps, dirty: true, publish: () => Promise.reject(new Error("not publishing")) });
  return "problem" in result ? { problem: result.problem, notice: null } : { problem: null, notice: result.notice };
}

/** Saves first when there is anything unsaved, then publishes; a refusal comes back with its issues. */
export async function publishFlow(steps: Steps): Promise<FlowResult> {
  let current = steps.saved;
  let notice: string | null = null;
  if (steps.dirty || current.fitId === null) {
    const result = await saveStep(steps);
    if ("problem" in result) return { problem: result.problem, notice: null };
    current = result.saved;
    notice = result.notice;
  }
  const published = await steps.publish(current.fitId!);
  if (!published.ok) return { problem: { message: published.message, issues: published.issues }, notice };
  steps.navigate.push(`/fits/${published.fitId}`);
  return { problem: null, notice };
}

/** The app router's push, with `replace` done in place so the builder isn't remounted. */
export function inPlaceNavigate(router: { push(url: string): void }, history: Pick<History, "replaceState">): Navigate {
  return { push: (url) => router.push(url), replace: (url) => history.replaceState(null, "", url) };
}
