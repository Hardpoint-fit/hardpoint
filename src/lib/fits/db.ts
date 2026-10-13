import "server-only";
import pg from "pg";
import { getConfig } from "../site-config";
import { dbFromPool, type Db } from "./pool-db.ts";

export type { Db, Queryable } from "./pool-db.ts";

/**
 * The database as callers see it. With no DATABASE_URL it is "unavailable" and fit pages render their
 * unavailable state; callers must check `status` before using `db`.
 */
export type DatabaseState = { status: "unavailable" } | { status: "ready"; db: Db };

const UNAVAILABLE: DatabaseState = { status: "unavailable" };

type Cache = { url: string; state: DatabaseState };
const globals = globalThis as typeof globalThis & { __fitsDatabase?: Cache };

/** One pool per process (kept across dev reloads), created on first use from the run-time environment. */
export function getDatabase(): DatabaseState {
  const { databaseUrl } = getConfig();
  if (databaseUrl === null) return UNAVAILABLE;
  if (globals.__fitsDatabase?.url === databaseUrl) return globals.__fitsDatabase.state;

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
  // An idle client dropping must not crash the process; the next query reconnects. The message can carry
  // the host, never a query, so it is safe to log.
  pool.on("error", (error) => console.error("fits database pool error:", error.message));
  const state: DatabaseState = { status: "ready", db: dbFromPool(pool) };
  globals.__fitsDatabase = { url: databaseUrl, state };
  return state;
}
