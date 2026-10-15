import assert from "node:assert/strict";
import test from "node:test";
import { shownEvaluation, standingOf } from "./standing.ts";

const verdict = (buildSha, valid, extra = {}) => ({ buildSha, valid, rating: valid ? 100 : null, stats: { stats: [{ stat: "Mass" }], conduits: [], regaliaSets: [] }, issues: [], evaluatedAt: "2026-10-13T00:00:00Z", ...extra });

test("a fit stands on the current build by its verdict for that build", () => {
  assert.equal(standingOf({ evaluation: verdict("new", true), lastValidEvaluation: verdict("new", true) }, "new"), "current");
  assert.equal(standingOf({ evaluation: verdict("new", false), lastValidEvaluation: verdict("old", true) }, "new"), "outdated");
  assert.equal(standingOf({ evaluation: verdict("new", false), lastValidEvaluation: null }, "new"), "invalid");
  assert.equal(standingOf({ evaluation: null, lastValidEvaluation: verdict("old", true) }, "new"), "pending", "not yet re-evaluated is not outdated");
  assert.equal(standingOf({ evaluation: verdict("old", true), lastValidEvaluation: verdict("old", true) }, "new"), "pending", "another build's verdict doesn't count");
  assert.equal(standingOf({ evaluation: null, lastValidEvaluation: verdict("old", true) }, null), "unknown");
});

test("an outdated fit shows its last valid stats and the current build's issues", () => {
  const issues = [{ moduleIndex: 2, kind: "UnknownItem", message: "gone" }];
  const shown = shownEvaluation({ evaluation: verdict("new", false, { issues, stats: { stats: [], conduits: [], regaliaSets: [] } }), lastValidEvaluation: verdict("old", true) }, "new");
  assert.equal(shown.standing, "outdated");
  assert.equal(shown.reference.buildSha, "old");
  assert.equal(shown.referenceIsOld, true);
  assert.deepEqual(shown.issues, issues);
  assert.equal(shown.result.stats.length, 1);
});

test("odd stored rows read as empty, never throw", () => {
  const shown = shownEvaluation({ evaluation: verdict("new", true, { stats: "nonsense", issues: null }), lastValidEvaluation: null }, "new");
  assert.deepEqual(shown.result, { stats: [], conduits: [], regaliaSets: [], sections: null, modifierGroups: null });
  assert.deepEqual(shown.issues, []);
});

test("stored hull specs come back; a row from before the engine sent them reads as null, not empty", () => {
  const sections = [{ id: "defense", label: "DEFENSE", rows: [] }];
  const withSpecs = shownEvaluation({ evaluation: verdict("new", true, { stats: { stats: [], conduits: [], regaliaSets: [], sections } }), lastValidEvaluation: null }, "new");
  assert.deepEqual(withSpecs.result.sections, sections);
  const older = shownEvaluation({ evaluation: verdict("new", true), lastValidEvaluation: null }, "new");
  assert.equal(older.result.sections, null);
});

test("stored modifier groups come back; a row from before the engine sent them reads as null, not empty", () => {
  const modifierGroups = [{ category: "Agility", label: "AGILITY", rows: [] }];
  const withGroups = shownEvaluation({ evaluation: verdict("new", true, { stats: { stats: [], conduits: [], regaliaSets: [], modifierGroups } }), lastValidEvaluation: null }, "new");
  assert.deepEqual(withGroups.result.modifierGroups, modifierGroups);
  const older = shownEvaluation({ evaluation: verdict("new", true), lastValidEvaluation: null }, "new");
  assert.equal(older.result.modifierGroups, null);
  const unsent = shownEvaluation({ evaluation: verdict("new", true, { stats: { stats: [], conduits: [], regaliaSets: [], modifierGroups: null } }), lastValidEvaluation: null }, "new");
  assert.equal(unsent.result.modifierGroups, null);
});
