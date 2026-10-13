import "server-only";
import { getEngine } from "../engine/server.ts";
import { getDatabase } from "./db.ts";
import type { FitServiceDeps } from "./service.ts";

/** The database and engine the fit services run on, or "unavailable" when the site has no database. */
export function getFitServiceDeps(): { status: "unavailable" } | { status: "ready"; deps: FitServiceDeps } {
  const database = getDatabase();
  return database.status === "ready" ? { status: "ready", deps: { db: database.db, engine: getEngine() } } : { status: "unavailable" };
}
