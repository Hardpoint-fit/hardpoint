// Module name suggestions for the browse filter: GET /api/modules?q=text, a few matches from the catalog
// the server holds, so the browse page doesn't ship the whole catalog to find a module.
import { MAX_SEARCH_LENGTH } from "#/lib/fits/filters";
import { pageEngine } from "#/lib/site/loaders";
import { searchModules } from "#/lib/site/module-search";
import { siteDeps } from "#/lib/site/server";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const { catalog } = await pageEngine(siteDeps());
  return Response.json({ modules: searchModules(catalog, q.slice(0, MAX_SEARCH_LENGTH)) }, { headers: { "cache-control": "no-store" } });
}
