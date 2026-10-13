import assert from "node:assert/strict";
import test from "node:test";
import { decodeCursor, encodeCursor, parseBrowseParams, toBrowseSearch } from "./filters.ts";

test("no params gives the defaults", () => {
  const query = parseBrowseParams({});
  assert.deepEqual(query, { sort: "top-week", tags: [], currentBuild: false });
});

test("all filters parse from a URLSearchParams", () => {
  const query = parseBrowseParams(
    new URLSearchParams("hull=123456&class=Frigate&role=Support&tag=pvp&tag=Budget&author=user_2abc&current=1&sort=new"),
  );
  assert.deepEqual(query, {
    hull: "123456",
    hullClass: "Frigate",
    role: "Support",
    tags: ["pvp", "budget"],
    author: "user_2abc",
    currentBuild: true,
    sort: "new",
  });
});

test("next.js style records parse, repeated and comma separated tags merge", () => {
  const query = parseBrowseParams({ tag: ["a", "b,c"], sort: ["discussed"] });
  assert.deepEqual(query.tags, ["a", "b", "c"]);
  assert.equal(query.sort, "discussed");
});

test("bad values are dropped, not trusted", () => {
  const query = parseBrowseParams({
    hull: "12; DROP TABLE fits",
    class: "Frig ate!",
    role: "x".repeat(200),
    tag: ["ok", "bad tag!", "x".repeat(50), "UPPER"],
    author: "a".repeat(300),
    current: "yes",
    sort: "hottest",
  });
  assert.equal(query.hull, undefined);
  assert.equal(query.hullClass, undefined);
  assert.equal(query.role, undefined);
  assert.deepEqual(query.tags, ["ok", "upper"]);
  assert.equal(query.author, undefined);
  assert.equal(query.currentBuild, false);
  assert.equal(query.sort, "top-week");
});

test("tags are deduplicated and capped", () => {
  const query = parseBrowseParams({ tag: Array.from({ length: 30 }, (_, i) => `t${i % 12}`) });
  assert.equal(new Set(query.tags).size, query.tags.length);
  assert.ok(query.tags.length <= 8);
});

test("toBrowseSearch round-trips and omits defaults", () => {
  assert.equal(toBrowseSearch({ sort: "top-week", tags: [], currentBuild: false }), "");
  const query = {
    hull: "99",
    hullClass: "Cruiser",
    role: "Tank",
    tags: ["pvp", "budget"],
    author: "user_1",
    currentBuild: true,
    sort: "top-all",
  };
  assert.deepEqual(parseBrowseParams(new URLSearchParams(toBrowseSearch(query))), query);
});

test("cursors round-trip and bind to the sort they were made for", () => {
  const cursor = { sort: "top-all", score: 7, at: "2026-10-13 10:00:00.123456+00", id: "abc123DEF4" };
  const text = encodeCursor(cursor);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(text, "top-all"), cursor);
  assert.equal(decodeCursor(text, "new"), undefined);
});

test("a top-week cursor carries the moment its week counts back from", () => {
  const cursor = { sort: "top-week", score: 2, at: "2026-10-13 10:00:00+00", id: "abc123DEF4", now: "2026-10-14T12:00:00.000Z" };
  assert.deepEqual(decodeCursor(encodeCursor(cursor), "top-week"), cursor);
  const { now: _now, ...without } = cursor;
  assert.equal(decodeCursor(encodeCursor(without), "top-week"), undefined);
  assert.equal(decodeCursor(encodeCursor({ ...cursor, now: "last week" }), "top-week"), undefined);
});

test("a cursor's fields are checked before they reach the database", () => {
  const good = { sort: "new", score: 0, at: "2026-10-13 10:00:00.5+05:30", id: "abc123DEF4" };
  assert.deepEqual(decodeCursor(encodeCursor(good), "new"), good);
  for (const bad of [
    { at: "2026-10-13T10:00:00Z" },
    { at: "2026-13-01 10:00:00+00" },
    { at: "2026-02-30 10:00:00+00" },
    { at: "2026-10-13 24:00:00+00" },
    { score: 2_147_483_648 },
    { score: -1 },
    { score: 1.5 },
    { id: "short" },
    { id: "abc123DEF4'" },
  ]) {
    assert.equal(decodeCursor(encodeCursor({ ...good, ...bad }), "new"), undefined, JSON.stringify(bad));
  }
});

test("cursors are made without Node's Buffer, so client code can load filters.ts", () => {
  const text = encodeCursor({ sort: "new", score: 0, at: "2026-10-13 10:00:00+00", id: "ÅbcdefghiJ" });
  assert.equal(Buffer.from(text, "base64url").toString("utf8").includes("ÅbcdefghiJ"), true);
});

test("garbage cursors are ignored", () => {
  assert.equal(decodeCursor("not a cursor", "new"), undefined);
  assert.equal(decodeCursor("", "new"), undefined);
  assert.equal(decodeCursor(Buffer.from('{"sort":"new","score":"x"}').toString("base64url"), "new"), undefined);
  assert.equal(decodeCursor(Buffer.from("[1,2]").toString("base64url"), "new"), undefined);
});
