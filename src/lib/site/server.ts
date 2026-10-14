import "server-only";
import { currentAuthor, isAdmin, moderationState, requireAdmin, requireAuthor, type ModerationState } from "../auth";
import { getEngine, getEngineMonitor, getServerCatalog } from "../engine/server";
import { getDatabase } from "../fits/db";
import type { Viewer } from "../fits/queries";
import { getConfig } from "../site-config";
import type { ActionDeps } from "./actions-core";
import { viewerModeration, type SiteDeps } from "./loaders";

/** The real dependencies of the page loaders. */
export function siteDeps(): SiteDeps {
  return { database: getDatabase, engine: getEngineMonitor(), catalog: getServerCatalog() };
}

/** The real dependencies of the server actions. */
export function actionDeps(): ActionDeps {
  return { database: getDatabase, auth: { requireAuthor, requireAdmin, isAdmin }, engine: getEngine(), currentBuild: () => getServerCatalog().peek()?.buildSha ?? null };
}

/**
 * Who is reading this page. Never throws: an unreadable session reads as signed out. `isAdmin` is
 * `moderation === "active"`: what the page may read and offer; "reverify" offers only the re-verify link.
 */
export type PageViewer = Viewer & { name: string | null; authEnabled: boolean; moderation: ModerationState };

export async function pageViewer(): Promise<PageViewer> {
  const { authEnabled } = getConfig();
  const author = await currentAuthor();
  const moderation = author ? await viewerModeration(siteDeps(), author.userId, await moderationState()) : "none";
  return { userId: author?.userId ?? null, name: author?.name ?? null, isAdmin: moderation === "active", authEnabled, moderation };
}
