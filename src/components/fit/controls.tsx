"use client";

// The fit page's interactive controls. Each calls a server action and shows its refusal message
// in place; the server renders NotConfigured instead of the write controls when sign-in is off.
import { useState, useTransition, type FormEvent } from "react";
import {
  addCommentAction,
  deleteCommentAction,
  deleteFitAction,
  unpublishFitAction,
  editCommentAction,
  moderateAction,
  reportAction,
  resolveReportAction,
  voteAction,
} from "#/app/actions";

type Result = { ok: true } | { ok: false; message: string };

function Problem({ message }: { message: string | null }) {
  return message ? (
    <span className="note note--error" role="alert">
      {message}
    </span>
  ) : null;
}

export function VoteButton({ fitId, votes, voted }: { fitId: string; votes: number; voted: boolean }) {
  const [state, setState] = useState({ votes, voted });
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = () =>
    start(async () => {
      setProblem(null);
      const result = await voteAction(fitId, !state.voted);
      if (result.ok) setState({ votes: result.votes, voted: result.voted });
      else setProblem(result.message);
    });
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" className={`btn ${state.voted ? "btn--on" : ""}`} onClick={toggle} disabled={pending} aria-pressed={state.voted}>
        {state.voted ? "UPVOTED" : "UPVOTE"} <span className="rating">{state.votes}</span>
      </button>
      <Problem message={problem} />
    </span>
  );
}

export function ReportButton({ targetKind, targetId, label = "REPORT" }: { targetKind: "fit" | "comment"; targetId: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (done) return <span className="note">REPORTED. A MODERATOR WILL LOOK.</span>;
  if (!open)
    return (
      <button type="button" className="btn btn--quiet" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    start(async () => {
      const result = await reportAction(targetKind, targetId, reason);
      if (result.ok) setDone(true);
      else setProblem(result.message);
    });
  };
  return (
    <form className="flex w-full flex-col gap-2" onSubmit={submit}>
      <label className="field">
        WHAT&apos;S WRONG
        <textarea className="textarea" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} required />
      </label>
      <span className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn" disabled={pending}>
          SEND REPORT
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => setOpen(false)}>
          CANCEL
        </button>
        <Problem message={problem} />
      </span>
    </form>
  );
}

export function CommentForm({ fitId, parentId = null, cta = "POST" }: { fitId: string; parentId?: string | null; cta?: string }) {
  const [body, setBody] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    start(async () => {
      setProblem(null);
      const result = await addCommentAction(fitId, parentId, body);
      if (result.ok) setBody("");
      else setProblem(result.message);
    });
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <textarea
        className="textarea"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        maxLength={2000}
        placeholder={parentId ? "REPLY" : "SAY SOMETHING ABOUT THIS FIT"}
        aria-label={parentId ? "Reply" : "Comment"}
        required
      />
      <span className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn" disabled={pending || body.trim() === ""}>
          {cta}
        </button>
        <span className="note">MARKDOWN. {2000 - body.length} LEFT</span>
        <Problem message={problem} />
      </span>
    </form>
  );
}

export function ReplyToggle({ fitId, parentId }: { fitId: string; parentId: string }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <CommentForm fitId={fitId} parentId={parentId} cta="REPLY" />
  ) : (
    <button type="button" className="btn btn--quiet self-start" onClick={() => setOpen(true)}>
      REPLY
    </button>
  );
}

export function EditComment({ fitId, id, body }: { fitId: string; id: string; body: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(body);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open)
    return (
      <button type="button" className="btn btn--quiet" onClick={() => setOpen(true)}>
        EDIT
      </button>
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    start(async () => {
      const result = await editCommentAction(fitId, id, draft);
      if (result.ok) setOpen(false);
      else setProblem(result.message);
    });
  };
  return (
    <form className="flex w-full flex-col gap-2" onSubmit={submit}>
      <textarea className="textarea" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2000} aria-label="Edit comment" required />
      <span className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn" disabled={pending}>
          SAVE
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => setOpen(false)}>
          CANCEL
        </button>
        <Problem message={problem} />
      </span>
    </form>
  );
}

export function DeleteComment({ fitId, id, hasReplies }: { fitId: string; id: string; hasReplies: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!confirming)
    return (
      <button type="button" className="btn btn--quiet" onClick={() => setConfirming(true)}>
        DELETE
      </button>
    );
  const confirm = () =>
    start(async () => {
      setProblem(null);
      const result = await deleteCommentAction(fitId, id);
      if (!result.ok) setProblem(result.message);
    });
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="note">{hasReplies ? "THE COMMENT IS REMOVED; ITS REPLIES STAY." : "THE COMMENT IS REMOVED."}</span>
      <button type="button" className="btn" disabled={pending} onClick={confirm}>
        CONFIRM DELETE
      </button>
      <button type="button" className="btn btn--quiet" disabled={pending} onClick={() => setConfirming(false)}>
        CANCEL
      </button>
      <Problem message={problem} />
    </span>
  );
}

/**
 * Deletes the pilot's own fit after a second click. On success it goes to `then`, the pilot's own page:
 * the fit's page no longer exists. The fit page does a full navigation (no cached page of the deleted fit to return to); the builder passes its own `go`.
 */
export function DeleteFitButton({ fitId, then, go }: { fitId: string; then: string; go?: (url: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!confirming)
    return (
      <button type="button" className="btn btn--quiet" onClick={() => setConfirming(true)}>
        DELETE FIT
      </button>
    );
  const confirm = () =>
    start(async () => {
      setProblem(null);
      const result = await deleteFitAction(fitId);
      if (!result.ok) return setProblem(result.message);
      (go ?? ((url) => window.location.assign(url)))(then);
    });
  return (
    <span className="flex w-full flex-col gap-2">
      <span className="note note--error">THIS DELETES THE FIT. ITS VOTES AND COMMENTS GO WITH IT. THIS CAN&apos;T BE UNDONE.</span>
      <span className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" disabled={pending} onClick={confirm}>
          CONFIRM DELETE
        </button>
        <button type="button" className="btn btn--quiet" disabled={pending} onClick={() => setConfirming(false)}>
          CANCEL
        </button>
        <Problem message={problem} />
      </span>
    </span>
  );
}

/** Takes the pilot's published fit back to a draft; votes and comments are kept. */
export function UnpublishButton({ fitId }: { fitId: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const unpublish = () =>
    start(async () => {
      setProblem(null);
      const result = await unpublishFitAction(fitId);
      if (!result.ok) setProblem(result.message);
    });
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn--quiet" disabled={pending} onClick={unpublish}>
        UNPUBLISH
      </button>
      <Problem message={problem} />
    </span>
  );
}

export function ModerationButtons({
  reportId,
  targetKind,
  targetId,
  hidden,
}: {
  reportId: string;
  targetKind: "fit" | "comment";
  targetId: string;
  /** Whether the target is hidden now; null when it no longer exists (nothing to hide). */
  hidden: boolean | null;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = (work: () => Promise<Result>) =>
    start(async () => {
      setProblem(null);
      const result = await work();
      if (!result.ok) setProblem(result.message);
    });
  return (
    <span className="flex flex-wrap items-center gap-2">
      {hidden !== null && (
        <button type="button" className="btn" disabled={pending} onClick={() => act(() => moderateAction(targetKind, targetId, !hidden))}>
          {hidden ? "UNHIDE" : "HIDE"}
        </button>
      )}
      <button type="button" className="btn btn--quiet" disabled={pending} onClick={() => act(() => resolveReportAction(reportId))}>
        RESOLVE
      </button>
      <Problem message={problem} />
    </span>
  );
}
