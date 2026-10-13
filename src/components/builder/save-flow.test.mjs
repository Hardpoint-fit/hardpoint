// Saving and publishing from the builder: the first save of a new fit moves the address in place, so a
// publish refusal and its issues stay on screen (the builder isn't remounted).
import assert from "node:assert/strict";
import test from "node:test";
import { inPlaceNavigate, publishFlow, saveFlow } from "./save-flow.ts";

const NEW = { fitId: null, status: null, updatedAt: null };
const savedFit = { fitId: "Abc1234567", status: "draft", updatedAt: "2026-10-13T10:00:00Z", evaluation: "stored" };
const overlap = [{ moduleIndex: 1, kind: "Overlap", message: "This item overlaps another." }];

function recorder({ save = { ok: true, fit: savedFit }, publish = { ok: true, fitId: savedFit.fitId } } = {}) {
  const log = [];
  return {
    log,
    steps: (saved = NEW, dirty = true) => ({
      saved,
      dirty,
      save: async (fitId) => (log.push(["save", fitId]), save),
      publish: async (fitId) => (log.push(["publish", fitId]), publish),
      onSaved: (next) => log.push(["saved", next.fitId]),
      navigate: { replace: (url) => log.push(["replace", url]), push: (url) => log.push(["push", url]) },
    }),
  };
}

test("publishing a new fit: saved, address moved in place, refusal and issues returned to show", async () => {
  const refusal = { ok: false, reason: "invalid_fit", status: 409, message: "This fit doesn't pass validation, so it can't be published.", issues: overlap };
  const { log, steps } = recorder({ publish: refusal });
  const result = await publishFlow(steps());
  assert.deepEqual(log, [["save", null], ["saved", "Abc1234567"], ["replace", "/fits/Abc1234567/edit"], ["publish", "Abc1234567"]]);
  assert.deepEqual(result.problem, { message: refusal.message, issues: overlap });
  assert.equal(result.notice, "SAVED.", "the save's notice survives too");
});

test("a saved, unchanged fit publishes without saving and leaves for its page", async () => {
  const { log, steps } = recorder();
  const result = await publishFlow(steps({ fitId: "Abc1234567", status: "draft", updatedAt: "x" }, false));
  assert.deepEqual(log, [["publish", "Abc1234567"], ["push", "/fits/Abc1234567"]]);
  assert.deepEqual(result, { problem: null, notice: null });
});

test("a save refusal stops the publish; a save of a saved fit doesn't move the address", async () => {
  const { log, steps } = recorder({ save: { ok: false, reason: "auth_unavailable", status: 503, message: "Sign-in isn't configured on this site yet" } });
  const result = await publishFlow(steps());
  assert.deepEqual(log, [["save", null]]);
  assert.equal(result.problem.message, "Sign-in isn't configured on this site yet");
  const again = recorder({ save: { ok: true, fit: { ...savedFit, evaluation: "skipped" } } });
  const saved = await saveFlow(again.steps({ fitId: "Abc1234567", status: "draft", updatedAt: "x" }));
  assert.deepEqual(again.log, [["save", "Abc1234567"], ["saved", "Abc1234567"]]);
  assert.match(saved.notice, /COULDN'T CHECK IT/);
});

test("in-place navigation replaces the address through history, not the router", () => {
  const calls = [];
  const navigate = inPlaceNavigate({ push: (url) => calls.push(["router.push", url]) }, { replaceState: (_state, _title, url) => calls.push(["history.replaceState", url]) });
  navigate.replace("/fits/Abc1234567/edit");
  navigate.push("/fits/Abc1234567");
  assert.deepEqual(calls, [["history.replaceState", "/fits/Abc1234567/edit"], ["router.push", "/fits/Abc1234567"]]);
});
