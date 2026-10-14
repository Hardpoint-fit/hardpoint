// Whether the game data API answers right now, and which build it serves. Pages ask once per render;
// the answer is held for a few seconds so a busy page doesn't poll the API per request, and
// while the API is down the build it last reported stays known, so stored verdicts for that build
// still count as current.
import type { EngineClient } from "./client.ts";

export type EngineState =
  | { status: "up"; buildSha: string }
  /** `buildSha` is the build the API last reported, or null if it never answered. */
  | { status: "down"; buildSha: string | null };

export type EngineMonitor = { current(): Promise<EngineState> };

export function createEngineMonitor(
  client: Pick<EngineClient, "status">,
  options: { ttlMs?: number; now?: () => number } = {},
): EngineMonitor {
  const ttlMs = options.ttlMs ?? 5_000;
  const now = options.now ?? Date.now;
  let held: { state: EngineState; until: number } | null = null;
  let lastSha: string | null = null;
  let inFlight: Promise<EngineState> | null = null;

  async function check(): Promise<EngineState> {
    const result = await client.status();
    const state: EngineState = result.ok ? { status: "up", buildSha: result.value.build } : { status: "down", buildSha: lastSha };
    if (result.ok) lastSha = result.value.build;
    held = { state, until: now() + ttlMs };
    return state;
  }

  return {
    current() {
      if (held && now() < held.until) return Promise.resolve(held.state);
      inFlight ??= check().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
