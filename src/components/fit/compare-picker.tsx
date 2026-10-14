"use client";

// Chooses the second fit of a comparison: paste a fit link or id, or pick from the pilot's bookmarks and own
// fits (signed in only; the lists are fetched when the picker opens, so a fit page doesn't pay for them).
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { compareChoicesAction } from "#/app/actions";
import type { CompareChoice } from "#/lib/site/actions-core";
import { compareHref, parseFitRef } from "#/lib/fits/compare";

type Choices = { bookmarks: CompareChoice[]; mine: CompareChoice[] };

function ChoiceList({ title, choices, onPick }: { title: string; choices: CompareChoice[]; onPick: (id: string) => void }) {
  if (choices.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="note">{title}</span>
      <ul className="compare-picker__list">
        {choices.map((choice) => (
          <li key={choice.id}>
            <button type="button" onClick={() => onPick(choice.id)}>
              {choice.title}
              {choice.status !== "published" ? ` · ${choice.status.toUpperCase()}` : ""}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The picker itself, always open: the compare page uses it directly, the fit page behind ComparePicker. */
export function ComparePickerForm({ a, signedIn }: { a: string; signedIn: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    compareChoicesAction()
      .then((result) => live && result.ok && setChoices({ bookmarks: result.bookmarks, mine: result.mine }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [signedIn]);
  const go = (b: string) => router.push(compareHref(a, b));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const id = parseFitRef(text);
    if (id) go(id);
    else setProblem("PASTE A FIT LINK OR A FIT ID.");
  };
  return (
    <div className="compare-picker">
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <label className="field">
          FIT LINK OR ID
          <input
            className="input"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setProblem(null);
            }}
            maxLength={500}
            placeholder="/fits/…"
            spellCheck={false}
          />
        </label>
        <button type="submit" className="btn" disabled={text.trim() === ""}>
          COMPARE
        </button>
      </form>
      {problem && (
        <span className="note note--error" role="alert">
          {problem}
        </span>
      )}
      {choices && (
        <>
          <ChoiceList title="YOUR BOOKMARKS" choices={choices.bookmarks} onPick={go} />
          <ChoiceList title="YOUR FITS" choices={choices.mine} onPick={go} />
        </>
      )}
    </div>
  );
}

/** The fit page's COMPARE button: opens the picker in place. */
export function ComparePicker({ fitId, signedIn }: { fitId: string; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className="btn btn--quiet" onClick={() => setOpen(true)}>
        COMPARE
      </button>
    );
  return (
    <div className="flex w-full flex-col gap-2">
      <ComparePickerForm a={fitId} signedIn={signedIn} />
      <button type="button" className="btn btn--quiet self-start" onClick={() => setOpen(false)}>
        CANCEL
      </button>
    </div>
  );
}
