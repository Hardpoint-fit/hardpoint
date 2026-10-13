import assert from "node:assert/strict";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { catalogResponse, matchesEtag, pickEncoding } from "./catalog-response.ts";

const catalog = JSON.parse(await readFile(new URL("./__fixtures__/catalog.json", import.meta.url), "utf8"));
const etag = `"${catalog.buildSha}"`;
const get = (headers = {}) => catalogResponse(catalog, new Request("http://site/api/catalog", { headers }));
const json = JSON.stringify(catalog);

test("the catalog is served as brotli or gzip when the browser takes it, the same JSON either way", async () => {
  const br = get({ "accept-encoding": "gzip, deflate, br" });
  assert.equal(br.headers.get("content-encoding"), "br");
  assert.equal(br.headers.get("vary"), "accept-encoding");
  const brBody = Buffer.from(await br.arrayBuffer());
  assert.equal(brotliDecompressSync(brBody).toString(), json);
  assert.ok(brBody.length < json.length / 4);

  const gzip = get({ "accept-encoding": "gzip" });
  assert.equal(gzip.headers.get("content-encoding"), "gzip");
  assert.equal(gunzipSync(Buffer.from(await gzip.arrayBuffer())).toString(), json);

  const plain = get();
  assert.equal(plain.headers.get("content-encoding"), null);
  assert.equal(await plain.text(), json);
  assert.equal(plain.headers.get("etag"), etag);
});

test("a held build is a 304, whatever form the etag comes back in", () => {
  for (const ifNoneMatch of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
    const response = get({ "if-none-match": ifNoneMatch, "accept-encoding": "br" });
    assert.equal(response.status, 304, ifNoneMatch);
    assert.equal(response.headers.get("etag"), etag);
  }
  assert.equal(get({ "if-none-match": '"old-build"' }).status, 200);
});

test("accept-encoding weights are honoured", () => {
  assert.equal(pickEncoding("br;q=0, gzip"), "gzip");
  assert.equal(pickEncoding("gzip;q=0.5, br;q=1.0"), "br");
  assert.equal(pickEncoding("identity"), "identity");
  assert.equal(pickEncoding("*"), "br");
  assert.equal(pickEncoding(null), "identity");
  assert.equal(matchesEtag(null, etag), false);
});
