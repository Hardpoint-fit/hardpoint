// Applies schema.sql. Run before the server starts:  node src/lib/fits/migrate.mjs
// Idempotent, and safe when several containers start at once: the whole apply runs in one transaction
// that first takes a transaction-scoped advisory lock, so the others wait and then find nothing to do.
// Every lock after that one waits at most 5 s (lock_timeout, local to the transaction): a migration stuck
// behind a long-running query fails the start, and the platform keeps the running site, instead of the
// statement queueing every later reader and writer of that table behind it.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Arbitrary, fixed, and unique to this app's schema.
const LOCK_KEY = 7_343_201_901;

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

/** @param {{ exec(sql: string): Promise<unknown> }} target  anything that runs a multi-statement script */
export async function applySchema(target) {
  const schema = await readFile(schemaPath, "utf8");
  await target.exec(`BEGIN;\nSELECT pg_advisory_xact_lock(${LOCK_KEY});\nSET LOCAL lock_timeout = '5s';\n${schema}\nCOMMIT;`);
}

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.log("migrate: DATABASE_URL is not set; skipping (the site runs read-only without a database)");
    return;
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    try {
      await applySchema({ exec: (sql) => client.query(sql) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    console.log("migrate: schema is up to date");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error("migrate failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
