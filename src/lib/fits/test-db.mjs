// A throwaway in-process Postgres (pglite) with the real schema applied, shaped like db.ts's Db.
import { PGlite } from "@electric-sql/pglite";
import { applySchema } from "./migrate.mjs";

export async function createTestDb() {
  const pglite = await PGlite.create();
  await applySchema(pglite);
  const db = {
    query: (text, params) => pglite.query(text, params ? [...params] : undefined),
    transaction: (work) => pglite.transaction((tx) => work({ query: (text, params) => tx.query(text, params ? [...params] : undefined) })),
    exec: (sql) => pglite.exec(sql),
    close: () => pglite.close(),
  };
  return db;
}

let counter = 0;
/** A minimal valid open fit for a hull. */
export function sampleFit(hullItem = "1000") {
  counter += 1;
  return { hullItem, fit: { Version: 1, Hull: hullItem, Modules: [], Nonce: counter } };
}
