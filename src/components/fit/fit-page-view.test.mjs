// Renders the fit page and browse cards from what the loaders read on pglite, with the engine up,
// down, and sign-in off or on (Review Focus #2 and #4, and the auth-disabled controls).
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCatalogCache } from "../../lib/engine/catalog-cache.ts";
import { createEngineClient } from "../../lib/engine/client.ts";
import { createEngineMonitor } from "../../lib/engine/engine-state.ts";
import { deadEngineUrl, startStubEngine } from "../../lib/engine/stub-engine.mjs";
import { createTestDb } from "../../lib/fits/test-db.mjs";
import { loadBrowse, loadFitPage } from "../../lib/site/loaders.ts";
import { ALICE, BOB, seedSite } from "../../lib/site/seed.mjs";
import { FitCards } from "./browse-view.tsx";
import { FitPageView } from "./fit-page-view.tsx";
import { PublicConfigProvider } from "../../lib/public-config.tsx";

let db;
let ids;
let stub;
let deadUrl;
before(async () => {
  db = await createTestDb();
  ids = await seedSite(db);
  stub = await startStubEngine();
  deadUrl = await deadEngineUrl();
});
after(async () => {
  await stub.close();
  await db.close();
});

const deps = (url) => {
  const client = createEngineClient({ baseUrl: url });
  return { database: () => ({ status: "ready", db }), engine: createEngineMonitor(client, { ttlMs: 0 }), catalog: createCatalogCache(client) };
};
const anonymous = (authEnabled) => ({ userId: null, isAdmin: false, name: null, authEnabled });
const signedIn = (user) => ({ userId: user.userId, isAdmin: false, name: user.name, authEnabled: true });

async function renderFit(url, id, viewer) {
  const data = await loadFitPage(deps(url), id, viewer);
  assert.equal(data.status, "ok");
  // The page's client controls read the public config, as under the root layout.
  const config = { engineUrl: url, clerkPublishableKey: null, authEnabled: viewer.authEnabled };
  return renderToStaticMarkup(h(PublicConfigProvider, { config }, h(FitPageView, { data, viewer })));
}

const count = (html, text) => html.split(text).length - 1;

test("the grid draws every module, the cipher cell, port notches, conduit and regalia marks", async () => {
  const html = await renderFit(stub.url, ids.showcase, anonymous(false));
  assert.equal(count(html, 'data-module="'), 13);
  assert.match(html, /fg-module--linked/, "the connected conduit");
  assert.ok(count(html, 'class="fg-weld"') >= 1, "a weld between the regalia pieces");
  assert.ok(count(html, "fg-module__art-edge") > 0, "port notches");
  assert.match(html, /COOLANT RESERVOIR/);
  assert.match(html, /MAX VELOCITY/);
  assert.match(html, /KASSIK&#x27;S SEVERANCE/, "the set bonus source is named");
  assert.doesNotMatch(html, /fg-module--issue/);
  assert.doesNotMatch(html, /<script>alert/, "the description is sanitized");
});

test("a removed item is drawn as UNKNOWN ITEM with its issue, and the fit reads as outdated (Review Focus #2)", async () => {
  const html = await renderFit(stub.url, ids.removed, anonymous(false));
  const removed = html.slice(html.indexOf('data-module="2"') - 400, html.indexOf('data-module="3"'));
  assert.match(removed, /fg-module--unknown/);
  assert.match(removed, /fg-module--issue/);
  assert.match(removed, /UNKNOWN ITEM/);
  assert.match(removed, /doesn&#x27;t exist in the current build/);
  assert.match(html, /badge--outdated/);
  assert.match(html, /LAST VALID/);
  assert.match(html, /THESE STATS ARE FROM ITS LAST VALID BUILD/);
});

test("with the engine down the page renders its stored stats under a banner (Review Focus #4)", async () => {
  const html = await renderFit(deadUrl, ids.showcase, anonymous(false));
  assert.match(html, /THE LOADOUT ENGINE ISN&#x27;T ANSWERING/);
  assert.match(html, /MAX VELOCITY/);
  assert.match(html, /THE GRID NEEDS THE LOADOUT ENGINE/);
  const up = await renderFit(stub.url, ids.showcase, anonymous(false));
  assert.doesNotMatch(up, /ISN&#x27;T ANSWERING/);
});

test("with sign-in off the write controls are replaced by the not-configured note", async () => {
  const html = await renderFit(stub.url, ids.showcase, anonymous(false));
  assert.match(html, /Sign-in isn&#x27;t configured on this site yet/);
  assert.match(html, /2 UPVOTES/);
  assert.doesNotMatch(html, />UPVOTE</);
  assert.doesNotMatch(html, /REPORT FIT/);
  assert.doesNotMatch(html, /SAY SOMETHING ABOUT THIS FIT/);
  assert.doesNotMatch(html, />REPLY</);
  assert.match(html, /COPY FIT STRING/, "copying needs no sign-in");
});

test("signed in, the pilot gets the vote, comment, reply and report controls; the author edits their own comment", async () => {
  const asBob = await renderFit(stub.url, ids.showcase, signedIn(BOB));
  assert.match(asBob, /UPVOTED/, "BOB already voted");
  assert.match(asBob, /REPORT FIT/);
  assert.match(asBob, /SAY SOMETHING ABOUT THIS FIT/);
  assert.match(asBob, />REPLY</);
  assert.match(asBob, />EDIT</, "BOB wrote the top comment");
  const asAlice = await renderFit(stub.url, ids.showcase, signedIn(ALICE));
  assert.doesNotMatch(asAlice, /REPORT FIT/, "no reporting your own fit");
  const signedOut = await renderFit(stub.url, ids.showcase, anonymous(true));
  assert.match(signedOut, /SIGN IN TO VOTE/);
  assert.match(signedOut, /SIGN IN TO COMMENT/);
});

test("browse cards show hull, title, author, counts and the outdated badge", async () => {
  const data = await loadBrowse(deps(stub.url), {}, { userId: null, isAdmin: false });
  const html = renderToStaticMarkup(h(FitCards, { cards: data.cards, empty: "NONE" }));
  assert.equal(count(html, 'class="fit-card"'), 3);
  assert.match(html, /SCARAB/);
  assert.match(html, /Scarab cipher brawler/);
  assert.match(html, /ALICE/);
  assert.match(html, /2 UPVOTES/);
  assert.match(html, /1 UPVOTE</);
  assert.equal(count(html, "badge--outdated"), 1);
});
