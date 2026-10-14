// The fit page: grid, stats, description, tags, author, votes, the fit string and comments. A plain
// render of what loadFitPage read, so route tests can render it without Next.
import Link from "next/link";
import type { Comment, CommentThread } from "#/lib/fits/queries";
import { renderMarkdown } from "#/lib/fits/markdown";
import type { FitPageData } from "#/lib/site/loaders";
import type { PageViewer } from "#/lib/site/server";
import { FittingGrid } from "#/components/grid/fitting-grid";
import { EngineBanner, NotConfigured, Panel, StandingBadge, buildLabel, count, formatDate } from "#/components/ui";
import { CommentForm, DeleteComment, DeleteFitButton, EditComment, ReplyToggle, ReportButton, UnpublishButton, VoteButton } from "./controls";
import { StatsTable } from "./stats-table";
import { HullSpecs, SPECS_PENDING } from "./hull-specs";
import { ItemIcon } from "#/components/item-text";
import { itemIcon } from "#/lib/art/item-icon";
import { CopyFitString } from "./copy-fit-string";
import { isOpenFit } from "#/lib/engine/open-fit";

type Ready = Extract<FitPageData, { status: "ok" }>;

const GRID_NOTES: Record<Exclude<Ready["grid"]["status"], "ready">, string> = {
  no_catalog: "THE GRID NEEDS THE LOADOUT ENGINE, WHICH ISN'T ANSWERING. STATS BELOW ARE STORED.",
  unknown_hull: "THIS HULL ISN'T IN THE CURRENT BUILD.",
  unreadable: "THIS FIT CAN'T BE DRAWN.",
};

function Markdown({ source }: { source: string }) {
  // renderMarkdown escapes raw HTML and allows only http(s) links (markdown.ts, Review Focus #5).
  return <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />;
}

function CommentView({ comment, fitId, viewer, canWrite, hasReplies = false }: { comment: Comment; fitId: string; viewer: PageViewer; canWrite: boolean; hasReplies?: boolean }) {
  if (comment.deletedAt) {
    // A tombstone: rendered from deleted_at; its text and author are not shown.
    return (
      <article className="comment" id={`comment-${comment.id}`}>
        <header className="comment__head">
          <span className="note">{formatDate(comment.createdAt)}</span>
        </header>
        <p className="note">[DELETED]</p>
      </article>
    );
  }
  return (
    <article className="comment" id={`comment-${comment.id}`}>
      <header className="comment__head">
        <Link className="link" href={`/u/${encodeURIComponent(comment.authorUserId)}`}>
          {comment.authorName}
        </Link>
        <span className="note">
          {formatDate(comment.createdAt)}
          {comment.editedAt ? " · EDITED" : ""}
        </span>
        {comment.hidden && <span className="badge badge--hidden">HIDDEN</span>}
      </header>
      <Markdown source={comment.body} />
      {canWrite && (
        <div className="comment__actions">
          {viewer.userId === comment.authorUserId && <EditComment fitId={fitId} id={comment.id} body={comment.body} />}
          {viewer.userId === comment.authorUserId && <DeleteComment fitId={fitId} id={comment.id} hasReplies={hasReplies} />}
          {viewer.userId !== comment.authorUserId && <ReportButton targetKind="comment" targetId={comment.id} />}
        </div>
      )}
    </article>
  );
}

function Comments({ threads, fitId, viewer, open }: { threads: CommentThread[]; fitId: string; viewer: PageViewer; open: boolean }) {
  const count = threads.reduce((sum, thread) => sum + 1 + thread.replies.length, 0);
  const canWrite = viewer.authEnabled && viewer.userId !== null;
  return (
    <Panel title="COMMENTS" aside={String(count)}>
      {threads.length === 0 && <p className="note">NO COMMENTS YET.</p>}
      {threads.map((thread) => (
        <div key={thread.id} className="comment-thread">
          <CommentView comment={thread} fitId={fitId} viewer={viewer} canWrite={canWrite} hasReplies={thread.replies.length > 0} />
          {thread.replies.length > 0 && (
            <div className="comment-replies">
              {thread.replies.map((reply) => (
                <CommentView key={reply.id} comment={reply} fitId={fitId} viewer={viewer} canWrite={canWrite} />
              ))}
            </div>
          )}
          {open && canWrite && <ReplyToggle fitId={fitId} parentId={thread.id} />}
        </div>
      ))}
      {!open ? null : !viewer.authEnabled ? (
        <NotConfigured />
      ) : viewer.userId === null ? (
        <p className="note">SIGN IN TO COMMENT.</p>
      ) : (
        <CommentForm fitId={fitId} />
      )}
    </Panel>
  );
}

