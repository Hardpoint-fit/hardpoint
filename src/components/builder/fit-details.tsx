"use client";

// The fit's title, description and tags (the form a saved fit is edited with), saving and publishing
// through the server actions, and the fit string in and out through the engine.
import { useState, useTransition, type Dispatch } from "react";
import { publishFitAction, saveFitAction } from "#/app/actions";
import { DeleteFitButton } from "#/components/fit/controls";
import type { EngineClient } from "#/lib/engine/client";
import { isEditableFit } from "#/lib/engine/open-fit";
import type { OpenFit } from "#/lib/engine/types";
import { MAX_TAGS, normalizeTags } from "#/lib/fits/filters";
import { DESCRIPTION_MAX, REVISION_NOTE_MAX, TITLE_MAX } from "#/lib/fits/limits";
import { NotConfigured, Panel } from "#/components/ui";
import { fitStringProblem } from "#/components/fit/copy-fit-string";
import { normalizeFitString } from "./fit-string";
import { publishFlow, saveFlow, type FlowResult, type Navigate, type Problem, type SavedState } from "./save-flow";
import type { BuilderAction, FitMeta } from "./state";

export type BuilderAuth = { enabled: boolean; signedIn: boolean; /** The signed-in pilot, for the page a deleted fit returns to. */ userId?: string | null };
export type { Navigate, SavedState };

