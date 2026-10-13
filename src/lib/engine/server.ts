import "server-only";
import { getConfig } from "../site-config";
import { createCatalogCache, type CatalogCache } from "./catalog-cache.ts";
import { createEngineClient, type EngineClient } from "./client.ts";

type Held = { url: string | null; client: EngineClient; catalog: CatalogCache };
const globals = globalThis as typeof globalThis & { __engineServer?: Held };

function held(): Held {
  const url = getConfig().engineInternalUrl;
  if (globals.__engineServer?.url === url) return globals.__engineServer;
  const client = createEngineClient({ baseUrl: url });
  return (globals.__engineServer = { url, client, catalog: createCatalogCache(client) });
}

/** The engine as the server reaches it (the internal URL), created from the run-time environment. */
export function getEngine(): EngineClient {
  return held().client;
}

/** The engine catalog, kept in memory across requests and revalidated against the engine's build. */
export function getServerCatalog(): CatalogCache {
  return held().catalog;
}
