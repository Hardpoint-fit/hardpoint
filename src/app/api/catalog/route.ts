// The engine's catalog for the builder, from the server's cache: it is still served from the copy the
// server holds while the engine is down, so the builder keeps editing. Revalidated by build (ETag) and
// compressed (catalog-response.ts).
import { catalogResponse } from "#/lib/engine/catalog-response";
import { pageEngine } from "#/lib/site/loaders";
import { siteDeps } from "#/lib/site/server";

export async function GET(request: Request) {
  const { catalog } = await pageEngine(siteDeps());
  if (!catalog) {
    return Response.json(
      { error: "no_catalog", message: "The loadout engine hasn't answered since this server started, so there is no catalog yet." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return catalogResponse(catalog, request);
}
