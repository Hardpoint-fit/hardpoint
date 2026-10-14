// Renders /admin/pilots from what loadPilots reads on pglite, and the re-verify panel the admin pages show a
// moderator whose role has expired.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { banPilot } from "../../lib/fits/bans.ts";
import { upsertPilotAtSignIn } from "../../lib/fits/pilots.ts";
import { createTestDb } from "../../lib/fits/test-db.mjs";
import { loadPilots } from "../../lib/site/loaders.ts";
import { AdminNav, ReverifyPanel } from "../moderation.tsx";
import { PilotsView } from "./pilots-view.tsx";

let db;
before(async () => {
  db = await createTestDb();
  for (const [userId, name] of [
    ["user_admin", "WARDEN"],
    ["user_listed", "OWNER"],
    ["user_bob", "BOB"],
    ["user_eve", "EVE"],
  ]) {
    await upsertPilotAtSignIn(db, { userId, name, avatarUrl: null });
  }
  await banPilot(db, { userId: "user_eve", reason: "Spam links", bannedBy: "user_admin", hideAll: false });
});
after(() => db.close());

const deps = () => ({ database: () => ({ status: "ready", db }) });
const render = async (params = {}) =>
  renderToStaticMarkup(h(PilotsView, { data: await loadPilots(deps(), params), viewerId: "user_admin", siteAdmins: ["user_listed"] }));

/** The <li> of one pilot's row. */
const row = (html, name) => html.split("<li ").find((part) => part.includes(`>${name}</a>`));

test("each pilot shows their ban state; BAN for a pilot, UNBAN for a banned one, neither for you or a site admin", async () => {
  const html = await render();
  assert.match(row(html, "BOB"), />BAN</);
  assert.doesNotMatch(row(html, "BOB"), /BANNED|UNBAN/);
  assert.match(row(html, "EVE"), />BANNED</);
  assert.match(row(html, "EVE"), /Spam links/);
  assert.match(row(html, "EVE"), /BY WARDEN/);
  assert.match(row(html, "EVE"), />UNBAN</);
  assert.doesNotMatch(row(html, "WARDEN"), />BAN</);
  assert.match(row(html, "WARDEN"), />YOU</);
  assert.doesNotMatch(row(html, "OWNER"), />BAN</);
  assert.match(row(html, "OWNER"), />SITE ADMIN</);
});

test("the search form keeps the query and the banned filter, and an empty search says so", async () => {
  const html = await render({ q: "eve", banned: "1" });
  assert.match(html, /<input class="input" type="search"[^>]*name="q" value="eve"/);
  assert.match(html, /name="banned" checked="" value="1"/);
  assert.equal(html.split("<li ").length - 1, 1);
  assert.match(await render({ q: "nobody here" }), /NO PILOTS MATCH/);
  assert.match(renderToStaticMarkup(h(PilotsView, { data: { status: "unavailable" }, viewerId: "user_admin", siteAdmins: [] })), /PILOTS/);
});

test("an admin page for an expired moderator is one re-verify link back to it, and the admin nav marks the page", () => {
  const panel = renderToStaticMarkup(h(ReverifyPanel, { returnTo: "/admin/pilots" }));
  assert.match(panel, /href="\/auth\/signin\?returnTo=%2Fadmin%2Fpilots&amp;reverify=1"[^>]*>RE-VERIFY TO MODERATE</);
  const nav = renderToStaticMarkup(h(AdminNav, { current: "pilots" }));
  assert.match(nav, /aria-current="page" href="\/admin\/pilots"/);
  assert.match(nav, /href="\/admin\/reports"/);
});
