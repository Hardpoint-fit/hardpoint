import "server-only";
import { getConfig } from "../site-config";
import { createCatalogCache, type CatalogCache } from "./catalog-cache.ts";
import { createEngineClient, type EngineClient } from "./client.ts";
import { createEngineMonitor, type EngineMonitor } from "./engine-state.ts";

type Held = { key: string; client: EngineClient; catalog: CatalogCache; monitor: EngineMonitor };
const globals = globalThis as typeof globalThis & { __engineServer?: Held };

function held(): Held {
  const { apiUrl, apiInternalUrl } = getConfig();
  const key = `${apiInternalUrl}|${apiUrl}`;
  if (globals.__engineServer?.key === key) return globals.__engineServer;
  // The server calls the API on its internal address; the art URLs in the catalog are for browsers, so
  // they use the public one.
  const client = createEngineClient({ baseUrl: apiInternalUrl, artBaseUrl: apiUrl ?? apiInternalUrl });
  // Pages wait on the status check, so it gives up sooner than the client's default.
  const status = createEngineClient({ baseUrl: apiInternalUrl, timeouts: { statusMs: 1_500 } });
  return (globals.__engineServer = { key, client, catalog: createCatalogCache(client), monitor: createEngineMonitor(status) });
}

/** The game data API as the server reaches it (the internal URL), created from the run-time environment. */
export function getEngine(): EngineClient {
  return held().client;
}

/** The catalog, kept in memory across requests and revalidated against the API. */
export function getServerCatalog(): CatalogCache {
  return held().catalog;
}

/** Whether the API answers and which build it serves, held for a few seconds across requests. */
export function getEngineMonitor(): EngineMonitor {
  return held().monitor;
}
