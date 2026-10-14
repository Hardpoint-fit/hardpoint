// Renders the fit page and browse cards from what the loaders read on pglite, with the engine up,
// down, and sign-in off or on (Review Focus #2 and #4, and the auth-disabled controls).
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FIXTURES } from "../../lib/engine/stub-engine.mjs";
import { createCatalogCache } from "../../lib/engine/catalog-cache.ts";
import { createEngineClient } from "../../lib/engine/client.ts";
import { createEngineMonitor } from "../../lib/engine/engine-state.ts";
import { deadEngineUrl, startStubEngine } from "../../lib/engine/stub-engine.mjs";
import { createTestDb } from "../../lib/fits/test-db.mjs";
import { createFit, deleteFit, publishFit, unpublishFit, updateFit } from "../../lib/fits/queries.ts";
import { setBookmark } from "../../lib/fits/bookmarks.ts";
import { toEvaluationInput } from "../../lib/fits/service.ts";
import { AffinityPanel } from "../affinity/affinity-panel.tsx";
import { affinityTag } from "../affinity/affinity.ts";
import { cardModules, loadBrowse, loadCompare, loadFitPage } from "../../lib/site/loaders.ts";
import { ALICE, BOB, seedSite } from "../../lib/site/seed.mjs";
import { FitCards } from "./browse-view.tsx";
import { FitPageView } from "./fit-page-view.tsx";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { CompareView } from "./compare-view.tsx";
import { MarkdownEditor } from "../markdown-editor.tsx";
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

