"use client";

// The builder: the reducer's state drawn as the game's fitting panel. The palette feeds the grid by
// drag (pointer) or by Enter and the arrow keys; while an item is held the grid lights the empty
// hardpoints it needs and shows where it would land, green where the game would take it and red, with the
// reason, where it wouldn't (placement.ts); a refused drop changes nothing. Every change is evaluated live
// by the engine, and the result draws issues, conduit links, regalia groups, stats and rating. The fit
// autosaves to this browser; saving to the site needs sign-in.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { FittingGrid, gridBounds } from "#/components/grid/fitting-grid";
import { buildGridModel, type GridModule } from "#/components/grid/model";
import { Panel, buildLabel } from "#/components/ui";
import { StatsTable } from "#/components/fit/stats-table";
import { HullSpecs } from "#/components/fit/hull-specs";
import type { EvaluationResponse } from "#/lib/engine/types";
import { useEngine } from "#/lib/engine/use-engine";
import { CopyFitString } from "#/components/fit/copy-fit-string";
import type { BuilderStart } from "#/lib/site/loaders";
import { AffinityPanel } from "./affinity-panel";
import { autosave, bootDraft, browserStorage, clearDraft, draftSlot } from "./draft-storage";
import { FitDetails, ImportFit, type BuilderAuth, type Navigate, type SavedState } from "./fit-details";
import { HullPicker } from "./hull-picker";
import { Inspector } from "./inspector";
import { enumWords, roleName } from "./labels";
import { IDLE, createLiveEvaluator, fitKey, type LiveEvaluation, type LiveEvaluator } from "./live-evaluation";
import { Palette } from "./palette";
import { dropPreview, hardpointTargets, heldDef, heldModule } from "./placement";
import type { BuilderCatalog } from "./rules";
import { initialState, reduce, type BuilderAction, type BuilderState } from "./state";


type Boot = { state: BuilderState; restored: boolean };

/** The start the server chose, or this browser's autosave of it when that is newer work on the same fit. */
function boot(start: BuilderStart): Boot {
  const draft = bootDraft(browserStorage(), start);
  return draft ? { state: initialState(draft.fit, draft.meta), restored: true } : { state: initialState(start.fit, start.meta), restored: false };
}

const snapshot = (state: Pick<BuilderState, "fit" | "meta">) => JSON.stringify({ fit: state.fit, meta: state.meta });

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

const onControl = (target: EventTarget | null) =>
  target instanceof HTMLElement && target.closest("button, a, input, select, textarea, [contenteditable]") !== null;
const isPaletteItem = (target: EventTarget | null) => target instanceof HTMLElement && target.closest("[data-palette-item]") !== null;

type Drag = { mode: "palette" | "module"; index?: number } | { mode: "pending"; index: number; x: number; y: number; cell: { row: number; col: number } | null };

