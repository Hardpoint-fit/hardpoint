"use server";

// The site's server actions. Each checks the shape of what the browser sent, then runs the matching
// actions-core function, which authenticates before it writes; a refusal comes back as a value the
// control shows. Nothing here logs what was sent.
import { revalidatePath } from "next/cache";
import { isEditableFit } from "#/lib/engine/open-fit";
import { FIT_JSON_MAX_BYTES } from "#/lib/fits/limits";
import * as core from "#/lib/site/actions-core";
import { actionDeps } from "#/lib/site/server";

type Refusal = core.ActionRefusal;

const BAD_INPUT: Refusal = { ok: false, reason: "invalid", status: 400, message: "That request isn't valid." };
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const isId = (value: unknown): value is string => text(value, 40) && /^[A-Za-z0-9]+$/.test(value);
const isUserId = (value: unknown): value is string => text(value, 100) && /^[A-Za-z0-9_-]+$/.test(value);
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

export async function deleteCommentAction(fitId: unknown, id: unknown): Promise<core.ActionResult> {
  if (!isId(fitId) || !isId(id)) return BAD_INPUT;
  const result = await core.deleteComment(actionDeps(), { id });
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

/** Generous bounds on what the builder sends; the data layer applies the real limits and words them. */
function isMeta(value: unknown): value is { title: string; description: string; tags: string[]; note?: string } {
  const meta = value as { title?: unknown; description?: unknown; tags?: unknown; note?: unknown } | null;
  return (
    typeof meta === "object" &&
    meta !== null &&
    text(meta.title, 1_000) &&
    text(meta.description, 40_000) &&
    (meta.note === undefined || text(meta.note, 1_000)) &&
    Array.isArray(meta.tags) &&
    meta.tags.length <= 50 &&
    meta.tags.every((tag) => text(tag, 100))
  );
}

/** The build a draft is recorded against when the engine can't check it comes from the server's catalog, not the browser. */
export async function saveFitAction(fitId: unknown, meta: unknown, fit: unknown): Promise<core.ActionResult<{ fit: core.SavedFit }>> {
  if ((fitId !== null && !isId(fitId)) || !isMeta(meta)) return BAD_INPUT;
  if (!isEditableFit(fit) || JSON.stringify(fit).length > FIT_JSON_MAX_BYTES) return BAD_INPUT;
  const result = await core.saveFit(actionDeps(), { fitId, title: meta.title, description: meta.description, tags: meta.tags, note: meta.note, fit });
  if (result.ok) revalidatePath(`/fits/${result.fit.fitId}`);
  return result;
}

export async function publishFitAction(fitId: unknown): Promise<core.ActionResult<{ fitId: string }>> {
  if (!isId(fitId)) return BAD_INPUT;
  const result = await core.publishFit(actionDeps(), { fitId });
  if (result.ok) {
    revalidatePath(`/fits/${fitId}`);
    revalidatePath("/");
  }
  return result;
}

export async function unpublishFitAction(fitId: unknown): Promise<core.ActionResult<{ fitId: string }>> {
  if (!isId(fitId)) return BAD_INPUT;
  const result = await core.unpublishFit(actionDeps(), { fitId });
  if (result.ok) {
    revalidatePath(`/fits/${fitId}`);
    revalidatePath("/");
  }
  return result;
}

/** The control navigates to the author's page on success; this only reports it. */
export async function deleteFitAction(fitId: unknown): Promise<core.ActionResult<{ fitId: string }>> {
  if (!isId(fitId)) return BAD_INPUT;
  const result = await core.deleteFit(actionDeps(), { fitId });
  if (result.ok) {
    revalidatePath(`/fits/${fitId}`);
    revalidatePath("/");
  }
  return result;
}

export async function followAction(userId: unknown, following: unknown): Promise<core.ActionResult<{ following: boolean; followers: number }>> {
  if (!isUserId(userId) || typeof following !== "boolean") return BAD_INPUT;
  const result = await core.follow(actionDeps(), { userId, following });
  if (result.ok) revalidatePath(`/u/${userId}`);
  return result;
}

export async function editBioAction(bio: unknown): Promise<core.ActionResult<{ bio: string }>> {
  if (!text(bio, 5_000)) return BAD_INPUT;
  const result = await core.editBio(actionDeps(), { bio });
  if (result.ok) revalidatePath("/u/[userId]", "page");
  return result;
}
