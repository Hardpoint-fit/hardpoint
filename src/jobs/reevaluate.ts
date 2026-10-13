// The re-evaluation job: when the engine's build changes, every published fit needs a fresh verdict.
// Runs as a Railway cron service from the site's own image (see the README), reads the engine's build from
// /healthz, and evaluates each published fit that has no verdict for it. Safe to run any time and to run
// twice: a fit that already has a row for the build is never asked about again, and a fit edited while
// the engine was thinking keeps its old state (the revision guard in recordEvaluation).
//
// Runs under plain `node` (type stripping), so this file and what it imports stay erasable TypeScript
// with explicit .ts import paths, and import nothing from Next.
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createEngineClient, type EngineClient, type EngineError } from "../lib/engine/client.ts";
import { dbFromPool, type Db } from "../lib/fits/pool-db.ts";
import { fitsNeedingEvaluation, recordEvaluation } from "../lib/fits/queries.ts";
import { reevaluate } from "../lib/fits/service.ts";

export const BATCH_SIZE = 50;
export const MAX_IN_FLIGHT = 4;
export const MAX_RUN_MS = 10 * 60_000;
/** Rate-limit waits one run tolerates before giving the rest to the next run. */
export const MAX_RATE_LIMIT_WAITS = 5;
/** Rejections with no success this run that mean the engine, not the fits, is the problem. */
export const REJECTION_TRIP_COUNT = 5;
export const REJECTION_SAMPLE = 10;
const MAX_WAIT_MS = 60_000;
const DEFAULT_WAIT_MS = 5_000;

