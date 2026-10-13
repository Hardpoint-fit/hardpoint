// Live evaluation, single-flight and latest-wins. A change waits 150 ms for the next one, then goes to
// the engine. While that request is out, newer changes don't cancel it; only the newest fit is kept and
// sent once the answer arrives, so a player editing quickly makes one request at a time. When the
// engine is down, or limits the checks (429), the state says which, and the newest fit is retried on
// its own: after Retry-After when the engine gave one, otherwise in 5 s. Editing never waits on any of
// it. Framework-free, with injectable timers, so it is unit-tested.
import type { EngineResult } from "#/lib/engine/client";
import type { EvaluationResponse, OpenFit } from "#/lib/engine/types";

export const EVALUATION_DELAY_MS = 150;
/** How long to wait before asking again when the engine didn't say (down, or a 429 without Retry-After). */
export const RETRY_MS = 5_000;

export type Evaluated = { key: string; response: EvaluationResponse };

/** Why checks are on hold: the engine can't be reached, or it asked the builder to slow down. */
export type Outage = "down" | "limited";

export type LiveEvaluation = {
  /**
   * idle: nothing asked yet. waiting: a change is in its 150 ms. checking: the engine is answering
   * (newer changes queue behind it). ready: `result` is the current fit's. down / paused: the engine
   * is down / rate limited, and a retry is scheduled. rejected: the engine can't read the fit.
   */
  status: "idle" | "waiting" | "checking" | "ready" | "down" | "paused" | "rejected";
  /** The last answer, which may be for an earlier fit: compare `result.key` with `fitKey(fit)`. */
  result: Evaluated | null;
  /** Why the last request failed (down, paused, rejected). */
  message: string | null;
  /** Set when the last answer was an outage; stays set while its retry waits or runs. */
  outage: Outage | null;
};

export const IDLE: LiveEvaluation = { status: "idle", result: null, message: null, outage: null };

/** A fit's identity for evaluation: its JSON. */
export const fitKey = (fit: OpenFit): string => JSON.stringify(fit);

export type Timers = {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type LiveEvaluator = {
  /** Schedules an evaluation of this fit (null: nothing to evaluate). */
  request(fit: OpenFit | null): void;
  current(): LiveEvaluation;
  dispose(): void;
};

export function createLiveEvaluator(options: {
  evaluate: (fit: OpenFit, signal: AbortSignal) => Promise<EngineResult<EvaluationResponse>>;
  onChange: (state: LiveEvaluation) => void;
  delayMs?: number;
  retryMs?: number;
  timers?: Timers;
}): LiveEvaluator {
  const delay = options.delayMs ?? EVALUATION_DELAY_MS;
  const retryDefault = options.retryMs ?? RETRY_MS;
  const timers: Timers = options.timers ?? { setTimeout: (run, ms) => globalThis.setTimeout(run, ms), clearTimeout: (handle) => globalThis.clearTimeout(handle as never) };
  let state: LiveEvaluation = IDLE;
  /** The newest fit not yet sent. */
  let latest: { fit: OpenFit; key: string } | null = null;
  let inFlight: AbortController | null = null;
  let timer: { handle: unknown; kind: "debounce" | "retry" } | null = null;
  let disposed = false;

  const set = (next: LiveEvaluation) => {
    state = next;
    if (!disposed) options.onChange(next);
  };
  const clearTimer = () => {
    if (timer) timers.clearTimeout(timer.handle);
    timer = null;
  };
  const schedule = (kind: "debounce" | "retry", ms: number) => {
    clearTimer();
    timer = { kind, handle: timers.setTimeout(() => void send(), ms) };
  };

  async function send() {
    timer = null;
    if (!latest || disposed) return;
    const { fit, key } = latest;
    latest = null;
    const controller = new AbortController();
    inFlight = controller;
    set({ ...state, status: "checking" });
    const answer = await options.evaluate(fit, controller.signal);
    if (inFlight !== controller || disposed) return;
    inFlight = null;
    if (answer.ok || answer.error.kind === "rejected") {
      const next: LiveEvaluation = answer.ok
        ? { status: "ready", result: { key, response: answer.value }, message: null, outage: null }
        : { status: "rejected", result: state.result, message: answer.error.message, outage: null };
      if (latest) {
        set({ ...next, status: "checking" });
        void send(); // the newest change, queued behind this answer
      } else set(next);
      return;
    }
    if (answer.error.kind === "cancelled") return;
    latest ??= { fit, key }; // retry this fit unless a newer one is waiting
    const limited = answer.error.kind === "rateLimited";
    set({ status: limited ? "paused" : "down", result: state.result, message: answer.error.message, outage: limited ? "limited" : "down" });
    schedule("retry", limited ? (answer.error.retryAfterMs ?? retryDefault) : retryDefault);
  }

  return {
    request(fit) {
      if (fit === null) {
        clearTimer();
        inFlight?.abort();
        inFlight = null;
        latest = null;
        set(IDLE);
        return;
      }
      const key = fitKey(fit);
      if (!inFlight && state.outage === null && state.result?.key === key) {
        clearTimer();
        latest = null;
        set({ ...state, status: "ready", message: null });
        return;
      }
      latest = { fit, key };
      if (inFlight) return; // sent when the answer in flight arrives
      if (timer?.kind === "retry") return; // the scheduled retry sends the newest fit
      set({ ...state, status: "waiting" });
      schedule("debounce", delay);
    },
    current: () => state,
    dispose() {
      disposed = true;
      clearTimer();
      inFlight?.abort();
      inFlight = null;
      latest = null;
    },
  };
}
