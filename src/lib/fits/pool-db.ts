import type pg from "pg";

// The pieces of the database layer that need neither Next nor the site config, so the re-evaluation job
// can use them outside the server.

/** What queries.ts needs from a database. A pg client, a pool adapter and a pglite instance all fit. */
export type Queryable = {
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
};

export type Db = Queryable & {
  /** Runs `work` in one transaction: committed when it resolves, rolled back when it throws. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
};

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
