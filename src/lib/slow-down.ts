// The words for "you're going too fast", shared by the server's write budgets and the browser's engine
// calls. Pure, so either side can import it.

/** "SLOW DOWN — TRY AGAIN IN 42 SECONDS." in whole, rounded-up units. */
export function slowDownMessage(retryAfterMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const [amount, unit] =
    seconds < 120 ? [seconds, "SECOND"] : seconds < 120 * 60 ? [Math.ceil(seconds / 60), "MINUTE"] : [Math.ceil(seconds / 3600), "HOUR"];
  return `SLOW DOWN — TRY AGAIN IN ${amount} ${unit}${amount === 1 ? "" : "S"}.`;
}
