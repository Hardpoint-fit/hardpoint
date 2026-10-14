// MODIFY GRID: the builder's side of the game's grid consumables (BROKKR SLOT, the converters, SKULD).
// Which cells a consumable takes and what it makes of them is the engine's answer (POST /v1/grid-mods,
// the game's FittingGridConsumableRules); nothing here judges a cell. This file writes a chosen result
// into the fit's slot overrides, words the answer for the panel, and asks the engine again as the fit
// changes. Pure, apart from the fetcher's injectable timers.
import type { EngineResult } from "#/lib/engine/client";
import type { CatalogGridConsumable, GridModBudget, GridModResult, GridModsResponse, GridModTarget, OpenFit, OpenSlotOverride } from "#/lib/engine/types";
import { fitKey, type Timers } from "./live-evaluation";

/**
 * The slot overrides with `cell` set to `slotType`, listed by cell as the engine reads them. A cell set back
 * to its layout type has no override. The same array when nothing changes, or when `cell` is off the grid.
 */
export function withCellSlot(layout: readonly string[], overrides: readonly OpenSlotOverride[], cell: number, slotType: string): OpenSlotOverride[] {
  if (!Number.isInteger(cell) || cell < 0 || cell >= layout.length) return overrides as OpenSlotOverride[];
  const current = overrides.find((entry) => entry.cell === cell)?.slotType ?? layout[cell];
  if (current === slotType) return overrides as OpenSlotOverride[];
  const others = overrides.filter((entry) => entry.cell !== cell);
  const next = layout[cell] === slotType ? others : [...others, { cell, slotType }];
  return next.sort((a, b) => a.cell - b.cell);
}

/** A grid consumable's place in the panel. */
export type GridModKind = "extender" | "converter" | "skuld";

export function kindOf(consumable: CatalogGridConsumable): GridModKind {
  if (consumable.kind === "FittingGridExtender") return "extender";
  return consumable.behavior === "RandomCorrupt" ? "skuld" : "converter";
}

/** What a consumable has left under the game's caps, as the panel words it. */
export function budgetNote(consumable: CatalogGridConsumable, budget: GridModBudget): string {
  switch (kindOf(consumable)) {
    case "extender": {
      const left = Math.max(0, budget.maxExpansions - budget.expansions);
      return `${left} OF ${budget.maxExpansions} LEFT`;
    }
    case "converter":
      return consumable.fixedTargetSlotType && budget.convertersSpent.includes(consumable.fixedTargetSlotType) ? "SPENT" : "1 OF 1 LEFT";
    case "skuld":
      return "NO LIMIT";
  }
}

/** What the consumable does, in a line. */
export function effectNote(consumable: CatalogGridConsumable): string {
  switch (kindOf(consumable)) {
    case "extender":
      return "ADDS A CORE SLOT BESIDE THE GRID";
    case "converter":
      return `TURNS A CORE SLOT INTO A ${(consumable.fixedTargetSlotType ?? "").toUpperCase()} HARDPOINT`;
    case "skuld":
      return "RETYPES OR DESTROYS A HARDPOINT, OR ADDS A CORE SLOT BESIDE IT";
  }
}

/** The targets of one consumable in the answer, by cell. */
export function targetsOf(answer: GridModsResponse | null, def: string): Map<number, GridModTarget> {
  const option = answer?.consumables.find((entry) => entry.def === def);
  return new Map((option?.targets ?? []).map((target) => [target.cell, target]));
}

const SIDES: Record<string, string> = { "-1,0": "ABOVE", "1,0": "BELOW", "0,-1": "TO THE LEFT", "0,1": "TO THE RIGHT" };

/** A result as a choice: what it leaves on the target, or the Core it adds beside it. */
export function resultLabel(result: GridModResult, target: number, cols: number): string {
  if (result.cell !== target) {
    const side = SIDES[`${Math.floor(result.cell / cols) - Math.floor(target / cols)},${(result.cell % cols) - (target % cols)}`];
    return `ADD A ${result.slotType.toUpperCase()} SLOT ${side ?? "BESIDE IT"}`;
  }
  return result.slotType === "None" ? "DESTROY THE HARDPOINT" : `RETYPE TO ${result.slotType.toUpperCase()}`;
}

export type GridModsState =
  /** Nothing asked, or MODIFY GRID is closed. */
  | { status: "idle" }
  /** Asking about the fit with this key; `answer` is the last one, which may be an earlier fit's. */
  | { status: "loading"; key: string; answer: { key: string; response: GridModsResponse } | null }
  | { status: "ready"; key: string; answer: { key: string; response: GridModsResponse } }
  | { status: "error"; key: string; message: string; answer: { key: string; response: GridModsResponse } | null };

export const GRID_MODS_DELAY_MS = 200;

export type GridModsFetcher = {
  /** Asks about this fit after the delay, dropping any question still out; null stops asking. */
  request(fit: OpenFit | null): void;
  dispose(): void;
};

/**
 * Asks the engine what the grid consumables can do to the fit: when MODIFY GRID opens and after each change
 * to the fit, debounced, latest-wins. An answer counts only for the fit it was asked about (its key).
 */
export function createGridModsFetcher(options: {
  ask: (fit: OpenFit, signal: AbortSignal) => Promise<EngineResult<GridModsResponse>>;
  onChange: (state: GridModsState) => void;
  delayMs?: number;
  timers?: Timers;
}): GridModsFetcher {
  const delay = options.delayMs ?? GRID_MODS_DELAY_MS;
  const timers: Timers = options.timers ?? { setTimeout: (run, ms) => globalThis.setTimeout(run, ms), clearTimeout: (handle) => globalThis.clearTimeout(handle as never) };
  let state: GridModsState = { status: "idle" };
  let timer: unknown = null;
  let inFlight: AbortController | null = null;
  let disposed = false;

  const set = (next: GridModsState) => {
    state = next;
    if (!disposed) options.onChange(next);
  };
  const lastAnswer = () => (state.status === "idle" ? null : state.answer);
  const stop = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    inFlight?.abort();
    inFlight = null;
  };

  return {
    request(fit) {
      stop();
      if (fit === null) return set({ status: "idle" });
      const key = fitKey(fit);
      const answer = lastAnswer();
      if (answer?.key === key) return set({ status: "ready", key, answer });
      set({ status: "loading", key, answer });
      timer = timers.setTimeout(async () => {
        timer = null;
        const controller = new AbortController();
        inFlight = controller;
        const result = await options.ask(fit, controller.signal);
        if (inFlight !== controller || disposed) return;
        inFlight = null;
        if (result.ok) set({ status: "ready", key, answer: { key, response: result.value } });
        else if (result.error.kind !== "cancelled") set({ status: "error", key, message: result.error.message, answer: lastAnswer() });
      }, delay);
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}

/** The answer when it is the current fit's; otherwise null, so no stale cell is offered. */
export function currentAnswer(state: GridModsState, fit: OpenFit | null): GridModsResponse | null {
  if (!fit || state.status === "idle" || !state.answer) return null;
  return state.answer.key === fitKey(fit) ? state.answer.response : null;
}
