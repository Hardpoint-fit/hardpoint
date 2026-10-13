import "server-only";
import { currentAuthor, isAdmin, requireAdmin, requireAuthor } from "../auth";
import { getEngine, getEngineMonitor, getServerCatalog } from "../engine/server";
import { getDatabase } from "../fits/db";
import type { Viewer } from "../fits/queries";
import { getConfig } from "../site-config";
import type { ActionDeps } from "./actions-core";
import type { SiteDeps } from "./loaders";

/** The real dependencies of the page loaders. */
export function siteDeps(): SiteDeps {
  return { database: getDatabase, engine: getEngineMonitor(), catalog: getServerCatalog() };
}

/** The real dependencies of the server actions. */
export function actionDeps(): ActionDeps {
  return { database: getDatabase, auth: { requireAuthor, requireAdmin }, engine: getEngine(), currentBuild: () => getServerCatalog().peek()?.buildSha ?? null };
}

/** Who is reading this page. Never throws: Clerk trouble reads as signed out. */
export type PageViewer = Viewer & { name: string | null; authEnabled: boolean };

export async function pageViewer(): Promise<PageViewer> {
  const { authEnabled } = getConfig();
  const author = await currentAuthor();
  return {
    userId: author?.userId ?? null,
    name: author?.name ?? null,
    isAdmin: author ? await isAdmin(author.userId) : false,
    authEnabled,
  };
}
