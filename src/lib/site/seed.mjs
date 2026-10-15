// Fits for tests, the smoke test and local development, built from the engine fixtures through the
// data layer (never raw SQL), so they hold only what the site itself could store. Not a test file.
import { FIXTURES } from "../engine/stub-engine.mjs";
import { createComment, createFit, createReport, publishFit, recordEvaluation, setVote } from "../fits/queries.ts";
import { toEvaluationInput } from "../fits/service.ts";

export const CURRENT_SHA = FIXTURES.status.build;
/** A build before the current one, on which every seeded fit was valid. */
export const OLD_SHA = "0000000000000000000000000000000000000001";

export const ALICE = { userId: "user_alice", name: "ALICE" };
export const BOB = { userId: "user_bob", name: "BOB" };
export const ADMIN = { userId: "user_admin", name: "WARDEN" };

const at = (sha, response) => ({ ...toEvaluationInput(response), buildSha: sha });
/** A verdict stored before the engine sent hull specs or modifier groups: its stats carry neither key. */
const beforeSpecs = (verdict) => {
  const { sections, modifierGroups, ...stats } = verdict.stats;
  return { ...verdict, stats };
};

async function published(db, author, { title, description = "", tags = [], fit, verdicts }) {
  const [first, ...later] = verdicts;
  const created = await createFit(db, {
    authorUserId: author.userId,
    authorName: author.name,
    title,
    description,
    tags,
    content: { hullItem: fit.hull.def, fit },
    buildSha: first.buildSha,
    evaluation: first,
  });
  await publishFit(db, { id: created.id, authorUserId: author.userId, buildSha: first.buildSha });
  for (const verdict of later) await recordEvaluation(db, created.id, verdict);
  return created.id;
}

/**
 * Seeds:
 *  - showcase: ALICE's SCARAB, valid on the current build, two votes, a comment with a reply, a report;
 *  - removed: BOB's fit whose module 2 is an item the current build doesn't have: valid on OLD_SHA,
 *    UnknownItem on the current build (outdated);
 *  - pending: BOB's fit checked only on OLD_SHA (the current build hasn't evaluated it yet), by an
 *    engine that didn't yet send hull specs or modifier groups;
 *  - draft: ALICE's unpublished draft.
 */
export async function seedSite(db) {
  const showcase = await published(db, ALICE, {
    title: "Scarab cipher brawler",
    description: "Close in, **burn** heat, and let the turrets work.\n\n<script>alert(1)</script>\n\n[guide](https://example.com/guide)",
    tags: ["brawl", "turret"],
    fit: FIXTURES.fitShowcase,
    verdicts: [at(CURRENT_SHA, FIXTURES.evaluateShowcase)],
  });
  const removed = await published(db, BOB, {
    title: "Old build regalia runner",
    description: "Built before the patch that removed one of its modules.",
    tags: ["regalia"],
    fit: FIXTURES.fitRemovedItem,
    verdicts: [at(OLD_SHA, FIXTURES.evaluateValid), at(CURRENT_SHA, FIXTURES.evaluateRemovedItem)],
  });
  const pending = await published(db, BOB, {
    title: "Waiting on the new build",
    tags: ["turret"],
    fit: FIXTURES.fit,
    verdicts: [beforeSpecs(at(OLD_SHA, FIXTURES.evaluateValid))],
  });
  const draft = await createFit(db, {
    authorUserId: ALICE.userId,
    authorName: ALICE.name,
    title: "Unfinished idea",
    content: { hullItem: FIXTURES.fit.hull.def, fit: FIXTURES.fit },
    buildSha: CURRENT_SHA,
  });

  await setVote(db, { fitId: showcase, userId: BOB.userId, voted: true });
  await setVote(db, { fitId: showcase, userId: ALICE.userId, voted: true });
  await setVote(db, { fitId: removed, userId: ALICE.userId, voted: true });
  const comment = await createComment(db, {
    fitId: showcase,
    authorUserId: BOB.userId,
    authorName: BOB.name,
    body: "Does the **cipher** cell still fit with a second scanner?",
  });
  const reply = await createComment(db, {
    fitId: showcase,
    parentId: comment.id,
    authorUserId: ALICE.userId,
    authorName: ALICE.name,
    body: "Only if the slip coating turns.",
  });
  const fitReport = await createReport(db, { targetKind: "fit", targetId: removed, reporterUserId: ALICE.userId, reason: "Uses a removed item" });
  const commentReport = await createReport(db, { targetKind: "comment", targetId: reply.id, reporterUserId: BOB.userId, reason: "Spoiler" });
  return { showcase, removed, pending, draft: draft.id, comment: comment.id, reply: reply.id, fitReport: fitReport.id, commentReport: commentReport.id };
}
