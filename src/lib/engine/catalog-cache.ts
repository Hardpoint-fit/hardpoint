// The server's in-memory copy of the engine catalog. The catalog is ~800 KB and changes only when the
// engine's build does, so it is fetched once and revalidated with its ETag (the build sha) at most every
// `recheckMs`. A failed revalidation keeps serving the copy we have: the catalog doesn't go bad when the
// engine blips.

import type { EngineClient, EngineResult } from "./client.ts";
import type { Catalog } from "./types.ts";

export type CatalogCacheOptions = {
  /** How long a catalog is trusted before the next request revalidates it. */
  recheckMs?: number;
  /** How long to wait after a failed revalidation before trying again. */
  retryMs?: number;
  now?: () => number;
};

export type CatalogCache = {
  /** The catalog for the engine's current build, fetched or revalidated as needed. */
  get(): Promise<EngineResult<Catalog>>;
  /** What is held right now, without any request. */
  peek(): Catalog | null;
  /** The engine's ETag for what is held (null before the first fetch, or when the engine sent none). */
  etag(): string | null;
};

type Held = { catalog: Catalog; etag: string | null; nextCheckAt: number };

export function createCatalogCache(client: Pick<EngineClient, "catalog">, options: CatalogCacheOptions = {}): CatalogCache {
  const recheckMs = options.recheckMs ?? 60_000;
  const retryMs = options.retryMs ?? 10_000;
  const now = options.now ?? Date.now;
  let held: Held | null = null;
  let inFlight: Promise<EngineResult<Catalog>> | null = null;

  async function refresh(): Promise<EngineResult<Catalog>> {
    // The catalog is the same only if the engine says so by its tag: the same build can carry new content.
    const result = await client.catalog({ ifNoneMatch: held?.etag ?? null });
    if (!result.ok) {
      if (held) {
        held.nextCheckAt = now() + retryMs;
        return { ok: true, value: held.catalog };
      }
      return result;
    }
    if (result.value.status === "notModified") {
      // Only asked with an etag, so something is held.
      if (!held) return { ok: false, error: { kind: "unavailable", message: "The loadout engine sent an unexpected answer." } };
      held.nextCheckAt = now() + recheckMs;
      return { ok: true, value: held.catalog };
    }
    const { catalog, etag } = result.value;
    held = { catalog, etag, nextCheckAt: now() + recheckMs };
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