export function ProblemNote({ problem, moduleName }: { problem: Problem; moduleName: (index: number) => string | null }) {
  if (!problem) return null;
  return (
    <div className="note note--error" role="alert">
      {problem.message.toUpperCase()}
      {problem.issues && problem.issues.length > 0 && (
        <ul className="issues issues--inline">
          {problem.issues.map((issue, i) => (
            <li key={i}>
              {issue.moduleIndex >= 0 ? `${moduleName(issue.moduleIndex) ?? "MODULE"}: ` : ""}
              {issue.message.toUpperCase()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Reads a pasted fit string (chat wrapping and spaces dropped) into an open fit, through the engine. */
export function ImportFit({ engine, onImported, onCancel }: { engine: EngineClient; onImported: (fit: OpenFit) => void; onCancel?: () => void }) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      setProblem(null);
      const fitString = normalizeFitString(text);
      if (!fitString) return setProblem("PASTE A FIT STRING FIRST.");
      const result = await engine.importFitString(fitString);
      if (!result.ok) return setProblem(fitStringProblem(result.error, "THAT ISN'T A FIT STRING THE ENGINE CAN READ"));
      if (!isEditableFit(result.value.fit)) return setProblem("THE ENGINE SENT A FIT THE BUILDER CAN'T OPEN.");
      setText("");
      onImported(result.value.fit);
    });
  return (
    <div className="import-fit">
      <label className="field">
        FIT STRING
        <textarea
          className="textarea textarea--code"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="CFIT1.…"
          spellCheck={false}
          aria-describedby="import-help"
        />
      </label>
      <span id="import-help" className="note">
        COPY FIT IN THE FITTING PANEL IN GAME, OR COPY FIT STRING ON A FIT PAGE. LINE BREAKS FROM CHAT ARE FINE.
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={submit} disabled={pending}>
          {pending ? "READING" : "IMPORT"}
        </button>
        {onCancel && (
          <button type="button" className="btn btn--quiet" onClick={onCancel}>
            CANCEL
          </button>
        )}
      </span>
      {problem && (
        <span className="note note--error" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}

export function FitDetails({
  fit,
  meta,
  dispatch,
  auth,
  forkedFrom,
  saved,
  dirty,
  moduleName,
  onSaved,
  navigate,
}: {
  fit: OpenFit;
  meta: FitMeta;
  dispatch: Dispatch<BuilderAction>;
  auth: BuilderAuth;
  /** The fit this one was copied from; credited by the first save only (saveFitAction ignores it for an edit). */
  forkedFrom: string | null;
  saved: SavedState;
  dirty: boolean;
  moduleName: (index: number) => string | null;
  /** After a save: the new saved state (and the snapshot that is now clean). */
  onSaved: (saved: SavedState) => void;
  navigate: Navigate;
}) {
  const [tagText, setTagText] = useState(meta.tags.join(", "));
  const [problem, setProblem] = useState<Problem>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // "What changed?" belongs to one save of a published fit (its history entry), so it is not part of the
  // fit's meta or its autosaved draft.
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const published = saved.status === "published";

  const steps = {
    saved,
    dirty,
    save: (fitId: string | null) => saveFitAction(fitId, published ? { ...meta, note } : meta, fit, fitId === null ? forkedFrom : null),
    publish: (fitId: string) => publishFitAction(fitId),
    onSaved,
    navigate,
  };
  const run = (flow: () => Promise<FlowResult>) =>
    start(async () => {
      setProblem(null);
      setNotice(null);
      const result = await flow();
      setProblem(result.problem);
      setNotice(result.notice);
      if (result.problem === null) setNote("");
    });
  const onSave = () => run(() => saveFlow(steps));
  const onPublish = () => run(() => publishFlow(steps));

  return (
    <Panel title="FIT DETAILS" aside={saved.status ? <span className={`badge badge--${saved.status}`}>{saved.status.toUpperCase()}</span> : undefined}>
      <label className="field">
        TITLE
        <input className="input" value={meta.title} maxLength={TITLE_MAX} onChange={(event) => dispatch({ type: "meta", patch: { title: event.target.value } })} placeholder="NAME THIS FIT" />
      </label>
      <label className="field">
        DESCRIPTION
        <textarea
          className="textarea textarea--tall"
          value={meta.description}
          maxLength={DESCRIPTION_MAX}
          onChange={(event) => dispatch({ type: "meta", patch: { description: event.target.value } })}
          placeholder="HOW TO FLY IT, WHAT IT BEATS"
        />
        <span className="note">MARKDOWN. {DESCRIPTION_MAX - meta.description.length} LEFT</span>
      </label>
      <label className="field">
        TAGS
        <input
          className="input"
          value={tagText}
          onChange={(event) => {
            setTagText(event.target.value);
            dispatch({ type: "meta", patch: { tags: normalizeTags([event.target.value]) } });
          }}
          placeholder="PVP, MINING"
        />
        <span className="note">UP TO {MAX_TAGS}, SEPARATED BY COMMAS: LETTERS, DIGITS AND DASHES.</span>
      </label>
      {meta.tags.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Tags">
          {meta.tags.map((tag) => (
            <span key={tag} className="chip">
              {tag.toUpperCase()}
            </span>
          ))}
        </div>
      )}
      {published && (
        <label className="field">
          WHAT CHANGED? (OPTIONAL)
          <input
            className="input"
            value={note}
            maxLength={REVISION_NOTE_MAX}
            onChange={(event) => setNote(event.target.value)}
            placeholder="SHOWN IN THIS FIT'S HISTORY"
          />
          <span className="note">{REVISION_NOTE_MAX - note.length} LEFT</span>
        </label>
      )}
      <div className="details__actions">
        {!auth.enabled ? (
          <NotConfigured />
        ) : !auth.signedIn ? (
          <span className="note">SIGN IN TO SAVE AND PUBLISH. YOUR FIT IS KEPT IN THIS BROWSER MEANWHILE.</span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn--quiet" onClick={onSave} disabled={pending || (!dirty && saved.fitId !== null)}>
              {published ? "SAVE CHANGES" : "SAVE DRAFT"}
            </button>
            {!published && (
              <button type="button" className="btn" onClick={onPublish} disabled={pending}>
                PUBLISH
              </button>
            )}
            {pending && <span className="note">WORKING</span>}
            {!pending && dirty && saved.fitId !== null && <span className="note">UNSAVED CHANGES</span>}
          </span>
        )}
        {auth.enabled && auth.signedIn && auth.userId && saved.fitId !== null && (
          <DeleteFitButton fitId={saved.fitId} then={`/u/${encodeURIComponent(auth.userId)}`} go={(url) => navigate.push(url)} />
        )}
        {published && <p className="note">CHANGES TO A PUBLISHED FIT MUST PASS THE ENGINE TO BE SAVED.</p>}
        {notice && (
          <span className="note tone-positive" role="status">
            {notice}
          </span>
        )}
        <ProblemNote problem={problem} moduleName={moduleName} />
      </div>
    </Panel>
  );
}
