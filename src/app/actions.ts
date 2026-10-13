"use server";

// The site's server actions. Each checks the shape of what the browser sent, then runs the matching
// actions-core function, which authenticates before it writes; a refusal comes back as a value the
// control shows. Nothing here logs what was sent.
import { revalidatePath } from "next/cache";
import * as core from "#/lib/site/actions-core";
import { actionDeps, pageViewer } from "#/lib/site/server";

type Refusal = core.ActionRefusal;

const BAD_INPUT: Refusal = { ok: false, reason: "invalid", status: 400, message: "That request isn't valid." };
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const isId = (value: unknown): value is string => text(value, 40) && /^[A-Za-z0-9]+$/.test(value);
const isKind = (value: unknown): value is "fit" | "comment" => value === "fit" || value === "comment";

export async function voteAction(fitId: unknown, voted: unknown): Promise<core.ActionResult<{ voted: boolean; votes: number }>> {
  if (!isId(fitId) || typeof voted !== "boolean") return BAD_INPUT;
  const result = await core.vote(actionDeps(), { fitId, voted });
  if (result.ok) revalidatePath(`/fits/${fitId}`);
  return result;
}

export async function addCommentAction(fitId: unknown, parentId: unknown, body: unknown): Promise<core.ActionResult<{ comment: { id: string } }>> {
  if (!isId(fitId) || (parentId !== null && !isId(parentId)) || !text(body, 20_000)) return BAD_INPUT;
  const result = await core.addComment(actionDeps(), { fitId, parentId, body });
  if (!result.ok) return result;
  revalidatePath(`/fits/${fitId}`);
  return { ok: true, comment: { id: result.comment.id } };
}

export async function editCommentAction(fitId: unknown, id: unknown, body: unknown): Promise<core.ActionResult> {
  if (!isId(fitId) || !isId(id) || !text(body, 20_000)) return BAD_INPUT;
  const result = await core.editComment(actionDeps(), { id, body });
  if (!result.ok) return result;
  revalidatePath(`/fits/${fitId}`);
  return { ok: true };
}

export async function reportAction(targetKind: unknown, targetId: unknown, reason: unknown): Promise<core.ActionResult<{ created: boolean }>> {
  if (!isKind(targetKind) || !isId(targetId) || !text(reason, 5_000)) return BAD_INPUT;
  return core.report(actionDeps(), { targetKind, targetId, reason });
}

export async function moderateAction(targetKind: unknown, targetId: unknown, hidden: unknown): Promise<core.ActionResult<{ changed: boolean; resolved: number }>> {
  if (!isKind(targetKind) || !isId(targetId) || typeof hidden !== "boolean") return BAD_INPUT;
  const result = await core.moderate(actionDeps(), { targetKind, targetId, hidden });
  if (result.ok) revalidatePath("/admin/reports");
  return result;
}

export async function resolveReportAction(reportId: unknown): Promise<core.ActionResult<{ resolved: boolean }>> {
  if (!isId(reportId)) return BAD_INPUT;
  const result = await core.resolveReport(actionDeps(), { reportId });
  if (result.ok) revalidatePath("/admin/reports");
  return result;
}

/** Needs no sign-in: anyone who can see the fit can take it to the game. */
export async function copyFitStringAction(fitId: unknown): Promise<core.ActionResult<{ fitString: string }>> {
  if (!isId(fitId)) return BAD_INPUT;
  const viewer = await pageViewer();
  return core.copyFitString(actionDeps(), { fitId, viewer });
}
