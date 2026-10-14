// The item tooltip's facts for rolled items, asked of the engine (/v1/item-facts) one at a time.
//
// The catalog already carries each item's facts for its plainest roll (Standard quality, the item's
// lowest rarity, nothing rolled), so only other rolls are asked about, and the caller shows the catalog's
// rows until the answer lands. Asks wait 250 ms for the next change (a slider being dragged), then go
// one at a time, newest first; an ask nobody needs any more is released before it is sent, and
// disposing aborts the one in flight. A 429 holds every ask until Retry-After (or 5 s) has passed. A
// refusal (the engine can't produce that roll) is final for that roll; an outage isn't cached, so the
// next ask tries again. Framework-free with injectable timers, so it is unit-tested.
import type { EngineResult } from "./client";
import type { CatalogItem, FactRow, FactsBody, OpenItem } from "./types";

export const FACTS_DELAY_MS = 250;
export const FACTS_RETRY_MS = 5_000;
/** Answers kept per page; the oldest goes first. */
export const FACTS_CACHE_SIZE = 200;
/** Asks kept waiting; the oldest is dropped. */
const MAX_WAITING = 8;

/**
 * ready: `facts` is this roll's. default: the plainest roll, whose facts are the catalog's. loading: the
 * engine is being asked. refused: the engine can't produce this roll. down / limited: the engine isn't
 * answering, or asked us to slow down; the catalog's facts stand in.
 */
export type FactsStatus = "default" | "loading" | "ready" | "refused" | "down" | "limited";
export type FactsState = { status: FactsStatus; facts: readonly FactRow[] };

/** A catalog item's `facts` and the rarity they were read at: its lowest (the engine's default roll). */
export type CatalogFacts = { facts: readonly FactRow[]; rarity: string };

/** The catalog's facts for an item. Its `roll.rarities` are in ModuleRarity order, so the first is the lowest. */
export function catalogFacts(item: Pick<CatalogItem, "facts" | "roll">): CatalogFacts {
  return { facts: item.facts, rarity: item.roll.rarities[0] };
}

/**
 * The roll the catalog's `facts` describe (ItemFacts.Default): Standard quality, the item's lowest
 * rarity, nothing rolled or slotted.
 */
export function isPlainestRoll(item: OpenItem, lowestRarity: string): boolean {
  const roll = item.roll;
  return (
    roll.quality === "Standard" &&
    roll.rarity === lowestRarity &&
    roll.modifiers.length === 0 &&
    roll.ports.every((port) => port.cipher === null) &&
    roll.artifact === null &&
    roll.regalia === null &&
    roll.heretical === null &&
    roll.harmonicSet === null &&
    roll.moduleTypeOverride === null &&
    roll.scaledStat === null &&
    !roll.isHarmonized &&
    !roll.isMirrored &&
    item.patina === 0
  );
}

export const factsKey = (item: OpenItem): string => JSON.stringify(item);

export type Timers = {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type FactsLoader = {
  /** What to show for this item now, given its catalog entry's facts. Asks nothing. */
  state(item: OpenItem, catalog: CatalogFacts): FactsState;
  /** Asks for the item's facts, unless they are the catalog's or already known. */
  request(item: OpenItem, catalog: CatalogFacts): void;
  /** The asker no longer needs this item: if it hasn't been sent, it won't be. */
  release(item: OpenItem): void;
  /** Called after every change of any item's state. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

type Answer = { status: "ready"; facts: readonly FactRow[] } | { status: "refused" };

export function createFactsLoader(options: {
  fetchFacts: (item: OpenItem, signal: AbortSignal) => Promise<EngineResult<FactsBody>>;
  delayMs?: number;
  retryMs?: number;
  timers?: Timers;
}): FactsLoader {
  const delay = options.delayMs ?? FACTS_DELAY_MS;
  const retryDefault = options.retryMs ?? FACTS_RETRY_MS;
  const timers: Timers = options.timers ?? { setTimeout: (run, ms) => globalThis.setTimeout(run, ms), clearTimeout: (handle) => globalThis.clearTimeout(handle as never) };
  const answers = new Map<string, Answer>();
  /** Asks not yet sent, oldest first. */
  const waiting = new Map<string, OpenItem>();
  const listeners = new Set<() => void>();
  let inFlight: { key: string; controller: AbortController } | null = null;
  let timer: unknown = null;
  let outage: "down" | "limited" | null = null;
  /** Keys the last outage hit: they show it until asked about again. */
  const failed = new Set<string>();
  let disposed = false;

  const notify = () => {
    if (!disposed) for (const listener of [...listeners]) listener();
  };
  const remember = (key: string, answer: Answer) => {
    answers.delete(key);
    answers.set(key, answer);
    if (answers.size > FACTS_CACHE_SIZE) answers.delete(answers.keys().next().value!);
  };
  const schedule = (ms: number) => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      void send();
    }, ms);
  };

  async function send() {
    if (disposed || inFlight || waiting.size === 0) return;
    const [key, item] = [...waiting].at(-1)!;
    waiting.delete(key);
    const controller = new AbortController();
    inFlight = { key, controller };
    notify();
    const result = await options.fetchFacts(item, controller.signal);
    if (disposed || inFlight?.controller !== controller) return;
    inFlight = null;
    if (result.ok) {
      outage = null;
      failed.delete(key);
      remember(key, { status: "ready", facts: result.value.facts });
    } else if (result.error.kind === "rejected" || result.error.kind === "tooLarge") {
      outage = null;
      failed.delete(key);
      remember(key, { status: "refused" });
    } else if (result.error.kind === "rateLimited") {
      outage = "limited";
      if (!waiting.has(key)) waiting.set(key, item);
      notify();
      schedule(result.error.retryAfterMs ?? retryDefault);
      return;
    } else if (result.error.kind !== "cancelled") {
      outage = "down";
      failed.add(key);
    }
    notify();
    if (waiting.size > 0) void send();
  }

  return {
    state(item, catalog) {
      if (isPlainestRoll(item, catalog.rarity)) return { status: "default", facts: catalog.facts };
      const key = factsKey(item);
      const answer = answers.get(key);
      if (answer?.status === "ready") return { status: "ready", facts: answer.facts };
      if (answer?.status === "refused") return { status: "refused", facts: catalog.facts };
      if (outage === "limited" && waiting.has(key)) return { status: "limited", facts: catalog.facts };
      if (failed.has(key) && !waiting.has(key) && inFlight?.key !== key) return { status: "down", facts: catalog.facts };
      return { status: "loading", facts: catalog.facts };
    },
    request(item, catalog) {
      if (disposed || isPlainestRoll(item, catalog.rarity)) return;
      const key = factsKey(item);
      if (answers.has(key) || inFlight?.key === key) return;
      waiting.delete(key);
      waiting.set(key, item);
      failed.delete(key);
      if (waiting.size > MAX_WAITING) waiting.delete(waiting.keys().next().value!);
      if (outage !== "limited") schedule(delay);
      notify();
    },
    release(item) {
      if (waiting.delete(factsKey(item)) && waiting.size === 0 && timer !== null && outage !== "limited") {
        timers.clearTimeout(timer);
        timer = null;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      inFlight?.controller.abort();
      inFlight = null;
      waiting.clear();
      listeners.clear();
    },
  };
}