export function Workspace({ cat, start, auth, navigate }: { cat: BuilderCatalog; start: BuilderStart; auth: BuilderAuth; navigate: Navigate }) {
  const engine = useEngine();
  const [{ state: bootState, restored }] = useState(() => boot(start));
  const [state, dispatch] = useReducer((current: BuilderState, action: BuilderAction) => reduce(cat, current, action), bootState);
  const [saved, setSaved] = useState<SavedState>({ fitId: start.fitId, status: start.status, updatedAt: start.updatedAt });
  const [clean, setClean] = useState(() => snapshot(start));
  const [notice, setNotice] = useState<string | null>(restored ? "RESTORED THE UNSAVED CHANGES KEPT IN THIS BROWSER." : start.note);
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // The fit this one was copied from, credited on its first save. Importing a fit string or starting over
  // replaces what was copied, so either one drops the credit.
  const [copiedFrom, setCopiedFrom] = useState(start.copiedFrom);
  const [ghost, setGhost] = useState<{ x: number; y: number; name: string } | null>(null);

  const fit = state.fit;
  const current = snapshot(state);
  const dirty = current !== clean;
  // The slot this session autosaves to: the unsaved one until the first save, then the fit's own.
  const [unsavedSlot] = useState(() => draftSlot(start.fitId, start.copiedFrom?.id ?? null));
  const slot = saved.fitId ?? unsavedSlot;

  // ---- Autosave to this browser ---------------------------------------------------------------
  useEffect(() => {
    const timer = setTimeout(() => autosave(browserStorage(), slot, { fit, meta: state.meta, dirty, base: saved.updatedAt }), 400);
    return () => clearTimeout(timer);
  }, [fit, state.meta, dirty, saved, slot]);

  // ---- Live evaluation --------------------------------------------------------------------------
  const [evaluation, setEvaluation] = useState<LiveEvaluation>(IDLE);
  const evaluator = useRef<LiveEvaluator | null>(null);
  useEffect(() => {
    const created = createLiveEvaluator({ evaluate: (sent, signal) => engine.evaluate(sent, { signal }), onChange: setEvaluation });
    evaluator.current = created;
    return () => created.dispose();
  }, [engine]);
  useEffect(() => {
    evaluator.current?.request(fit);
  }, [fit, engine]);
  const key = useMemo(() => (fit ? fitKey(fit) : null), [fit]);
  const result = evaluation.result && evaluation.result.key === key ? evaluation.result.response : null;

  // ---- The grid ---------------------------------------------------------------------------------
  const hull = fit ? cat.hulls.get(fit.hull.def) : undefined;
  const model = useMemo(
    () =>
      fit && hull
        ? buildGridModel({ hull, items: cat.items, regaliaSets: cat.regaliaSets, artifacts: cat.artifacts, ciphers: cat.ciphers }, fit, result ? { issues: result.issues, conduits: result.conduits, regaliaSets: result.regaliaSets } : null)
        : null,
    [fit, hull, cat, result],
  );
  const preview = fit && state.held ? dropPreview(cat, fit, state.held) : null;
  const held = state.held;
  const heldItem = fit && held ? heldDef(fit, held) : null;
  const targets = useMemo(() => (fit && held && heldItem ? hardpointTargets(cat, fit, heldItem, heldModule(held)) : []), [cat, fit, held, heldItem]);
  const moduleName = useCallback((index: number) => (model?.modules[index]?.name ?? null), [model]);

  const gridRef = useRef<HTMLDivElement>(null);
  const live = useRef({ model, held: state.held, selected: state.selected, drag: null as Drag | null });
  live.current.model = model;
  live.current.held = state.held;
  live.current.selected = state.selected;

  const cellAt = useCallback((x: number, y: number) => {
    const element = gridRef.current?.querySelector<HTMLElement>(".fg");
    const current = live.current.model;
    if (!element || !current) return null;
    const rect = element.getBoundingClientRect();
    if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return null;
    const view = gridBounds(current, true);
    return {
      row: view.minRow + Math.floor(((y - rect.top) * view.rows) / rect.height),
      col: view.minCol + Math.floor(((x - rect.left) * view.cols) / rect.width),
    };
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = live.current.drag;
      if (!drag) return;
      if (drag.mode === "pending") {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
        live.current.drag = { mode: "module", index: drag.index };
        dispatch({ type: "pickUpModule", index: drag.index, cell: drag.cell ?? undefined });
        setGhost({ x: event.clientX, y: event.clientY, name: live.current.model?.modules[drag.index]?.name ?? "" });
      }
      dispatch({ type: "hover", cell: cellAt(event.clientX, event.clientY) });
      setGhost((ghost) => (ghost ? { ...ghost, x: event.clientX, y: event.clientY } : ghost));
    };
    const up = () => {
      const drag = live.current.drag;
      live.current.drag = null;
      setGhost(null);
      if (drag && drag.mode !== "pending") dispatch({ type: "release" });
    };
    const cancel = () => {
      if (live.current.drag && live.current.drag.mode !== "pending") dispatch({ type: "cancel" });
      live.current.drag = null;
      setGhost(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [cellAt]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      // On a control, these keys are the control's own (press, delete text): never remove or drop.
      // A palette item is the exception for Enter and Space, which place what it put in hand.
      if (onControl(event.target) && ["Backspace", "Delete", " ", "Enter"].includes(event.key) && !(isPaletteItem(event.target) && event.key !== "Backspace" && event.key !== "Delete")) return;
      const held = live.current.held;
      const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (event.key === "r" || event.key === "R") {
        dispatch({ type: "rotate" });
        event.preventDefault();
      } else if (event.key === "Escape") {
        dispatch({ type: "cancel" });
      } else if (held && arrows[event.key]) {
        const [rows, cols] = arrows[event.key]!;
        dispatch({ type: "moveCursor", rows, cols });
        event.preventDefault();
      } else if (held && (event.key === "Enter" || event.key === " ")) {
        dispatch({ type: "drop" });
        event.preventDefault();
      } else if (!held && event.key === "Enter" && event.target instanceof HTMLElement && event.target.dataset.module) {
        dispatch({ type: "pickUpModule", index: Number(event.target.dataset.module) });
        event.preventDefault();
      } else if (!held && (event.key === "Delete" || event.key === "Backspace") && typeof live.current.selected === "number") {
        dispatch({ type: "remove", index: live.current.selected });
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const onPalettePointer = (def: string, event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    live.current.drag = { mode: "palette" };
    dispatch({ type: "pickUp", def });
    setGhost({ x: event.clientX, y: event.clientY, name: cat.items.get(def)?.name ?? "" });
  };
  const onModulePointerDown = (module: GridModule, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || state.held) return;
    dispatch({ type: "select", target: module.index });
    live.current.drag = { mode: "pending", index: module.index, x: event.clientX, y: event.clientY, cell: cellAt(event.clientX, event.clientY) };
  };

  // ---- Starting points --------------------------------------------------------------------------
  const startOver = () => {
    if (!confirmReset) return setConfirmReset(true);
    setConfirmReset(false);
    clearDraft(browserStorage(), slot);
    setCopiedFrom(null);
    dispatch({ type: "reset" });
  };
  const onImported = (imported: typeof fit) => {
    if (!imported) return;
    dispatch({ type: "load", fit: imported });
    setCopiedFrom(null);
    setImporting(false);
    setNotice("FIT STRING IMPORTED.");
  };

  if (!fit || picking || !hull) {
    return (
      <main className="page builder">
        <BuilderTitle title={fit ? state.meta.title || "NEW FIT" : "NEW FIT"} eyebrow="FIT BUILDER" />
        {notice && <p className="banner banner--quiet">{notice}</p>}
        {fit && !hull && <p className="banner">THIS FIT&apos;S HULL ISN&apos;T IN THE CURRENT BUILD. PICK ANOTHER; THE MODULES STAY.</p>}
        <div className="builder-start">
          <HullPicker
            cat={cat}
            current={fit?.hull.def ?? null}
            onPick={(def) => {
              setPicking(false);
              setNotice(null);
              dispatch(fit ? { type: "changeHull", hull: def } : { type: "start", hull: def });
            }}
            onCancel={fit && hull ? () => setPicking(false) : undefined}
          />
          {!fit && (
            <Panel title="IMPORT A FIT STRING">
              <ImportFit engine={engine} onImported={onImported} />
            </Panel>
          )}
        </div>
      </main>
    );
  }

  const status = statusOf(evaluation, result);
  return (
    <main className={`page builder ${state.held ? "builder--holding" : ""}`}>
      <BuilderTitle
        title={state.meta.title || "NEW FIT"}
        eyebrow={`${hull.name} · ${enumWords(hull.shipClass)} · ${roleName(hull.role)}`}
        actions={
          <>
            <button type="button" className="btn btn--quiet" onClick={() => setPicking(true)}>
              CHANGE HULL
            </button>
            <button type="button" className={`btn btn--quiet ${importing ? "btn--on" : ""}`} onClick={() => setImporting(!importing)} aria-expanded={importing}>
              IMPORT FIT STRING
            </button>
            <button type="button" className="btn btn--quiet" onClick={startOver} onBlur={() => setConfirmReset(false)}>
              {confirmReset ? "SURE? START OVER" : "START OVER"}
            </button>
          </>
        }
      />
      <p className="builder__narrow note">THE BUILDER IS BEST ON A WIDER SCREEN. EVERYTHING STILL WORKS HERE, ONE PANEL AFTER ANOTHER.</p>
      {notice && (
        <p className="banner banner--quiet" role="status">
          {notice}
        </p>
      )}
      {copiedFrom && (
        <p className="note">
          COPIED FROM{" "}
          <Link className="link" href={`/fits/${copiedFrom.id}`}>
            {copiedFrom.title}
          </Link>
          . SAVING MAKES A NEW FIT OF YOUR OWN.
        </p>
      )}
      {importing && (
        <Panel title="IMPORT A FIT STRING">
          <p className="note">THE IMPORTED FIT REPLACES THE ONE ON THE GRID. TITLE, DESCRIPTION AND TAGS STAY.</p>
          <ImportFit engine={engine} onImported={onImported} onCancel={() => setImporting(false)} />
        </Panel>
      )}

      <div className="builder-layout">
        <div className="builder-layout__palette">
          <Palette
            cat={cat}
            fit={fit}
            heldDef={state.held ? heldDef(fit, state.held) : null}
            holding={state.held !== null}
            onPointerPick={onPalettePointer}
            onKeyboardPick={(def) => dispatch({ type: "pickUp", def, cursor: null })}
          />
        </div>

        <div className="builder-layout__main">
          <Panel title="FIT" aside={<span className={`badge badge--${status.badge}`}>{status.label}</span>}>
            {evaluation.outage === "down" && (
              <div className="banner" role="status">
                <span>CAN&apos;T EVALUATE RIGHT NOW.</span>
                <small>THE LOADOUT ENGINE ISN&apos;T ANSWERING. EDITING STILL WORKS AND THIS FIT IS KEPT IN THIS BROWSER.</small>
              </div>
            )}
            {evaluation.outage === "limited" && (
              <div className="banner banner--quiet" role="status">
                <span>CHECKING PAUSED — TOO MANY CHECKS, RETRYING.</span>
                <small>EDITING STILL WORKS. THE LATEST CHANGE IS CHECKED WHEN THE ENGINE ALLOWS.</small>
              </div>
            )}
            {evaluation.status === "rejected" && (
              <ul className="issues">
                <li className="tone-negative">THE ENGINE CAN&apos;T READ THIS FIT: {(evaluation.message ?? "").toUpperCase()}</li>
              </ul>
            )}
            {evaluation.status === "tooLarge" && (
              <ul className="issues">
                <li className="tone-negative">THIS FIT IS TOO LARGE TO CHECK.</li>
              </ul>
            )}
            {result && result.issues.length > 0 && (
              <ul className="issues" aria-label="Issues">
                {result.issues.map((issue, i) => (
                  <li key={i} className="tone-negative">
                    {issue.moduleIndex >= 0 ? (
                      <button type="button" className="issue-link" onClick={() => dispatch({ type: "select", target: issue.moduleIndex })}>
                        {moduleName(issue.moduleIndex) ?? "MODULE"}:
                      </button>
                    ) : null}{" "}
                    {issue.message.toUpperCase()}
                  </li>
                ))}
              </ul>
            )}
            <div
              className="fg-scroll builder-grid"
              ref={gridRef}
              onFocusCapture={(event) => {
                const index = (event.target as HTMLElement).dataset.module;
                if (index !== undefined && !state.held) dispatch({ type: "select", target: Number(index) });
              }}
            >
              {model && (
                <FittingGrid
                  model={model}
                  selected={typeof state.selected === "number" ? state.selected : null}
                  highlight={targets}
                  drop={
                    preview
                      ? preview.verdict.ok
                        ? { cells: preview.verdict.cells, valid: true }
                        : { cells: preview.verdict.cells, valid: false, offending: preview.verdict.offending, reason: preview.verdict.reason }
                      : null
                  }
                  tooltip={state.held ? () => null : undefined}
                  onModulePointerDown={onModulePointerDown}
                  onModuleContextMenu={(module, event) => {
                    event.preventDefault();
                    dispatch({ type: "remove", index: module.index });
                  }}
                  onCellPointerDown={(cell, event) => {
                    if (event.button !== 0) return;
                    if (state.held && !live.current.drag) {
                      dispatch({ type: "hover", cell });
                      dispatch({ type: "drop" });
                    } else if (!state.held) dispatch({ type: "select", target: null });
                  }}
                  label={`${hull.name} fitting grid`}
                />
              )}
            </div>
            <p className="builder__keys note" aria-live="polite">
              {state.held
                ? preview
                  ? preview.verdict.ok
                    ? "RELEASE OR ENTER PLACES IT · R ROTATES · ESC CANCELS"
                    : `${preview.verdict.reason} · R ROTATES · ESC CANCELS`
                  : targets.length > 0
                    ? "MOVE ONTO A LIT HARDPOINT, OR USE THE ARROW KEYS · ESC CANCELS"
                    : "MOVE ONTO THE GRID, OR USE THE ARROW KEYS · ESC CANCELS"
                : "DRAG TO PLACE OR MOVE · R ROTATES · DELETE OR RIGHT-CLICK REMOVES · ENTER ON A MODULE PICKS IT UP"}
            </p>
          </Panel>
          <AffinityPanel cat={cat} progression={fit.progression} dispatch={dispatch} />
        </div>

        <div className="builder-layout__side">
          <Inspector cat={cat} fit={fit} target={state.selected} dispatch={dispatch} />
          <StatsPanel cat={cat} evaluation={evaluation} result={result} moduleName={moduleName} />
          <FitDetails
            fit={fit}
            meta={state.meta}
            dispatch={dispatch}
            auth={auth}
            forkedFrom={copiedFrom?.id ?? null}
            saved={saved}
            dirty={dirty}
            moduleName={moduleName}
            onSaved={(next) => {
              if (saved.fitId === null) clearDraft(browserStorage(), unsavedSlot);
              setSaved(next);
              setClean(current);
            }}
            navigate={navigate}
          />
          <Panel title="FIT STRING">
            <CopyFitString fit={fit} label="EXPORT FIT STRING" quiet />
          </Panel>
        </div>
      </div>
      {ghost && (
        <div className="drag-ghost" style={{ left: ghost.x + 14, top: ghost.y + 10 }} aria-hidden="true">
          {ghost.name}
        </div>
      )}
    </main>
  );
}

function BuilderTitle({ title, eyebrow, actions }: { title: string; eyebrow: string; actions?: ReactNode }) {
  return (
    <div className="page-title builder__title">
      <div className="flex flex-col gap-1">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      {actions && <div className="builder__actions">{actions}</div>}
    </div>
  );
}

function statusOf(evaluation: LiveEvaluation, result: { valid: boolean } | null): { label: string; badge: string } {
  if (evaluation.outage === "down") return { label: "CAN'T EVALUATE RIGHT NOW", badge: "outdated" };
  if (evaluation.outage === "limited") return { label: "CHECKING PAUSED", badge: "pending" };
  if (evaluation.status === "rejected") return { label: "UNREADABLE", badge: "invalid" };
  if (evaluation.status === "tooLarge") return { label: "TOO LARGE TO CHECK", badge: "invalid" };
  if (result) return result.valid ? { label: "VALID", badge: "current" } : { label: "NOT VALID", badge: "invalid" };
  return { label: "CHECKING", badge: "pending" };
}

function StatsPanel({
  cat,
  evaluation,
  result,
  moduleName,
}: {
  cat: BuilderCatalog;
  evaluation: LiveEvaluation;
  result: EvaluationResponse | null;
  moduleName: (index: number) => string | null;
}) {
  const shown = result ?? evaluation.result?.response ?? null;
  const stale = shown !== null && result === null;
  return (
    <Panel
      title="HULL SPECS"
      className={stale ? "stats-panel--stale" : undefined}
      aside={
        shown ? (
          shown.valid ? (
            <span className="rating">
              {stale ? "LAST CHECK · " : ""}RATING {shown.rating}
            </span>
          ) : (
            <span className="tone-negative">NO RATING</span>
          )
        ) : undefined
      }
    >
      {evaluation.outage === "down" && <p className="note note--error">CAN&apos;T EVALUATE RIGHT NOW. STATS RETURN WHEN THE LOADOUT ENGINE DOES.</p>}
      {evaluation.outage === "limited" && <p className="note">CHECKING PAUSED — TOO MANY CHECKS, RETRYING.</p>}
      {!shown ? (
        <p className="note">{evaluation.outage ? "NO STATS YET." : "CHECKING THE FIT."}</p>
      ) : (
        <>
          {stale && !evaluation.outage && <p className="note">UPDATING</p>}
          {shown.valid ? null : <p className="note">AN INVALID FIT HAS NO STATS OR RATING. FIX THE ISSUES ON THE GRID.</p>}
          {shown.valid && Array.isArray(shown.sections) && shown.sections.length > 0 && <HullSpecs sections={shown.sections} />}
          {shown.valid && <div className="stats-panel__heading">MODIFIERS</div>}
          {shown.regaliaSets.length > 0 && (
            <ul className="set-list" aria-label="Regalia sets">
              {shown.regaliaSets.map((group) => {
                const set = cat.regaliaSets.get(group.set);
                return (
                  <li key={group.set} className="plate__row">
                    <span className="accent-regalia">{(set?.name ?? "REGALIA SET").toUpperCase()}</span>
                    <b className="accent-regalia">
                      {group.fittedCount}/{set?.pieces ?? group.fittedCount}
                    </b>
                  </li>
                );
              })}
            </ul>
          )}
          {shown.conduits.length > 0 && (
            <ul className="set-list" aria-label="Conduit links">
              {shown.conduits.map((link) => (
                <li key={link.moduleIndex} className="plate__row">
                  <span>{moduleName(link.moduleIndex) ?? "CONDUIT"}</span>
                  <b>x{link.connectionCount}</b>
                </li>
              ))}
            </ul>
          )}
          <StatsTable stats={shown.stats} catalog={cat.catalog} />
          <span className="note">{buildLabel(shown.buildSha)}</span>
        </>
      )}
    </Panel>
  );
}
