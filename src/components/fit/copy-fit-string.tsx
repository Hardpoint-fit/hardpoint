"use client";

// Turns an open fit into a fit string through the public engine, from the browser, and puts it on the
// clipboard (or shows it to copy by hand). The engine's per-client limit is the only limit on it: the
// site's server never makes fit strings for a browser.
import { useState, useTransition } from "react";
import type { EngineError } from "#/lib/engine/client";
import type { OpenFit } from "#/lib/engine/types";
import { useEngine } from "#/lib/engine/use-engine";
import { slowDownMessage } from "#/lib/slow-down";

export const ENGINE_DOWN_FOR_STRINGS = "THE LOADOUT ENGINE CAN'T BE REACHED, SO FIT STRINGS CAN'T BE MADE OR READ RIGHT NOW.";

/** What to show when the engine didn't turn a fit or a string around; `refused` words a 400. */
export function fitStringProblem(error: EngineError, refused: string): string {
  if (error.kind === "rejected") return `${refused}: ${error.message.toUpperCase()}`;
  if (error.kind === "rateLimited") return slowDownMessage(error.retryAfterMs ?? 1_000);
  if (error.kind === "tooLarge") return "THIS FIT IS TOO LARGE FOR A FIT STRING.";
  return ENGINE_DOWN_FOR_STRINGS;
}

export function CopyFitString({ fit, label, quiet = false }: { fit: OpenFit; label: string; quiet?: boolean }) {
  const engine = useEngine();
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      setProblem(null);
      const result = await engine.exportFitString(fit);
      if (!result.ok) return setProblem(fitStringProblem(result.error, "THE ENGINE CAN'T EXPORT THIS FIT"));
      try {
        await navigator.clipboard.writeText(result.value.fitString);
        setCopied(true);
        setShown(null);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // No clipboard permission: show it to copy by hand.
        setShown(result.value.fitString);
      }
    });
  return (
    <span className="flex flex-col gap-2">
      <span className="flex flex-wrap items-center gap-2">
        <button type="button" className={quiet ? "btn btn--quiet" : "btn"} onClick={run} disabled={pending}>
          {pending ? "EXPORTING" : copied ? "COPIED" : label}
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
