"use client";

// The pilot page's write controls: FOLLOW / FOLLOWING and EDIT BIO. Each calls a server action and shows
// its refusal in place; the action revalidates the page, so the counts beside them refresh with it.
import { useState, useTransition, type FormEvent } from "react";
import { editBioAction, followAction } from "#/app/actions";
import { BIO_MAX } from "#/lib/fits/limits";

function Problem({ message }: { message: string | null }) {
  return message ? (
    <span className="note note--error" role="alert">
      {message}
    </span>
  ) : null;
}

export function FollowButton({ userId, following }: { userId: string; following: boolean }) {
  const [on, setOn] = useState(following);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = () =>
    start(async () => {
      setProblem(null);
      const result = await followAction(userId, !on);
      if (result.ok) setOn(result.following);
      else setProblem(result.message);
    });
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" className={`btn ${on ? "btn--on" : ""}`} onClick={toggle} disabled={pending} aria-pressed={on}>
        {on ? "FOLLOWING" : "FOLLOW"}
      </button>
      <Problem message={problem} />
    </span>
  );
}

export function EditBio({ bio }: { bio: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(bio);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open)
    return (
      <button
        type="button"
        className="btn btn--quiet"
        onClick={() => {
          setDraft(bio);
          setProblem(null);
          setOpen(true);
        }}
      >
        EDIT BIO
      </button>
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    start(async () => {
      setProblem(null);
      const result = await editBioAction(draft);
      if (result.ok) setOpen(false);
      else setProblem(result.message);
    });
  };
  return (
    <form className="flex w-full flex-col gap-2" onSubmit={submit}>
      <textarea
        className="textarea"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={BIO_MAX}
        aria-label="Bio"
        placeholder="WHAT YOU FLY AND HOW"
      />
      <span className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn" disabled={pending}>
          SAVE BIO
        </button>
        <button type="button" className="btn btn--quiet" disabled={pending} onClick={() => setOpen(false)}>
          CANCEL
        </button>
        <span className="note">PLAIN TEXT. {BIO_MAX - draft.length} LEFT</span>
        <Problem message={problem} />
      </span>
    </form>
  );
}