export function FitPageView({ data, viewer }: { data: Ready; viewer: PageViewer }) {
  const { fit, shown, engine, grid } = data;
  const published = fit.status === "published";
  const own = viewer.authEnabled && viewer.userId !== null && viewer.userId === fit.authorUserId;
  const hullName = data.hull?.name ?? "UNKNOWN HULL";
  const rating = shown.reference?.rating ?? null;
  const hullIcon = data.hull ? itemIcon({ path: data.hull.path, category: "Ship" }, isOpenFit(fit.fit) ? fit.fit.hull.roll : { rarity: "Normal", isIdentified: true }) : null;
  return (
    <main className="page">
      <EngineBanner engine={engine} />
      <div className="page-title fit-head">
        <ItemIcon src={hullIcon} size={48} className="fit-head__icon" />
        <span className="eyebrow">
          {hullName} · {data.hull ? `${data.hull.shipClass.toUpperCase()} · ${data.hull.role === "None" ? "NO ROLE" : data.hull.role.toUpperCase()}` : "NOT IN THIS BUILD"}
        </span>
      </div>
      <div className="fit-layout">
        <div className="fit-layout__main">
          <Panel
            title="FIT"
            aside={
              <>
                <StandingBadge standing={shown.standing} />
                {fit.status !== "published" && <span className={`badge badge--${fit.status}`}>{fit.status.toUpperCase()}</span>}
              </>
            }
          >
            {shown.issues.length > 0 && (
              <ul className="issues" aria-label="Issues on the current build">
                {shown.issues.map((issue, i) => (
                  <li key={i} className="tone-negative">
                    {issue.moduleIndex >= 0 && grid.status === "ready" ? `${grid.model.modules[issue.moduleIndex]?.name ?? "MODULE"}: ` : ""}
                    {issue.message.toUpperCase()}
                  </li>
                ))}
              </ul>
            )}
            {grid.status === "ready" ? (
              <div className="fg-scroll">
                <FittingGrid model={grid.model} />
              </div>
            ) : (
              <div className="empty-state">
                <span>{GRID_NOTES[grid.status]}</span>
              </div>
            )}
          </Panel>
          <Panel title="DESCRIPTION">
            {fit.description.trim() ? <Markdown source={fit.description} /> : <p className="note">NO DESCRIPTION.</p>}
            {fit.tags.length > 0 && (
              <div className="flex flex-wrap gap-2" aria-label="Tags">
                {fit.tags.map((tag) => (
                  <Link key={tag} className="chip" href={`/?tag=${encodeURIComponent(tag)}`}>
                    {tag.toUpperCase()}
                  </Link>
                ))}
              </div>
            )}
          </Panel>
          <Comments threads={data.comments} fitId={fit.id} viewer={viewer} open={published} />
        </div>
        <aside className="fit-layout__side">
          <Panel title="PILOT FIT" aside={rating !== null ? <span className="rating">RATING {rating}</span> : undefined}>
            <h1 className="fit-title">{fit.title}</h1>
            <div className="note">
              BY{" "}
              <Link className="link" href={`/u/${encodeURIComponent(fit.authorUserId)}`}>
                {fit.authorName}
              </Link>{" "}
              · {formatDate(fit.publishedAt ?? fit.updatedAt)}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!published ? null : viewer.authEnabled ? (
                viewer.userId ? (
                  <VoteButton fitId={fit.id} votes={fit.votes} voted={fit.viewerVoted} />
                ) : (
                  <span className="note">
                    <span className="rating">{count(fit.votes, "UPVOTE")}</span> · SIGN IN TO VOTE
                  </span>
                )
              ) : (
                <span className="flex flex-col gap-1">
                  <span className="rating note">{count(fit.votes, "UPVOTE")}</span>
                  {/* Stands in for the vote and report controls while the site has no sign-in. */}
                  <NotConfigured />
                </span>
              )}
            </div>
            {isOpenFit(fit.fit) && <CopyFitString fit={fit.fit} label="COPY FIT STRING" />}
            <span className="flex flex-wrap gap-2">
              <Link className="btn btn--quiet" href={`/fits/new?from=${encodeURIComponent(fit.id)}`}>
                COPY FIT TO BUILDER
              </Link>
              {viewer.userId === fit.authorUserId && fit.status !== "hidden" && (
                <Link className="btn" href={`/fits/${encodeURIComponent(fit.id)}/edit`}>
                  EDIT
                </Link>
              )}
            </span>
            {own && (
              <span className="flex flex-wrap items-center gap-2">
                {published && <UnpublishButton fitId={fit.id} />}
                <DeleteFitButton fitId={fit.id} then={`/u/${encodeURIComponent(viewer.userId!)}`} />
              </span>
            )}
            {published && viewer.authEnabled && viewer.userId && viewer.userId !== fit.authorUserId && (
              <ReportButton targetKind="fit" targetId={fit.id} label="REPORT FIT" />
            )}
          </Panel>
          <Panel
            title="HULL SPECS"
            aside={shown.reference ? (shown.referenceIsOld ? `LAST VALID · ${buildLabel(shown.reference.buildSha)}` : buildLabel(shown.reference.buildSha)) : undefined}
          >
            {shown.reference === null ? (
              <p className="note">THIS FIT HAS NEVER PASSED THE ENGINE, SO IT HAS NO STATS.</p>
            ) : (
              <>
                {shown.referenceIsOld && shown.standing === "outdated" && (
                  <p className="note note--error">THIS FIT FAILS ON THE CURRENT BUILD. THESE STATS ARE FROM ITS LAST VALID BUILD.</p>
                )}
                {shown.result.sections === null ? (
                  // Stored before the engine sent hull specs: the re-evaluation job asks again. An outdated
                  // fit's last valid build can't be asked again, so it says so rather than promise.
                  <p className="note">{shown.standing === "outdated" ? "NO HULL SPECS WERE KEPT FROM ITS LAST VALID BUILD." : SPECS_PENDING}</p>
                ) : (
                  <HullSpecs sections={shown.result.sections} />
                )}
              </>
            )}
          </Panel>
          {shown.reference !== null && (
            <Panel title="MODIFIERS">
              <StatsTable stats={shown.result.stats} catalog={engine.catalog} />
            </Panel>
          )}
        </aside>
      </div>
    </main>
  );
}
