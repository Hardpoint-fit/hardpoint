// The server's in-memory copy of the catalog. The catalog is ~800 KB and changes only when the API's
// content does, so it is fetched once and revalidated by its parts' ETags at most every `recheckMs`.
// A failed revalidation keeps serving the copy we have: the catalog doesn't go bad when the API blips.

import type { CatalogParts, EngineClient, EngineResult } from "./client.ts";
import type { Catalog } from "./types.ts";

export type CatalogCacheOptions = {
  /** How long a catalog is trusted before the next request revalidates it. */
  recheckMs?: number;
  /** How long to wait after a failed revalidation before trying again. */
  retryMs?: number;
  now?: () => number;
};

export type CatalogCache = {
  /** The catalog for the API's current build, fetched or revalidated as needed. */
  get(): Promise<EngineResult<Catalog>>;
  /** What is held right now, without any request. */
  peek(): Catalog | null;
  /** The ETag for what is held, derived from the API's tags for its parts (null before the first fetch, or when a part came without one). */
  etag(): string | null;
};

type Held = { catalog: Catalog; etag: string | null; parts: CatalogParts; nextCheckAt: number };

export function createCatalogCache(client: Pick<EngineClient, "catalog">, options: CatalogCacheOptions = {}): CatalogCache {
  const recheckMs = options.recheckMs ?? 60_000;
  const retryMs = options.retryMs ?? 10_000;
  const now = options.now ?? Date.now;
  let held: Held | null = null;
  let inFlight: Promise<EngineResult<Catalog>> | null = null;

  async function refresh(): Promise<EngineResult<Catalog>> {
    // The catalog is the same only if the API says so by its tags: the same build can carry new content.
    const result = await client.catalog({ held });
    if (!result.ok) {
      if (held) {
        held.nextCheckAt = now() + retryMs;
        return { ok: true, value: held.catalog };
      }
      return result;
    }
    if (result.value.status === "notModified") {
      // Only asked with an etag, so something is held.
      if (!held) return { ok: false, error: { kind: "unavailable", message: "The game data API sent an unexpected answer." } };
      held.nextCheckAt = now() + recheckMs;
      return { ok: true, value: held.catalog };
    }
    const { catalog, etag, parts } = result.value;
    held = { catalog, etag, parts, nextCheckAt: now() + recheckMs };
    return { ok: true, value: catalog };
  }

  return {
    get() {
      if (held && now() < held.nextCheckAt) return Promise.resolve({ ok: true, value: held.catalog });
      // Concurrent callers share one request.
      inFlight ??= refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    peek: () => held?.catalog ?? null,
    etag: () => held?.etag ?? null,
  };
}
