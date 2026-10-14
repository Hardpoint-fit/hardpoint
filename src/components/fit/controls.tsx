"use client";

// The fit page's interactive controls. Each calls a server action and shows its refusal message
// in place; the server renders NotConfigured instead of the write controls when sign-in is off.
import { useState, useTransition, type FormEvent } from "react";
import { MarkdownEditor } from "#/components/markdown-editor";
import { BAN_REASON_MAX, COMMENT_MAX } from "#/lib/fits/limits";
import {
  addCommentAction,
  bookmarkAction,
  deleteCommentAction,
  deleteFitAction,
  unpublishFitAction,
  editCommentAction,
  moderateAction,
  banPilotAction,
  unbanPilotAction,
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

/** Toggles the signed-in pilot's bookmark on a published fit; the state shown is the server's last answer. */
export function BookmarkButton({ fitId, bookmarked }: { fitId: string; bookmarked: boolean }) {
  const [state, setState] = useState(bookmarked);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = () =>
    start(async () => {
      setProblem(null);
      const result = await bookmarkAction(fitId, !state);
      if (result.ok) setState(result.bookmarked);
      else setProblem(result.message);
    });
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" className={`btn btn--quiet ${state ? "btn--on" : ""}`} onClick={toggle} disabled={pending} aria-pressed={state}>
        {state ? "BOOKMARKED" : "BOOKMARK"}
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
      <MarkdownEditor
        value={body}
        onChange={setBody}
        maxLength={COMMENT_MAX}
        placeholder={parentId ? "REPLY" : "SAY SOMETHING ABOUT THIS FIT"}
        label={parentId ? "Reply" : "Comment"}
        required
      />
      <span className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn" disabled={pending || body.trim() === ""}>
          {cta}
        </button>
        <span className="note">MARKDOWN. {COMMENT_MAX - body.length} LEFT</span>
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
      <MarkdownEditor value={draft} onChange={setDraft} maxLength={COMMENT_MAX} label="Edit comment" required />
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
      <span className="note">{hasReplies ? "THIS REMOVES THE COMMENT. ITS REPLIES STAY." : "THIS REMOVES THE COMMENT."}</span>
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

/** Admin, on the fit page: hides or restores a fit or a comment where it stands. Hiding closes its open reports. */
export function HideToggle({ targetKind, targetId, hidden }: { targetKind: "fit" | "comment"; targetId: string; hidden: boolean }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = () =>
    start(async () => {
      setProblem(null);
      const result = await moderateAction(targetKind, targetId, !hidden);
      if (!result.ok) setProblem(result.message);
    });
  const what = targetKind === "fit" ? "FIT" : "COMMENT";
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn--quiet" disabled={pending} onClick={toggle}>
        {hidden ? `UNHIDE ${what}` : `HIDE ${what}`}
      </button>
      <Problem message={problem} />
    </span>
  );
}

/**
 * Admin, on /admin/pilots: BAN takes a reason and, optionally, hides all the pilot's fits and comments; a second,
 * explicit click confirms. UNBAN lifts it in one click (it hides or shows nothing).
 */
export function BanControls({ userId, name, banned }: { userId: string; name: string; banned: boolean }) {
  const [step, setStep] = useState<"closed" | "form" | "confirm">("closed");
  const [reason, setReason] = useState("");
  const [hideAll, setHideAll] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = (work: () => Promise<Result>) =>
    start(async () => {
      setProblem(null);
      const result = await work();
      if (!result.ok) return setProblem(result.message);
      setStep("closed");
      setReason("");
      setHideAll(false);
    });
  if (banned)
    return (
      <span className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn--quiet" disabled={pending} onClick={() => act(() => unbanPilotAction(userId))}>
          UNBAN
        </button>
        <Problem message={problem} />
      </span>
    );
  if (step === "closed")
    return (
      <button type="button" className="btn btn--quiet" onClick={() => setStep("form")}>
        BAN
      </button>
    );
  const review = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim() !== "") setStep("confirm");
  };
  return (
    <form className="flex w-full flex-col gap-2" onSubmit={review}>
      <label className="field">
        WHY
        <textarea
          className="textarea"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={BAN_REASON_MAX}
          required
          disabled={step === "confirm"}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={hideAll} onChange={(event) => setHideAll(event.target.checked)} disabled={step === "confirm"} />
        ALSO HIDE ALL THEIR FITS AND COMMENTS
      </label>
      {step === "form" ? (
        <span className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn" disabled={reason.trim() === ""}>
            BAN
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => setStep("closed")}>
            CANCEL
          </button>
          <span className="note">{BAN_REASON_MAX - reason.length} LEFT</span>
        </span>
      ) : (
        <>
          <span className="note note--error">
            {name} WILL NOT BE ABLE TO POST, VOTE, COMMENT OR SAVE{hideAll ? ". EVERY FIT AND COMMENT THEY PUBLISHED WILL BE HIDDEN" : ""}.
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn" disabled={pending} onClick={() => act(() => banPilotAction(userId, reason, hideAll))}>
              CONFIRM BAN
            </button>
            <button type="button" className="btn btn--quiet" disabled={pending} onClick={() => setStep("form")}>
              BACK
            </button>
            <Problem message={problem} />
          </span>
        </>
      )}
    </form>
  );
}
