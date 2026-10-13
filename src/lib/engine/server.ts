import "server-only";
import { getConfig } from "../site-config";
import { createCatalogCache, type CatalogCache } from "./catalog-cache.ts";
import { createEngineClient, type EngineClient } from "./client.ts";
import { createEngineMonitor, type EngineMonitor } from "./engine-state.ts";

type Held = { url: string | null; client: EngineClient; catalog: CatalogCache; monitor: EngineMonitor };
const globals = globalThis as typeof globalThis & { __engineServer?: Held };

function held(): Held {
  const url = getConfig().engineInternalUrl;
  if (globals.__engineServer?.url === url) return globals.__engineServer;
  const client = createEngineClient({ baseUrl: url });
  // Pages wait on the health check, so it gives up sooner than the client's default.
  const health = createEngineClient({ baseUrl: url, timeouts: { healthMs: 1_500 } });
  return (globals.__engineServer = { url, client, catalog: createCatalogCache(client), monitor: createEngineMonitor(health) });
}

/** The engine as the server reaches it (the internal URL), created from the run-time environment. */
export function getEngine(): EngineClient {
  return held().client;
}

/** The engine catalog, kept in memory across requests and revalidated against the engine's build. */
export function getServerCatalog(): CatalogCache {
  return held().catalog;
}

/** Whether the engine answers and which build it serves, held for a few seconds across requests. */
export function getEngineMonitor(): EngineMonitor {
  return held().monitor;
}
