// The /api/catalog response: the catalog the server holds, compressed for the browser (~800 KB of JSON
// is ~60 KB as brotli) and revalidated by build. Each build's bodies are compressed once and kept until
// the next build replaces them.
import { createHash } from "node:crypto";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Catalog } from "./types.ts";

type Encoding = "br" | "gzip" | "identity";
type Bodies = { catalog: Catalog; identity: Buffer; gzip?: Buffer; br?: Buffer };

let held: Bodies | null = null;

function bodies(catalog: Catalog): Bodies {
  if (held?.catalog !== catalog) held = { catalog, identity: Buffer.from(JSON.stringify(catalog)) };
  return held;
}

function encoded(entry: Bodies, encoding: Encoding): Buffer {
  if (encoding === "br") {
    return (entry.br ??= brotliCompressSync(entry.identity, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: entry.identity.length },
    }));
  }
  if (encoding === "gzip") return (entry.gzip ??= gzipSync(entry.identity, { level: 9 }));
  return entry.identity;
}

/** The best encoding the request accepts: brotli, then gzip, else none. A q=0 refuses one. */
export function pickEncoding(acceptEncoding: string | null): Encoding {
  const accepted = new Map<string, number>();
  for (const part of (acceptEncoding ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    accepted.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  const ok = (name: string) => (accepted.get(name) ?? accepted.get("*") ?? 0) > 0;
  return ok("br") ? "br" : ok("gzip") ? "gzip" : "identity";
}

/** Whether If-None-Match names this etag (weak or strong), or is "*". */
export function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((tag) => {
    const value = tag.trim();
    return value === "*" || value.replace(/^W\//, "") === etag;
  });
}

/**
 * `engineEtag` is the engine's tag for this catalog, a hash of its content, so browsers drop their copy
 * whenever the engine's catalog changes, not only when the game build does. Without one, the tag is a hash
 * of the body this server sends.
 */
export function catalogResponse(catalog: Catalog, request: Request, engineEtag: string | null = null): Response {
  const etag = engineEtag?.replace(/^W\//, "") ?? `"${createHash("sha256").update(bodies(catalog).identity).digest("hex")}"`;
  const headers: Record<string, string> = { etag, "cache-control": "no-cache", vary: "accept-encoding" };
  if (matchesEtag(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  const encoding = pickEncoding(request.headers.get("accept-encoding"));
  const body = encoded(bodies(catalog), encoding);
  if (encoding !== "identity") headers["content-encoding"] = encoding;
  return new Response(new Uint8Array(body), {
    headers: { ...headers, "content-type": "application/json", "content-length": String(body.length) },
  });
}
