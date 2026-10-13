// The engine's catalog for the builder, from the server's cache: it is still served from the copy the
// server holds while the engine is down, so the builder keeps editing. Revalidated by build (ETag).
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
  const etag = `"${catalog.buildSha}"`;
  const headers = { etag, "cache-control": "no-cache" };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return Response.json(catalog, { headers });
}
