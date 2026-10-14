// Per-user write budgets. Every signed-in write spends from its action's budget before it runs, and a
// spent budget refuses the write until its window turns over. The counters live in Postgres
// (write_budget_windows), so every site replica and restart sees the same counts.
//
// Each budget is one or more fixed windows aligned to the epoch (a minute, an hour, a day). A write
// takes one from every window of its action in one transaction: if any is full, none is taken. A fixed
// window lets a burst of twice the limit straddle a boundary; the day window bounds what that buys.
import type { Db } from "./db.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type WriteAction = "vote" | "comment" | "report" | "fit" | "follow" | "profile" | "bookmark";

export type WriteWindow = { readonly limit: number; readonly windowMs: number };

/**
 * Comments and edits share "comment"; fit saves and publishes share "fit"; follows and unfollows share
 * "follow"; "bookmark" is bookmarking and un-bookmarking; "profile" is bio edits. Moderation has no budget.
 */
export const WRITE_BUDGETS: Readonly<Record<WriteAction, readonly WriteWindow[]>> = {
  vote: [{ limit: 60, windowMs: MINUTE }],
  comment: [
    { limit: 10, windowMs: MINUTE },
    { limit: 100, windowMs: DAY },
  ],
  report: [{ limit: 10, windowMs: HOUR }],
  fit: [{ limit: 30, windowMs: MINUTE }],
  follow: [
    { limit: 30, windowMs: MINUTE },
    { limit: 300, windowMs: DAY },
  ],
  profile: [{ limit: 10, windowMs: HOUR }],
  bookmark: [
    { limit: 60, windowMs: MINUTE },
    { limit: 1000, windowMs: DAY },
  ],
};

export type WriteBudgetResult = { ok: true } | { ok: false; retryAfterMs: number };

class BudgetSpent extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("write budget spent");
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Takes one write from each of `action`'s windows for `userId`, or none when any window is full; then
 * `retryAfterMs` is how long until the window that refused turns over. Also drops the user's
 * windows that have ended, so the table holds only live counters.
 */
export async function spendWriteBudget(
  db: Db,
  userId: string,
  action: WriteAction,
  now: Date = new Date(),
): Promise<WriteBudgetResult> {
  try {
    await db.transaction(async (tx) => {
      await tx.query(`DELETE FROM write_budget_windows WHERE user_id = $1 AND window_end <= $2`, [userId, now]);
      for (const window of WRITE_BUDGETS[action]) {
        const start = Math.floor(now.getTime() / window.windowMs) * window.windowMs;
        const end = start + window.windowMs;
        const { rows } = await tx.query(
          `INSERT INTO write_budget_windows (user_id, budget, window_start, window_end, used)
           VALUES ($1, $2, $3, $4, 1)
           ON CONFLICT (user_id, budget, window_start) DO UPDATE SET used = write_budget_windows.used + 1
             WHERE write_budget_windows.used < $5
           RETURNING used`,
          [userId, `${action}/${window.windowMs}`, new Date(start), new Date(end), window.limit],
        );
        if (rows.length === 0) throw new BudgetSpent(end - now.getTime());
      }
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof BudgetSpent) return { ok: false, retryAfterMs: error.retryAfterMs };
    throw error;
  }
}