export type JobOptions = {
  db: Db;
  engine: Pick<EngineClient, "health" | "evaluate">;
  batchSize?: number;
  maxInFlight?: number;
  maxRunMs?: number;
  maxRateLimitWaits?: number;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

export type JobOutcome =
  /** Everything published has a verdict for the build. */
  | "done"
  /** The engine failed or limited us for too long; the next run continues. */
  | "engine"
  /** The time budget ran out; the next run continues. */
  | "time";

export type JobSummary = {
  outcome: JobOutcome;
  buildSha: string | null;
  evaluated: number;
  /** Fits edited (or removed) while the engine was thinking: their verdict was dropped on purpose. */
  superseded: number;
  /** Fits the engine refused to read: stored as invalid so they stop coming back. */
  rejected: number;
  rateLimitWaits: number;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs the job. Throws only for a failure of the database; an engine that fails ends the run quietly. */
export async function runReevaluation(options: JobOptions): Promise<JobSummary> {
  const { db, engine } = options;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
  const maxRateLimitWaits = options.maxRateLimitWaits ?? MAX_RATE_LIMIT_WAITS;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line) => console.log(line));
  const deadline = now() + (options.maxRunMs ?? MAX_RUN_MS);

  const summary: JobSummary = { outcome: "done", buildSha: null, evaluated: 0, superseded: 0, rejected: 0, rateLimitWaits: 0 };
  const stop = (outcome: JobOutcome): JobSummary => {
    summary.outcome = outcome;
    // A distinct line for the runs that exit 0 because of the engine, so they can be alerted on.
    if (outcome === "engine") log("reevaluate: engine-unavailable");
    return summary;
  };

  const health = await engine.health();
  if (!health.ok) {
    log(`reevaluate: engine not ready (${health.error.kind}); nothing done`);
    return stop("engine");
  }
  const buildSha = health.value.buildSha;
  summary.buildSha = buildSha;

  // Set when a worker meets a failure that should end the run; the others finish their current fit.
  let halted: JobOutcome | null = null;

  // Workers that hit the same 429 share one wait (and one count): an episode, not a request.
  let episode: Promise<boolean> | null = null;
  function waitForRateLimit(error: EngineError): Promise<boolean> {
    if (episode !== null) return episode;
    if (summary.rateLimitWaits >= maxRateLimitWaits) return Promise.resolve(false);
    summary.rateLimitWaits += 1;
    const wait = Math.min(error.retryAfterMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
    if (now() + wait >= deadline) return Promise.resolve(false);
    log(`reevaluate: rate limited; waiting ${wait} ms`);
    const current = sleep(wait).then(
      () => true,
      () => false,
    );
    episode = current;
    void current.then(() => {
      if (episode === current) episode = null;
    });
    return current;
  }

  // Fits the engine refused, held until the engine has shown it accepts others this run. A uniform
  // refusal means a bad request or a broken engine; storing it would mark every fit invalid for this build.
  const pending: { id: string; revision: string; message: string }[] = [];
  let attempts = 0;
  let refusals = 0;
  const tripped = () =>
    (summary.evaluated === 0 && refusals >= REJECTION_TRIP_COUNT) ||
    (attempts >= REJECTION_SAMPLE && refusals * 2 > attempts);
  async function flushRefused() {
    if (summary.evaluated === 0) return 0;
    let stored = 0;
    for (const fit of pending.splice(0)) {
      const ok = await recordEvaluation(
        db,
        fit.id,
        { buildSha, valid: false, rating: null, stats: {}, issues: [{ moduleIndex: -1, kind: "Rejected", message: fit.message }] },
        { revision: fit.revision },
      );
      if (ok) {
        summary.rejected += 1;
        stored += 1;
      } else summary.superseded += 1;
    }
    return stored;
  }

  async function one(fitId: string): Promise<"stored" | "superseded" | { rejected: string } | "halt"> {
    for (;;) {
      if (halted !== null) return "halt";
      const result = await reevaluate({ db, engine }, fitId);
      if (result.ok) return result.recorded ? "stored" : "superseded";
      if (result.reason === "not_found") return "superseded";
      if (result.reason !== "engine") return "halt";
      const { kind } = result.engineError;
      if (kind === "rateLimited") {
        if (await waitForRateLimit(result.engineError)) continue;
        halted ??= "engine";
        return "halt";
      }
      if (kind === "rejected" || kind === "tooLarge") return { rejected: result.engineError.message };
      halted ??= "engine";
      return "halt";
    }
  }

  while (halted === null) {
    if (now() >= deadline) return stop("time");
    const batch = await fitsNeedingEvaluation(db, buildSha, batchSize);
    if (batch.length === 0) break;

    let progress = 0;
    let next = 0;
    const worker = async () => {
      while (halted === null && next < batch.length && now() < deadline) {
        const fit = batch[next++];
        const outcome = await one(fit.id);
        if (outcome === "stored") {
          summary.evaluated += 1;
          attempts += 1;
          progress += 1;
        } else if (outcome === "superseded") summary.superseded += 1;
        else if (outcome !== "halt") {
          attempts += 1;
          refusals += 1;
          pending.push({ id: fit.id, revision: fit.revision, message: outcome.rejected });
          if (tripped()) halted ??= "engine";
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxInFlight, batch.length) }, worker));

    if (halted !== null) return stop(halted);
    progress += await flushRefused();
    if (now() >= deadline) return stop("time");
    // A whole batch that stored nothing (every fit edited meanwhile) would repeat forever.
    if (progress === 0) break;
  }

  return summary;
}

export function describe(summary: JobSummary): string {
  return (
    `reevaluate: ${summary.outcome}; build ${summary.buildSha ?? "unknown"}; ` +
    `evaluated ${summary.evaluated}, superseded ${summary.superseded}, rejected ${summary.rejected}, rate-limit waits ${summary.rateLimitWaits}`
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const engineUrl = (process.env.LOADOUT_ENGINE_INTERNAL_URL?.trim() || process.env.LOADOUT_ENGINE_URL?.trim() || "").replace(/\/+$/, "");
  if (!databaseUrl || !engineUrl) {
    console.error("reevaluate: DATABASE_URL and LOADOUT_ENGINE_INTERNAL_URL must both be set");
    process.exitCode = 1;
    return;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const summary = await runReevaluation({
      db: dbFromPool(pool),
      engine: createEngineClient({ baseUrl: engineUrl }),
    });
    console.log(describe(summary));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    // Database trouble. The message can name the host, never a fit.
    console.error("reevaluate failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}
