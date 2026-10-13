"use client";

// The fit's title, description and tags (the form a saved fit is edited with), saving and publishing
// through the server actions, and the fit string in and out through the engine.
import { useState, useTransition, type Dispatch } from "react";
import { publishFitAction, saveFitAction } from "#/app/actions";
import type { EngineClient } from "#/lib/engine/client";
import { isEditableFit } from "#/lib/engine/open-fit";
import type { EvaluationIssue, OpenFit } from "#/lib/engine/types";
import { MAX_TAGS, normalizeTags } from "#/lib/fits/filters";
import { DESCRIPTION_MAX, TITLE_MAX } from "#/lib/fits/limits";
import { NotConfigured, Panel } from "#/components/ui";
import { normalizeFitString } from "./fit-string";
import type { BuilderAction, FitMeta } from "./state";

export type BuilderAuth = { enabled: boolean; signedIn: boolean };

/** Where the builder goes after a save or a publish (the app router, or a stand-in in tests). */
export type Navigate = { replace(url: string): void; push(url: string): void };

export type SavedState = { fitId: string | null; status: "draft" | "published" | "hidden" | null; updatedAt: string | null };

type Problem = { message: string; issues?: EvaluationIssue[] } | null;

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

const ENGINE_DOWN_FOR_STRINGS = "THE LOADOUT ENGINE CAN'T BE REACHED, SO FIT STRINGS CAN'T BE MADE OR READ RIGHT NOW.";

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
      if (!result.ok) return setProblem(result.error.kind === "rejected" ? `THAT ISN'T A FIT STRING THE ENGINE CAN READ: ${result.error.message.toUpperCase()}` : ENGINE_DOWN_FOR_STRINGS);
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

export function ExportFit({ engine, fit }: { engine: EngineClient; fit: OpenFit }) {
  const [label, setLabel] = useState("EXPORT FIT STRING");
  const [shown, setShown] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      setProblem(null);
      const result = await engine.exportFitString(fit);
      if (!result.ok) return setProblem(result.error.kind === "rejected" ? `THE ENGINE CAN'T EXPORT THIS FIT: ${result.error.message.toUpperCase()}` : ENGINE_DOWN_FOR_STRINGS);
      try {
        await navigator.clipboard.writeText(result.value.fitString);
        setLabel("COPIED");
        setShown(null);
        setTimeout(() => setLabel("EXPORT FIT STRING"), 2000);
      } catch {
        setShown(result.value.fitString);
      }
    });
  return (
    <span className="flex flex-col gap-2">
      <span className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn--quiet" onClick={run} disabled={pending}>
          {pending ? "EXPORTING" : label}
        </button>
        <span className="note">PASTE IT INTO THE FITTING PANEL IN GAME</span>
      </span>
      {shown && <input className="input w-full normal-case" readOnly value={shown} onFocus={(event) => event.currentTarget.select()} aria-label="Fit string" />}
      {problem && (
        <span className="note note--error" role="alert">
          {problem}
        </span>
      )}
    </span>
  );
}

export function FitDetails({
  fit,
  meta,
  dispatch,
  auth,
  saved,
  dirty,
  buildSha,
  moduleName,
  onSaved,
  navigate,
}: {
  fit: OpenFit;
  meta: FitMeta;
  dispatch: Dispatch<BuilderAction>;
  auth: BuilderAuth;
  saved: SavedState;
  dirty: boolean;
  buildSha: string | null;
  moduleName: (index: number) => string | null;
  /** After a save: the new saved state (and the snapshot that is now clean). */
  onSaved: (saved: SavedState) => void;
  navigate: Navigate;
}) {
  const [tagText, setTagText] = useState(meta.tags.join(", "));
  const [problem, setProblem] = useState<Problem>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const published = saved.status === "published";

  const save = async (): Promise<SavedState | null> => {
    const result = await saveFitAction(saved.fitId, meta, fit, buildSha);
    if (!result.ok) {
      setProblem({ message: result.message, issues: result.issues });
      return null;
    }
    const next: SavedState = { fitId: result.fit.fitId, status: result.fit.status, updatedAt: result.fit.updatedAt };
    onSaved(next);
    setNotice(result.fit.evaluation === "skipped" ? "SAVED. THE ENGINE COULDN'T CHECK IT; IT IS CHECKED AGAIN BEFORE PUBLISHING." : "SAVED.");
    return next;
  };

  const onSave = () =>
    start(async () => {
      setProblem(null);
      setNotice(null);
      const next = await save();
      if (next && saved.fitId === null) navigate.replace(`/fits/${next.fitId}/edit`);
    });

  const onPublish = () =>
    start(async () => {
      setProblem(null);
      setNotice(null);
      const current = dirty || saved.fitId === null ? await save() : saved;
      if (!current?.fitId) return;
      const result = await publishFitAction(current.fitId);
      if (!result.ok) {
        setNotice(null);
        setProblem({ message: result.message, issues: result.issues });
        if (saved.fitId === null) navigate.replace(`/fits/${current.fitId}/edit`);
        return;
      }
      navigate.push(`/fits/${result.fitId}`);
    });

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
