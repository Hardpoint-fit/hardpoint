// The builder's autosave: the fit and its words in localStorage, one slot for a new fit and one per
// saved fit being edited. The key carries a format version; anything unreadable under it (old format,
// hand-edited, a full or blocked storage) is dropped, never thrown.
import { isEditableFit } from "#/lib/engine/open-fit";
import type { OpenFit } from "#/lib/engine/types";
import type { FitMeta } from "./state";

export const DRAFT_VERSION = 1;
const PREFIX = `citadel-fits:builder-draft:v${DRAFT_VERSION}:`;

export type StoredDraft = {
  fit: OpenFit;
  meta: FitMeta;
  savedAt: string;
  /** For an edit: the saved fit's updatedAt the changes were made on, so a newer save wins. */
  base: string | null;
};

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The slot a builder session autosaves to: the saved fit's id, a copy's own slot (so opening a copy
 * never touches an unsaved new fit), or "new".
 */
export function draftSlot(fitId: string | null, copiedFrom: string | null = null): string {
  return fitId ?? (copiedFrom ? `copy-${copiedFrom}` : "new");
}

export const draftKey = (slot: string) => `${PREFIX}${slot}`;

const isMeta = (value: unknown): value is FitMeta => {
  const meta = value as Partial<FitMeta> | null;
  return (
    typeof meta === "object" &&
    meta !== null &&
    typeof meta.title === "string" &&
    typeof meta.description === "string" &&
    Array.isArray(meta.tags) &&
    meta.tags.every((tag) => typeof tag === "string")
  );
};

export function readDraft(storage: DraftStorage | null, slot: string): StoredDraft | null {
  if (!storage) return null;
  const key = draftKey(slot);
  try {
    const text = storage.getItem(key);
    if (text === null) return null;
    const value = JSON.parse(text) as Partial<StoredDraft> & { version?: unknown };
    if (value?.version === DRAFT_VERSION && isEditableFit(value.fit) && isMeta(value.meta) && typeof value.savedAt === "string") {
      return { fit: value.fit, meta: value.meta, savedAt: value.savedAt, base: typeof value.base === "string" ? value.base : null };
    }
  } catch {
    // Unreadable: fall through and drop it.
  }
  try {
    storage.removeItem(key);
  } catch {}
  return null;
}

export function writeDraft(storage: DraftStorage | null, slot: string, draft: Omit<StoredDraft, "savedAt">, now = new Date()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(draftKey(slot), JSON.stringify({ version: DRAFT_VERSION, savedAt: now.toISOString(), ...draft }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(storage: DraftStorage | null, slot: string): void {
  try {
    storage?.removeItem(draftKey(slot));
  } catch {}
}

/** The browser's localStorage, or null where it is blocked. */
export function browserStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** What a session starts from: the server's start, or this browser's autosave of the same slot when newer. */
export function bootDraft(
  storage: DraftStorage | null,
  start: { fitId: string | null; copiedFrom: { id: string } | null; updatedAt: string | null },
): StoredDraft | null {
  const draft = readDraft(storage, draftSlot(start.fitId, start.copiedFrom?.id ?? null));
  return draft && (start.fitId === null || draft.base === start.updatedAt) ? draft : null;
}

/** Keeps the slot in step with the session: the fit while it has unsaved changes, nothing otherwise. */
export function autosave(storage: DraftStorage | null, slot: string, session: { fit: OpenFit | null; meta: FitMeta; dirty: boolean; base: string | null }): void {
  if (!session.fit || !session.dirty) clearDraft(storage, slot);
  else writeDraft(storage, slot, { fit: session.fit, meta: session.meta, base: session.base });
}