async function renderFit(url, id, viewer, rev) {
  const data = await loadFitPage(deps(url), id, viewer, rev);
  assert.equal(data.status, "ok");
  // The page's client controls read the public config, as under the root layout.
  const config = { apiUrl: url, authEnabled: viewer.authEnabled };
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

test("a cell a grid consumable changed is marked on the grid, with the legend under it", async () => {
  // fit-showcase.json carries one slot override: a Core added at cell 0.
  const html = await renderFit(stub.url, ids.showcase, anonymous(false));
  assert.equal(count(html, "fg-cell--modified"), 1);
  assert.equal(count(html, 'class="fg-cell__mark"'), 1);
  assert.match(html, /MODIFIED CELL \(1\): CHANGED FROM THE HULL&#x27;S LAYOUT BY A GRID CONSUMABLE/);
});

test("the fit page shows the hull's art, every module's art, descriptions, fact rows and the stored hull specs", async () => {
  const html = await renderFit(stub.url, ids.showcase, anonymous(false));
  assert.match(html, /class="item-icon fit-head__icon" src="https?:\/\/[^"\/]+\/v1\/art\/[0-9a-f]{32}\.[0-9a-f]{16}\.webp"/, "the hull's art in the header");
  assert.equal(count(html, 'class="fg-module__icon"'), 13 + 1, "each module's art, and the cipher's in its cell");
  assert.match(html, /item-icon item-icon--mirrored"[^>]* src="https?:\/\/[^"\/]+\/v1\/art\//, "the cipher's art faces the other way, as in the game");
  // AUTO VENTING's tooltip: its description and its catalog fact rows.
  assert.match(html, /<p class="item-desc">AUTOMATICALLY VENTS HEAT WHEN UNSTABLE, TEMPORARILY REDUCING YOUR TURNING ABILITY\.<\/p>/);
  assert.match(html, /<span class="facts__label">DEACTIVATION COOLDOWN<\/span>/);
  assert.match(html, /<span class="facts__value positive">\+1,200%<\/span>/);
  // A rolled module (the Augmented turret) shows its plainest roll's rows, named for what they are.
  assert.match(html, /STANDARD ROLL/);
  // The hull specs panel, from the stored verdict: sections, headline values, rows, units and help.
  assert.match(html, /HULL SPECS/);
  for (const section of FIXTURES.evaluateShowcase.sections) assert.ok(html.includes(`aria-label="${section.label}"`), section.label);
  assert.match(html, /<span class="specs__title">DEFENSE<\/span><span class="specs__summary"><span class="specs__value ">3,644<\/span><span class="specs__unit">HP<\/span>/);
  assert.match(html, /data-spec="time-to-scram"><span class="specs__label">TIME TO SCRAM<\/span><span class="specs__values"><span class="specs__value ">01:04<\/span><\/span>/);
  assert.match(html, /<span class="specs__value ">24<\/span><span class="specs__arrow">→<\/span><span class="specs__value negative">21<\/span><span class="specs__unit">%<\/span>/, "a comparison row, toned as the engine tones it");
  assert.match(html, /COMBINED SURVIVABILITY OF ARMOR AND HULL, WEIGHTED BY RESISTANCE\./, "the row's help");
  assert.match(html, /<span>MODIFIERS<\/span>/);
});

test("with the engine down the fit page still shows the stored hull specs (Review Focus #2)", async () => {
  const html = await renderFit(deadUrl, ids.showcase, anonymous(false));
  assert.match(html, /THE GRID NEEDS THE ENGINE/);
  assert.match(html, /data-spec="effective-health"/);
  assert.match(html, /EFFECTIVE HEALTH/);
});

test("a verdict stored before the engine sent hull specs says the stats come with the next check", async () => {
  const html = await renderFit(stub.url, ids.pending, anonymous(false));
  assert.match(html, /CHECKING ON NEW BUILD/);
  assert.match(html, /STATS APPEAR AFTER THE NEXT CHECK\./);
  assert.doesNotMatch(html, /data-spec=/);
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
  assert.match(html, /THE ENGINE ISN&#x27;T ANSWERING/);
  assert.match(html, /MAX VELOCITY/);
  assert.match(html, /THE GRID NEEDS THE ENGINE/);
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
  assert.equal(html.match(/class="item-icon fit-card__hull-icon" src="https?:\/\/[^"\/]+\/v1\/art\/[0-9a-f]{32}\.[0-9a-f]{16}\.webp"/g)?.length, 3, "each card shows its hull's art");
  assert.equal(count(html, "badge--outdated"), 1);
  // Each card's modules: one icon per item kind (def), in mount order, by the grid's icon rule.
  const showcase = data.cards.find((card) => card.title === "Scarab cipher brawler");
  assert.equal(showcase.modules.reduce((sum, module) => sum + module.count, 0), 13);
  assert.equal(showcase.modules[0].name, "REPAIR PROJECTOR");
  assert.ok(showcase.modules.every((module) => /^https?:\/\/[^/]+\/v1\/art\//.test(module.icon ?? "")));
  const shown = data.cards.reduce((sum, card) => sum + Math.min(10, card.modules.length), 0);
  assert.equal(count(html, 'class="fit-card__module"'), shown, "ten kinds a card at most");
  assert.match(html, /<span class="fit-card__modules" role="img" aria-label="Modules: REPAIR PROJECTOR x2, /, "the strip is named for screen readers");
  assert.match(html, /<span class="fit-card__module-more">\+2<\/span>/, "the showcase's other two summed up");
  // A kind fitted twice is one icon with its count; an item the build lacks is UNKNOWN ITEM with no art.
  const twice = cardModules({ moduleItems: [showcase, showcase].map(() => ({ def: FIXTURES.catalog.items[0].def, rarity: "Normal", isIdentified: true, artifact: null })).concat([{ def: "gone", rarity: "Normal", isIdentified: true, artifact: null }]) }, FIXTURES.catalog);
  assert.deepEqual(twice.map((module) => [module.name, module.count, module.icon === null]), [[FIXTURES.catalog.items[0].name, 2, false], ["UNKNOWN ITEM", 1, true]]);
  assert.match(renderToStaticMarkup(h(FitCards, { cards: [{ ...showcase, modules: twice }], empty: "" })), /<span class="fit-card__module-count">x2<\/span>/);
});

test("the author sees delete (and unpublish when published) on their fit; others do not; a tombstone hides its text", async () => {
  const asAlice = await renderFit(stub.url, ids.showcase, signedIn(ALICE));
  assert.match(asAlice, />DELETE FIT</);
  assert.match(asAlice, />UNPUBLISH</);
  const asBob = await renderFit(stub.url, ids.showcase, signedIn(BOB));
  assert.doesNotMatch(asBob, /DELETE FIT|UNPUBLISH/);
  assert.match(asBob, />DELETE</, "BOB's own comment");
  assert.doesNotMatch(await renderFit(stub.url, ids.showcase, anonymous(true)), />DELETE|UNPUBLISH/);
  const draftHtml = await renderFit(stub.url, ids.draft, signedIn(ALICE));
  assert.match(draftHtml, />DELETE FIT</);
  assert.doesNotMatch(draftHtml, /UNPUBLISH/);

  await db.query("UPDATE fit_comments SET body = '[deleted]', deleted_at = now() WHERE id = $1::bigint", [ids.comment]);
  try {
    const html = await renderFit(stub.url, ids.showcase, signedIn(BOB));
    assert.match(html, /\[DELETED\]/);
    assert.doesNotMatch(html, /second scanner/);
    const tomb = html.slice(html.indexOf(`id="comment-${ids.comment}"`), html.indexOf(`id="comment-${ids.reply}"`));
    assert.match(tomb, /\[DELETED\]/);
    assert.doesNotMatch(tomb, />(DELETE|EDIT|REPORT)</, "a tombstone has no controls");
    const afterTomb = html.slice(html.indexOf(`id="comment-${ids.reply}"`));
    assert.equal(count(html, ">REPLY<"), 0, "no reply control under the tombstone");
    assert.match(afterTomb, /Only if the slip coating turns/);
  } finally {
    await db.query("UPDATE fit_comments SET body = 'Does the **cipher** cell still fit with a second scanner?', deleted_at = NULL WHERE id = $1::bigint", [ids.comment]);
  }
});

test("a fit lists its history, and a fit with none shows no HISTORY section", async () => {
  await db.query("DELETE FROM fit_revisions WHERE fit_id = $1", [ids.pending]);
  assert.doesNotMatch(await renderFit(stub.url, ids.pending, anonymous(false)), /HISTORY/);
  await updateFit(db, { id: ids.pending, authorUserId: BOB.userId, title: "Waiting, renamed", note: "Renamed it" });
  await updateFit(db, { id: ids.pending, authorUserId: BOB.userId, description: "More words", note: "<b>Said more</b>" });
  const html = await renderFit(stub.url, ids.pending, anonymous(false));
  assert.match(html, /HISTORY/);
  assert.ok(html.indexOf("REVISION 2") < html.indexOf("REVISION 1"), "newest first");
  assert.match(html, /RENAMED IT/);
  assert.match(html, /&lt;B&gt;SAID MORE&lt;\/B&gt;/, "a note is text, never markup");
  assert.match(html, /\?rev=1"/, "an older revision links to its view");
  assert.doesNotMatch(html, /REVISION \d+ OF/, "the latest page has no revision banner");
  assert.match(html, /<span>MODIFIERS<\/span>/);
});

test("?rev=N is read-only on that revision: banner, its words and fit string source, no stats for an old one", async () => {
  // The tests above left two revisions: 1 (renamed) and 2 (described); the seeded one was deleted.
  // Revision 3 changes the content, so revision 1 no longer equals the fit and has no stats.
  const changed = { ...FIXTURES.fit, modules: FIXTURES.fit.modules.slice(0, 1) };
  await updateFit(db, {
    id: ids.pending,
    authorUserId: BOB.userId,
    content: { hullItem: changed.hull.def, fit: changed },
    evaluation: { ...toEvaluationInput(FIXTURES.evaluateValid), buildSha: FIXTURES.status.build },
  });
  const html = await renderFit(stub.url, ids.pending, anonymous(false), "1");
  assert.match(html, /REVISION 1 OF 3/);
  assert.match(html, /VIEW LATEST/);
  assert.match(html, /STATS ARE SHOWN FOR THE LATEST REVISION/);
  assert.doesNotMatch(html, /<span>(MODIFIERS|HULL SPECS)<\/span>/);
  assert.match(html, /Waiting, renamed/, "the first revision's title");
  assert.doesNotMatch(html, /More words/, "the later revision's description");
  assert.match(html, /\/fits\/new\?from=[A-Za-z0-9]+&amp;rev=1"/, "copy to builder carries the revision");
  assert.equal(count(html, 'data-module="'), FIXTURES.fit.modules.length, "the revision's own modules, not the current one's");
});

test("each distinct module on a fit page links to the fits that use it", async () => {
  const html = await renderFit(stub.url, ids.showcase, anonymous(false));
  const omni = FIXTURES.fitShowcase.modules[0].item.def;
  assert.match(html, /MODULES/);
  assert.ok(html.includes(`href="/?module=${omni}"`));
  assert.match(html, /Fits using this module/);
  const defs = new Set(FIXTURES.fitShowcase.modules.map((module) => module.item.def));
  assert.equal(html.split("Fits using this module").length - 1, defs.size, "one link per distinct module");
});

async function copyOf(source, owner) {
  const made = await createFit(db, {
    authorUserId: owner.userId,
    authorName: owner.name,
    title: "Showcase copy",
    content: { hullItem: FIXTURES.fit.hull.def, fit: FIXTURES.fit },
    buildSha: FIXTURES.status.build,
    evaluation: { ...toEvaluationInput(FIXTURES.evaluateValid), buildSha: FIXTURES.status.build },
    forkedFrom: source,
  });
  await publishFit(db, { id: made.id, authorUserId: owner.userId, buildSha: FIXTURES.status.build });
  return made.id;
}

test("a copy says what it is based on and the source counts its copies; a deleted or unseen source is worded without names", async () => {
  const copy = await copyOf(ids.showcase, BOB);
  const plain = await renderFit(stub.url, ids.showcase, anonymous(false));
  assert.doesNotMatch(plain, /BASED ON/);
  assert.match(plain, />1 COPY</);
  assert.doesNotMatch(plain, /COPIES</);
  const forked = await renderFit(stub.url, copy, anonymous(false));
  assert.match(forked, /BASED ON <a class="link" href="\/fits\/[A-Za-z0-9]+">Scarab cipher brawler<\/a> BY <a class="link" href="\/u\/user_alice">ALICE<\/a>/);
  assert.doesNotMatch(forked, /COPY</);

  await copyOf(ids.showcase, ALICE);
  assert.match(await renderFit(stub.url, ids.showcase, anonymous(false)), />2 COPIES</);

  await unpublishFit(db, { id: ids.showcase, authorUserId: ALICE.userId });
  const unseen = await renderFit(stub.url, copy, anonymous(false));
  assert.match(unseen, /BASED ON ANOTHER FIT/);
  assert.doesNotMatch(unseen, /Scarab cipher brawler/);
  await publishFit(db, { id: ids.showcase, authorUserId: ALICE.userId, buildSha: FIXTURES.status.build });

  const gone = await copyOf(ids.pending, BOB);
  await deleteFit(db, { id: ids.pending, authorUserId: BOB.userId });
  assert.match(await renderFit(stub.url, gone, anonymous(false)), /BASED ON A FIT THAT NO LONGER EXISTS/);
});

test("signed in, a published fit has a bookmark toggle that reads the pilot's own bookmark; signed out and sign-in off have none", async () => {
  assert.match(await renderFit(stub.url, ids.showcase, signedIn(BOB)), /aria-pressed="false">BOOKMARK</);
  await setBookmark(db, { fitId: ids.showcase, userId: BOB.userId, bookmarked: true });
  assert.match(await renderFit(stub.url, ids.showcase, signedIn(BOB)), /aria-pressed="true">BOOKMARKED</);
  assert.match(await renderFit(stub.url, ids.showcase, signedIn(ALICE)), /aria-pressed="false">BOOKMARK</, "someone else's bookmark isn't yours");
  assert.doesNotMatch(await renderFit(stub.url, ids.showcase, anonymous(true)), /BOOKMARK/);
  assert.doesNotMatch(await renderFit(stub.url, ids.showcase, anonymous(false)), /BOOKMARK/);
  assert.doesNotMatch(await renderFit(stub.url, ids.draft, signedIn(ALICE)), /BOOKMARK/, "a draft can't be bookmarked");
});

test("browse cards carry the bookmark toggle only for a signed-in viewer, and only on published fits", async () => {
  const data = await loadBrowse(deps(stub.url), {}, signedIn(BOB));
  const cards = (canBookmark) => renderToStaticMarkup(h(PublicConfigProvider, { config: { apiUrl: stub.url, authEnabled: true } }, h(FitCards, { cards: data.cards, empty: "", canBookmark })));
  assert.equal(count(cards(true), ">BOOKMARKED<"), 1, "the one BOB bookmarked");
  assert.ok(count(cards(true), ">BOOKMARK<") >= 2);
  assert.doesNotMatch(cards(false), /BOOKMARK/);
});

test("an outdated fit shows BROKEN ON THIS BUILD with the issue and the last build it worked on; a current fit shows none", async () => {
  const broken = await renderFit(stub.url, ids.removed, anonymous(false));
  assert.match(broken, /BROKEN ON THIS BUILD/);
  assert.match(broken, /LAST WORKED ON BUILD 00000000/);
  assert.match(broken, /aria-label="Issues on the current build"[^>]*>.*UNKNOWN ITEM/s);
  assert.doesNotMatch(await renderFit(stub.url, ids.showcase, anonymous(false)), /BROKEN ON THIS BUILD/);
});

test("the fit page offers COMPARE", async () => {
  assert.match(await renderFit(stub.url, ids.showcase, anonymous(false)), />COMPARE</);
});

test("the compare page shows both fits, marks differing rows with — for a missing one, and a Fit not found column", async () => {
  const render = async (a, b, viewer = anonymous(false)) => {
    const data = await loadCompare(deps(stub.url), { a, b }, viewer);
    assert.equal(data.status, "ok");
    return renderToStaticMarkup(h(AppRouterContext.Provider, { value: { push() {} } }, h(CompareView, { data, signedIn: false })));
  };
  // The stub engine answers every fit with the same stats, so make one row differ and another go missing by hand.
  const loaded = await loadCompare(deps(stub.url), { a: ids.showcase, b: ids.removed }, anonymous(false));
  const [first, second] = loaded.sections[0].rows;
  loaded.sections[0].rows[0] = { ...first, b: { ...first.b, primary: { ...first.b.primary, text: "9,999" } }, differs: true };
  loaded.sections[0].rows[1] = { ...second, b: null, differs: true };
  const marked = renderToStaticMarkup(h(CompareView, { data: loaded, signedIn: false }));
  assert.match(marked, /compare-row compare-row--differs"[^>]*data-differs="true"/);
  assert.match(marked, /9,999/);
  assert.match(marked, /<span class="compare-missing" aria-label="Missing">—<\/span>/);
  assert.match(await render(ids.showcase, ids.removed), /data-differs="false"/);
  const html = await render(ids.showcase, ids.removed);
  assert.match(html, /Scarab cipher brawler/);
  assert.match(html, /Old build regalia runner/);
  assert.match(html, /ONLY IN A/);
  assert.match(html, /IN BOTH/);
  const hidden = await render(ids.showcase, ids.draft);
  assert.match(hidden, /FIT NOT FOUND/);
  assert.doesNotMatch(hidden, /Unfinished idea/, "another pilot's draft is never named");
  assert.match(hidden, /HULL SPECS|CHOOSE ANOTHER FIT/);
});

test("the markdown editor offers WRITE and PREVIEW and starts on the textarea", () => {
  const html = renderToStaticMarkup(h(MarkdownEditor, { value: "**hi**", onChange() {}, maxLength: 100, label: "Comment" }));
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>WRITE</);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>PREVIEW</);
  assert.match(html, /<textarea[^>]*aria-label="Comment"/);
  assert.doesNotMatch(html, /<strong>/, "the browser never renders Markdown itself");
});

test("moderation on the spot: a live admin hides the fit and each comment where they stand; an expired one gets one RE-VERIFY link; others neither", async () => {
  const admin = (moderation) => ({ userId: "user_admin", isAdmin: moderation === "active", name: "WARDEN", authEnabled: true, moderation });
  const live = await renderFit(stub.url, ids.showcase, admin("active"));
  assert.match(live, />HIDE FIT</);
  assert.equal(count(live, ">HIDE COMMENT<"), 2, "the comment and its reply");
  assert.doesNotMatch(live, /RE-VERIFY TO MODERATE/);

  const expired = await renderFit(stub.url, ids.showcase, admin("reverify"));
  assert.equal(count(expired, "RE-VERIFY TO MODERATE"), 1, "one link for the page, in place of every HIDE");
  assert.match(expired, new RegExp(`href="/auth/signin\\?returnTo=%2Ffits%2F${ids.showcase}&amp;reverify=1"`));
  assert.doesNotMatch(expired, /HIDE FIT|HIDE COMMENT/);

  for (const viewer of [signedIn(BOB), anonymous(true), admin("none")]) {
    const html = await renderFit(stub.url, ids.showcase, viewer);
    assert.doesNotMatch(html, /HIDE FIT|HIDE COMMENT|RE-VERIFY TO MODERATE/);
  }
});

test("a live admin sees a hidden fit with UNHIDE FIT; the re-verify link returns to the revision being read", async () => {
  const { setFitHidden } = await import("../../lib/fits/queries.ts");
  await setFitHidden(db, ids.removed, true);
  try {
    const html = await renderFit(stub.url, ids.removed, { userId: "user_admin", isAdmin: true, name: "WARDEN", authEnabled: true, moderation: "active" });
    assert.match(html, />UNHIDE FIT</);
  } finally {
    await setFitHidden(db, ids.removed, false);
  }
  const { listRevisions } = await import("../../lib/fits/revisions.ts");
  const [latest] = await listRevisions(db, ids.showcase);
  const html = await renderFit(stub.url, ids.showcase, { userId: "user_admin", isAdmin: false, name: "WARDEN", authEnabled: true, moderation: "reverify" }, String(latest.revision));
  assert.match(html, new RegExp(`returnTo=%2Ffits%2F${ids.showcase}%3Frev%3D${latest.revision}&amp;reverify=1`));
});

// ---- Affinity on published fits ---------------------------------------------------------------------------

// Turret affinity at level 5 (XP 2164): 3 and 2 points in two bonuses, and the 5-point threshold's second choice.
const TURRET_PROGRESSION = { affinityType: "Turret", affinityXp: 2164, allocatedPoints: [0, 0, 0, 0, 3, 2], thresholdSelections: [...Array(8).fill(255), 1] };

async function publishWith(progression, title) {
  const fit = { ...FIXTURES.fitShowcase, progression };
  const created = await createFit(db, {
    authorUserId: ALICE.userId,
    authorName: ALICE.name,
    title,
    content: { hullItem: fit.hull.def, fit },
    buildSha: FIXTURES.status.build,
    evaluation: { ...toEvaluationInput(FIXTURES.evaluateShowcase), buildSha: FIXTURES.status.build },
  });
  await publishFit(db, { id: created.id, authorUserId: ALICE.userId, buildSha: FIXTURES.status.build });
  return created.id;
}

/** The AFFINITY panel's markup. */
const affinityPanel = (html) => /<section class="panel affinity">.*?<\/section>/s.exec(html)?.[0] ?? "";

test("a fit with an affinity shows it read-only: type, level, points per node, chosen threshold, and no controls", async () => {
  const id = await publishWith(TURRET_PROGRESSION, "Turret affinity fit");
  const html = await renderFit(stub.url, id, anonymous(false));
  const panel = affinityPanel(html);
  assert.match(panel, /<span>AFFINITY<\/span>/);
  assert.match(panel, /TURRET AFFINITY/);
  assert.match(panel, /SHIP LEVEL 5/);
  assert.match(panel, /5\/5 AFFINITY POINTS/);
  assert.match(panel, /affinity-type__points">5\/20</, "the points held in the type");
  assert.match(panel, /TURRET DAMAGE[\s\S]*?stepper__value">3</, "points on the first bonus");
  assert.match(panel, /OPTIMAL RANGE[\s\S]*?stepper__value">2</, "points on the second bonus");
  assert.match(panel, /AT 5 POINTS/);
  assert.doesNotMatch(panel, /CHOOSE ONE|NEEDS \d+ POINTS/, "only the reached thresholds, as chosen");
  assert.doesNotMatch(panel, /<(button|select|input|textarea)\b/, "read-only: no control");
  assert.doesNotMatch(panel, /aria-expanded|role="radio"/);
});

test("a fit without an affinity says NO AFFINITY, on the page and on a revision with none", async () => {
  assert.match(affinityPanel(await renderFit(stub.url, ids.showcase, anonymous(false))), /NO AFFINITY\./);
  const id = await publishWith(TURRET_PROGRESSION, "Affinity then none");
  const plain = { ...FIXTURES.fitShowcase, progression: { ...TURRET_PROGRESSION, affinityType: "None", affinityXp: 0, allocatedPoints: [], thresholdSelections: [] } };
  await updateFit(db, { id, authorUserId: ALICE.userId, content: { hullItem: plain.hull.def, fit: plain }, evaluation: { ...toEvaluationInput(FIXTURES.evaluateShowcase), buildSha: FIXTURES.status.build } });
  assert.match(affinityPanel(await renderFit(stub.url, id, anonymous(false))), /NO AFFINITY\./, "the latest has none");
  const older = affinityPanel(await renderFit(stub.url, id, anonymous(false), "1"));
  assert.match(older, /TURRET AFFINITY/, "revision 1 shows its own affinity");
  assert.doesNotMatch(older, /NO AFFINITY/);
});

test("browse cards and the share card tag the affinity type and level, and only when there is a type", async () => {
  const id = await publishWith(TURRET_PROGRESSION, "Tagged by affinity");
  const data = await loadBrowse(deps(stub.url), {}, anonymous(false));
  assert.equal(data.cards.find((card) => card.id === id).affinity, "TURRET 5");
  assert.equal(data.cards.find((card) => card.id === ids.showcase).affinity, null);
  const cards = renderToStaticMarkup(h(PublicConfigProvider, { config: { apiUrl: stub.url, authEnabled: false } }, h(FitCards, { cards: data.cards, empty: "" })));
  assert.ok(count(cards, ">TURRET 5<") >= 1, "the tag is on the card");
  assert.doesNotMatch(cards, />NONE \d|>NONE</, "a fit without a type has no tag");
  const page = await loadFitPage(deps(stub.url), id, anonymous(false));
  assert.equal(affinityTag(page.engine.catalog.affinity, page.progression.affinityType, page.progression.affinityXp, page.progression.allocatedPoints), "TURRET 5", "what the share card prints");
  const catalog = page.engine.catalog.affinity;
  assert.equal(affinityTag(null, "Turret", 2164, []), "TURRET", "no catalog, no level");
  assert.equal(affinityTag(catalog, "None", 2164, []), null, "no focus and no points is no affinity");
  assert.equal(affinityTag(catalog, "None", 2164, [0, 0, 0, 0, 3, 2]), "TURRET 5", "no focus: the type with most points");
  assert.equal(affinityTag(catalog, "Shield", 2164, [0, 0, 0, 0, 3, 2]), "SHIELD 5", "the focus names the tag, whatever holds the points");
  assert.equal(affinityTag(catalog, "Shield", 2164, []), "SHIELD 5", "a focus alone is enough");
  assert.equal(affinityTag(catalog, "None", 2164, [0, 0, 0, 0, 1, 0, 0, 0, 1]), "TURRET 5", "a tie goes to the earlier type in the layout (Turret=1, Shield=2)");
  assert.equal(affinityTag(catalog, "None", 2164, [0, 0, 0, 0, 1, 0, 0, 0, 2]), "SHIELD 5");
  // A builder fit: focus None, points spent.
  const builder = await publishWith({ ...TURRET_PROGRESSION, affinityType: "None" }, "Builder style affinity");
  const again = await loadBrowse(deps(stub.url), {}, anonymous(false));
  assert.equal(again.cards.find((card) => card.id === builder).affinity, "TURRET 5");
});

test("compare lines up affinity type, level and points per node", async () => {
  const a = await publishWith(TURRET_PROGRESSION, "Compare affinity A");
  const b = await publishWith({ ...TURRET_PROGRESSION, affinityXp: 458, allocatedPoints: [0, 0, 0, 0, 1] , thresholdSelections: [] }, "Compare affinity B");
  const data = await loadCompare(deps(stub.url), { a, b }, anonymous(false));
  assert.equal(data.status, "ok");
  const row = (id) => data.affinity.find((each) => each.id === id);
  assert.deepEqual([row("type").a, row("type").b, row("type").differs], ["TURRET", "TURRET", false]);
  assert.deepEqual([row("level").a, row("level").b, row("level").differs], ["5", "2", true]);
  assert.deepEqual([row("Turret:0").a, row("Turret:0").b], ["3", "1"]);
  assert.deepEqual([row("Turret:1").a, row("Turret:1").b], ["2", "0"]);
  const html = renderToStaticMarkup(h(CompareView, { data, signedIn: false }));
  assert.match(html, /<span>AFFINITY<\/span>/);
  assert.match(html, /SHIP LEVEL/);
  assert.match(html, /TURRET · TURRET DAMAGE/);
  const none = await loadCompare(deps(stub.url), { a: ids.showcase, b: ids.removed }, anonymous(false));
  assert.deepEqual(none.affinity, [], "neither fit has an affinity: no rows");
});

test("the same panel is editable with an editor: level select, steppers and threshold choices", async () => {
  const noop = () => {};
  const affinity = (await loadFitPage(deps(stub.url), ids.showcase, anonymous(false))).engine.catalog.affinity;
  const html = renderToStaticMarkup(h(AffinityPanel, { affinity, progression: TURRET_PROGRESSION, editor: { open: "Turret", onToggle: noop, onLevel: noop, onAllocate: noop, onThreshold: noop } }));
  assert.match(html, /<select/);
  assert.match(html, /aria-label="Add a point to TURRET DAMAGE"/);
  assert.match(html, /role="radio"/);
});

test("a stored fit's odd affinity values read as nothing on a card rather than failing the query", async () => {
  const odd = { ...FIXTURES.fitShowcase, progression: { affinityType: 7, affinityXp: 1e300, allocatedPoints: [], thresholdSelections: [] } };
  const created = await createFit(db, { authorUserId: ALICE.userId, authorName: ALICE.name, title: "Odd affinity", content: { hullItem: odd.hull.def, fit: odd }, buildSha: FIXTURES.status.build, evaluation: { ...toEvaluationInput(FIXTURES.evaluateShowcase), buildSha: FIXTURES.status.build } });
  await publishFit(db, { id: created.id, authorUserId: ALICE.userId, buildSha: FIXTURES.status.build });
  const data = await loadBrowse(deps(stub.url), {}, anonymous(false));
  assert.equal(data.cards.find((card) => card.id === created.id).affinity, null);
  const page = await loadFitPage(deps(stub.url), created.id, anonymous(false));
  assert.equal(page.progression, null, "a progression of the wrong shape is unreadable, not drawn");
  assert.match(await renderFit(stub.url, created.id, anonymous(false)), /AFFINITY CAN&#x27;T BE READ|AFFINITY CAN&apos;T BE READ/);
});

test("an older engine without the grid style or the affinity layout: the page says so where the grid and points go, and the stats still read", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { layout, ...tree } = FIXTURES.parts.affinity.affinity;
  const older = await startStubEngine({
    "GET /v1/ui/fitting-grid": (req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "No such route." } }));
    },
    "GET /v1/affinity": (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ build: FIXTURES.parts.affinity.build, affinity: tree }));
    },
  });
  t.after(() => older.close());
  assert.ok(layout);
  const id = await publishWith(TURRET_PROGRESSION, "Older engine fit");
  const html = await renderFit(older.url, id, anonymous(false));
  assert.match(html, /THE GRID CAN&#x27;T BE DRAWN RIGHT NOW/);
  assert.doesNotMatch(html, /class="fg"/, "no grid drawn");
  const panel = affinityPanel(html);
  assert.match(panel, /AFFINITY POINTS AREN&#x27;T AVAILABLE FROM THE ENGINE RIGHT NOW/);
  assert.match(panel, /TURRET AFFINITY · SHIP LEVEL 5/, "the type and level still read");
  assert.match(html, /MAX VELOCITY|HULL HP|MASS/, "the stats keep the game's wording");
});
