// Live evaluation: each change to the fit waits 150 ms for the next one, then asks the engine; a newer
// change cancels the waiting timer and aborts the request still in flight, and a late answer to an old
// fit is dropped. Editing never waits on it: when the engine can't answer, the state says so and the
// builder keeps working. Framework-free, with injectable timers, so the debounce is unit-tested.
import type { EngineResult } from "#/lib/engine/client";
import type { EvaluationResponse, OpenFit } from "#/lib/engine/types";

export const EVALUATION_DELAY_MS = 150;

export type Evaluated = { key: string; response: EvaluationResponse };

export type LiveEvaluation = {
  /**
   * idle: nothing asked yet. waiting: a change is in its 150 ms. checking: the engine is answering.
   * ready: `result` is the current fit's. down: the engine can't be reached. rejected: it can't read the fit.
   */
  status: "idle" | "waiting" | "checking" | "ready" | "down" | "rejected";
  /** The last answer, which may be for an earlier fit: compare `result.key` with `fitKey(fit)`. */
  result: Evaluated | null;
  /** Why the last request failed (down, rejected). */
  message: string | null;
  /** The last answered request found the engine down; stays true while a retry waits or runs. */
  engineDown: boolean;
};

export const IDLE: LiveEvaluation = { status: "idle", result: null, message: null, engineDown: false };

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
  timers?: Timers;
}): LiveEvaluator {
  const delay = options.delayMs ?? EVALUATION_DELAY_MS;
  const timers: Timers = options.timers ?? { setTimeout: (run, ms) => globalThis.setTimeout(run, ms), clearTimeout: (handle) => globalThis.clearTimeout(handle as never) };
  let state: LiveEvaluation = IDLE;
  let timer: unknown = null;
  let inFlight: AbortController | null = null;
  let disposed = false;

  const set = (next: LiveEvaluation) => {
    state = next;
    if (!disposed) options.onChange(next);
  };

  const stop = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    inFlight?.abort();
    inFlight = null;
  };

  async function run(fit: OpenFit, key: string) {
    timer = null;
    const controller = new AbortController();
    inFlight = controller;
    set({ ...state, status: "checking" });
    const answer = await options.evaluate(fit, controller.signal);
    if (inFlight !== controller || disposed) return; // superseded by a newer change
    inFlight = null;
    if (answer.ok) set({ status: "ready", result: { key, response: answer.value }, message: null, engineDown: false });
    else if (answer.error.kind === "cancelled") return;
    else if (answer.error.kind === "rejected") set({ status: "rejected", result: state.result, message: answer.error.message, engineDown: false });
    else set({ status: "down", result: state.result, message: answer.error.message, engineDown: true });
  }

  return {
    request(fit) {
      stop();
      if (fit === null) {
        set(IDLE);
        return;
      }
      const key = fitKey(fit);
      if (state.result?.key === key) {
        set({ ...state, status: "ready", message: null });
        return;
      }
      set({ ...state, status: "waiting" });
      timer = timers.setTimeout(() => void run(fit, key), delay);
    },
    current: () => state,
    dispose() {
      stop();
      disposed = true;
    },
  };
}
