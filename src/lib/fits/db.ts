import "server-only";
import pg from "pg";
import { getConfig } from "../site-config";

/** What queries.ts needs from a database. A pg client, a pool adapter and a pglite instance all fit. */
export type Queryable = {
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
};

export type Db = Queryable & {
  /** Runs `work` in one transaction: committed when it resolves, rolled back when it throws. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
};

/**
 * The database as callers see it. With no DATABASE_URL it is "unavailable" and fit pages render their
 * unavailable state; callers must check `status` before using `db`.
 */
export type DatabaseState = { status: "unavailable" } | { status: "ready"; db: Db };

const UNAVAILABLE: DatabaseState = { status: "unavailable" };

export function dbFromPool(pool: pg.Pool): Db {
  return {
    query: (text, params) => pool.query(text, params ? [...params] : undefined) as Promise<{ rows: never[] }>,
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work({
          query: (text, params) => client.query(text, params ? [...params] : undefined) as Promise<{ rows: never[] }>,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

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
