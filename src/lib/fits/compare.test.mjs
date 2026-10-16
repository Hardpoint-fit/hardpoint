import assert from "node:assert/strict";
import test from "node:test";
import { alignSections, compareHref, countModules, diffModules, parseFitRef } from "./compare.ts";

const row = (id, text, unit = "", label = id.toUpperCase()) => ({
  id,
  label,
  primary: { text, unit, number: null },
  secondary: null,
  primaryTone: "Neutral",
  secondaryTone: "Neutral",
  help: { title: "", text: "", statLabel: null, statValue: null },
});
const section = (id, ...rows) => ({ id, label: id.toUpperCase(), rows });

test("a fit id is read from a bare id, a full link, a path or text around it, and nothing else", () => {
  assert.equal(parseFitRef("  abcDEF1234 "), "abcDEF1234");
  assert.equal(parseFitRef("https://hardpoint.fit/fits/abcDEF1234"), "abcDEF1234");
  assert.equal(parseFitRef("/fits/abcDEF1234?rev=2#comment-x"), "abcDEF1234");
  assert.equal(parseFitRef("look at https://hardpoint.fit/fits/abcDEF1234/edit now"), "abcDEF1234");
  assert.equal(parseFitRef("/fits/new"), null);
  assert.equal(parseFitRef("/fits/abcDEF12345678"), null, "longer than an id");
  assert.equal(parseFitRef("abc"), null);
  assert.equal(parseFitRef(""), null);
  assert.equal(compareHref("aaaaaaaaaa", "bbbbbbbbbb"), "/compare?a=aaaaaaaaaa&b=bbbbbbbbbb");
  assert.equal(compareHref("aaaaaaaaaa"), "/compare?a=aaaaaaaaaa");
});

test("sections line up by section and row id; differing values and missing rows are marked", () => {
  const a = [section("defense", row("hull", "100", "HP"), row("shield", "50", "HP")), section("offense", row("dps", "30"))];
  const b = [section("defense", row("hull", "120", "HP"), row("shield", "50", "HP")), section("agility", row("speed", "9", "m/s")), section("offense", row("dps", "30"), row("range", "5", "km"))];
  const aligned = alignSections(a, b);
  assert.deepEqual(aligned.map((s) => s.id), ["defense", "offense", "agility"]);
  const [defense, offense, agility] = aligned;
  assert.deepEqual(defense.rows.map((r) => [r.id, r.differs]), [["hull", true], ["shield", false]]);
  assert.deepEqual(offense.rows.map((r) => [r.id, r.differs, r.a === null, r.b === null]), [["dps", false, false, false], ["range", true, true, false]]);
  assert.deepEqual(agility.rows.map((r) => [r.a, r.b !== null, r.differs]), [[null, true, true]]);
});

test("a comparison row is judged by the stat now, and a side without sections marks nothing", () => {
  const now = { ...row("x", "1"), primary: { text: "5", unit: "", number: 5 }, secondary: { text: "7", unit: "m", number: 7 } };
  const [s] = alignSections([section("s", now)], [section("s", row("x", "7", "m"))]);
  assert.equal(s.rows[0].differs, false);
  const [none] = alignSections([section("s", row("x", "1"))], null);
  assert.deepEqual(none.rows.map((r) => [r.differs, r.b]), [[false, null]]);
  assert.deepEqual(alignSections(null, null), []);
});

test("modules split into only-in-A, only-in-B and both, with counts", () => {
  const name = (def) => ({ 1: "Zeta", 2: "Alpha", 3: "Mid", 4: "Mid" })[def] ?? "?";
  const a = countModules(["1", "2", "2", "3"], name);
  const b = countModules(["2", "3", "3", "4"], name);
  assert.deepEqual(a.map((m) => [m.name, m.count]), [["Alpha", 2], ["Mid", 1], ["Zeta", 1]]);
  const diff = diffModules(a, b);
  assert.deepEqual(diff.onlyA.map((m) => [m.def, m.a, m.b]), [["1", 1, 0]]);
  assert.deepEqual(diff.onlyB.map((m) => [m.def, m.a, m.b]), [["4", 0, 1]]);
  assert.deepEqual(diff.both.map((m) => [m.def, m.a, m.b]), [["2", 2, 1], ["3", 1, 2]]);
  assert.deepEqual(diffModules([], []), { onlyA: [], onlyB: [], both: [] });
});
