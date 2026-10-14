// Renders the pilot header from what loadAuthor reads on pglite: avatar or placeholder, bio as text,
// totals, and which controls each reader gets.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "../../lib/fits/test-db.mjs";
import { getPilotProfile, setBio, upsertPilotAtSignIn } from "../../lib/fits/pilots.ts";
import { ALICE, BOB, seedSite } from "../../lib/site/seed.mjs";
import { BrowseFilters } from "../fit/browse-view.tsx";
import { PilotHeader } from "./pilot-header.tsx";

let db;
before(async () => {
  db = await createTestDb();
  await seedSite(db);
});
after(() => db.close());

const anonymous = (authEnabled = true) => ({ userId: null, isAdmin: false, name: null, authEnabled });
const signedIn = (user) => ({ userId: user.userId, isAdmin: false, name: user.name, authEnabled: true });

async function render(userId, viewer) {
  const pilot = await getPilotProfile(db, userId, viewer);
  return renderToStaticMarkup(h(PilotHeader, { pilot, viewer }));
}

test("no avatar: a placeholder with the pilot's initial; an avatar: a plain img that sends no referrer", async () => {
  const placeholder = await render(ALICE.userId, anonymous());
  assert.match(placeholder, /class="pilot-avatar pilot-avatar--none"[^>]*>A<\/span>/);
  assert.doesNotMatch(placeholder, /<img/);
  await upsertPilotAtSignIn(db, { userId: ALICE.userId, name: ALICE.name, avatarUrl: "https://img.clerk.com/alice.png" });
  const html = await render(ALICE.userId, anonymous());
  assert.match(html, /<img class="pilot-avatar" src="https:\/\/img.clerk.com\/alice.png" width="72" height="72" alt="" referrerPolicy="no-referrer"/);
});

test("the header shows name, bio as text, the totals and the top fit", async () => {
  await setBio(db, { pilot: ALICE, bio: "<script>alert(1)</script>\nsecond line" });
  const html = await render(ALICE.userId, anonymous());
  assert.match(html, /<h1 class="pilot-head__name">ALICE<\/h1>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "the bio is escaped text");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /PUBLISHED FITS<\/dt><dd class="rating">1<\/dd>/);
  assert.match(html, /UPVOTES RECEIVED<\/dt><dd class="rating">2<\/dd>/);
  assert.match(html, /TOP FIT/);
  assert.match(html, /Scarab cipher brawler/);
});

test("FOLLOW for another signed-in pilot, EDIT BIO for the owner, a sign-in note signed out, nothing with sign-in off", async () => {
  const bobSees = await render(ALICE.userId, signedIn(BOB));
  assert.match(bobSees, />FOLLOW</);
  assert.doesNotMatch(bobSees, /EDIT BIO/);
  const own = await render(ALICE.userId, signedIn(ALICE));
  assert.match(own, /EDIT BIO/);
  assert.doesNotMatch(own, />FOLLOW</);
  assert.match(await render(ALICE.userId, anonymous()), /SIGN IN TO FOLLOW/);
  const off = await render(ALICE.userId, anonymous(false));
  assert.doesNotMatch(off, /FOLLOW<|EDIT BIO|SIGN IN TO FOLLOW/);
});

test("browse offers 'from pilots I follow' only to a signed-in reader", () => {
  const query = { sort: "top-week", tags: [], currentBuild: false, following: true };
  const signedInForm = renderToStaticMarkup(h(BrowseFilters, { query, hulls: [], signedIn: true }));
  assert.match(signedInForm, /name="following" checked="" value="1"/);
  assert.match(signedInForm, /FROM PILOTS I FOLLOW/);
  const signedOutForm = renderToStaticMarkup(h(BrowseFilters, { query: { ...query, following: false }, hulls: [] }));
  assert.doesNotMatch(signedOutForm, /FROM PILOTS I FOLLOW/);
});
