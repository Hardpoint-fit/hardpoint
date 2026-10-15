// The fit page: grid, stats, description, tags, author, votes, the fit string and comments. A plain
// render of what loadFitPage read, so route tests can render it without Next.
import Link from "next/link";
import type { Comment, CommentThread } from "#/lib/fits/queries";
import { renderMarkdown } from "#/lib/fits/markdown";
import type { FitPageData } from "#/lib/site/loaders";
import type { PageViewer } from "#/lib/site/server";
import { FittingGrid, ModifiedCellsLegend } from "#/components/grid/fitting-grid";
import type { GridModule } from "#/components/grid/model";
import { EngineBanner, NotConfigured, Panel, StandingBadge, buildLabel, count, formatDate } from "#/components/ui";
import { BookmarkButton, CommentForm, DeleteComment, DeleteFitButton, EditComment, HideToggle, ReplyToggle, ReportButton, UnpublishButton, VoteButton } from "./controls";
import { ReverifyLink } from "#/components/moderation";
import { Modifiers } from "./stats-table";
import { HullSpecs, SPECS_PENDING } from "./hull-specs";
import { ItemIcon } from "#/components/item-text";
import { itemIcon } from "#/lib/art/item-icon";
import { CopyFitString } from "./copy-fit-string";
import { ComparePicker } from "./compare-picker";
import { isOpenFit } from "#/lib/engine/open-fit";
import { AffinityPanel } from "#/components/affinity/affinity-panel";
import { affinityTypeLabel } from "#/components/affinity/affinity";
import { statWords } from "#/lib/fits/stat-format";

type Ready = Extract<FitPageData, { status: "ok" }>;

const GRID_NOTES: Record<Exclude<Ready["grid"]["status"], "ready">, string> = {
  no_catalog: "THE GRID NEEDS THE ENGINE, WHICH ISN'T ANSWERING. THE STATS BELOW WERE SAVED AT THE LAST CHECK.",
  no_style: "THE GRID CAN'T BE DRAWN RIGHT NOW: THE ENGINE ISN'T SERVING HOW TO DRAW IT. THE STATS BELOW STILL APPLY.",
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
          {viewer.moderation === "active" && <HideToggle targetKind="comment" targetId={comment.id} hidden={comment.hidden} />}
        </div>
      )}
    </article>
  );
}

function Comments({ threads, fitId, viewer, open }: { threads: CommentThread[]; fitId: string; viewer: PageViewer; open: boolean }) {
  const count = threads.reduce((sum, thread) => sum + (thread.deletedAt ? 0 : 1) + thread.replies.filter((reply) => !reply.deletedAt).length, 0);
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
          {open && canWrite && !thread.deletedAt && <ReplyToggle fitId={fitId} parentId={thread.id} />}
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

/**
 * Where the fit was copied from and how many published fits were copied from it. A source the viewer can't
 * see (another pilot's draft or a hidden fit) is "another fit": no title, no pilot.
 */
function ForkNotes({ fork }: { fork: Ready["fork"] }) {
  const { credit, copies } = fork;
  if (!credit && copies === 0) return null;
  return (
    <div className="note fork-notes">
      {credit?.state === "source" && (
        <div>
          BASED ON{" "}
          <Link className="link" href={`/fits/${encodeURIComponent(credit.id)}`}>
            {credit.title}
          </Link>{" "}
          BY{" "}
          <Link className="link" href={`/u/${encodeURIComponent(credit.authorUserId)}`}>
            {credit.authorName}
          </Link>
        </div>
      )}
      {credit?.state === "deleted" && <div>BASED ON A FIT THAT NO LONGER EXISTS</div>}
      {credit?.state === "unseen" && <div>BASED ON ANOTHER FIT</div>}
      {copies > 0 && <div>{copies} {copies === 1 ? "COPY" : "COPIES"}</div>}
    </div>
  );
}

/**
 * An outdated published fit: what the engine says is wrong with it on the current build, module by module,
 * and the last build it worked on. The issues are the stored verdict's; nothing is evaluated here.
 */
function BrokenPanel({ broken }: { broken: NonNullable<Ready["broken"]> }) {
  return (
    <Panel title="BROKEN ON THIS BUILD" aside={broken.lastWorkedBuild ? `LAST WORKED ON ${buildLabel(broken.lastWorkedBuild)}` : undefined}>
      {broken.issues.length === 0 ? (
        <p className="note note--error">THE CURRENT BUILD REJECTS THIS FIT. THE ENGINE GAVE NO DETAILS.</p>
      ) : (
        <ul className="broken-issues" aria-label="Issues on the current build">
          {broken.issues.map((issue, i) => (
            <li key={i} className="tone-negative">
              {issue.moduleName === null ? (
                "WHOLE FIT"
              ) : issue.def ? (
                <Link className="link" href={`/?module=${encodeURIComponent(issue.def)}`}>
                  {issue.moduleName}
                </Link>
              ) : (
                issue.moduleName
              )}
              {": "}
              {issue.message.toUpperCase()}
            </li>
          ))}
        </ul>
      )}
      {!broken.lastWorkedBuild && <p className="note">NO EARLIER BUILD IS RECORDED AS VALID.</p>}
    </Panel>
  );
}

/** The fit's revisions, newest first: each opens that revision read-only; the newest opens the fit itself. */
function History({ fitId, revisions, viewing }: { fitId: string; revisions: Ready["revisions"]; viewing: number | null }) {
  const latest = revisions[0]!.revision;
  return (
    <Panel title="HISTORY" aside={String(latest)}>
      <ol className="history">
        {revisions.map((entry) => {
          const open = entry.revision === (viewing ?? latest);
          return (
            <li key={entry.revision} className="history__row" aria-current={open ? "true" : undefined}>
              <Link className="link" href={entry.revision === latest ? `/fits/${encodeURIComponent(fitId)}` : `/fits/${encodeURIComponent(fitId)}?rev=${entry.revision}`}>
                REVISION {entry.revision}
              </Link>
              <span className="note">
                {formatDate(entry.createdAt)} · {buildLabel(entry.buildSha)}
                {entry.revision === latest ? " · LATEST" : ""}
                {open && viewing !== null ? " · VIEWING" : ""}
              </span>
              {entry.note && <span className="history__note">{entry.note.toUpperCase()}</span>}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

/** The fit's affinity, read-only, as the builder's panel lays it out. Without the catalog's affinity tree only the stored type and XP can be told. */
function FitAffinity({ progression, catalog }: { progression: Ready["progression"]; catalog: Ready["engine"]["catalog"] }) {
  if (!progression) {
    return (
      <Panel title="AFFINITY">
        <p className="note">THIS FIT&apos;S AFFINITY CAN&apos;T BE READ.</p>
      </Panel>
    );
  }
  if (!catalog) {
    return (
      <Panel title="AFFINITY">
        <p className="note">THE AFFINITY TREE NEEDS THE ENGINE, WHICH ISN&apos;T ANSWERING.</p>
        {progression.affinityType !== "None" && <p className="note">{affinityTypeLabel(null, progression.affinityType)} AFFINITY · {progression.affinityXp} XP</p>}
      </Panel>
    );
  }
  return <AffinityPanel affinity={catalog.affinity} progression={progression} />;
}

/** The fit's distinct modules, each linking to the browse page of fits that carry it. */
function ModuleList({ modules }: { modules: GridModule[] }) {
  const distinct = new Map<string, { module: GridModule; count: number }>();
  for (const module of modules) {
    const entry = distinct.get(module.def);
    if (entry) entry.count += 1;
    else distinct.set(module.def, { module, count: 1 });
  }
  return (
    <Panel title="MODULES">
      <ul className="module-list">
        {[...distinct.values()].map(({ module, count: n }) => (
          <li key={module.def} className="module-list__row">
            <ItemIcon src={module.icon} size={24} />
            <span className="module-list__name">
              {n > 1 ? `${module.name} ×${n}` : module.name}
            </span>
            <Link className="link" href={`/?module=${encodeURIComponent(module.def)}`}>
              Fits using this module
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function FitPageView({ data, viewer }: { data: Ready; viewer: PageViewer }) {
  const { fit, shown, engine, grid, revision } = data;
  // A revision with no verdict of its own has no stats to draw (only the latest does).
  const statsShown = revision === null || revision.statsShown;
  const fromHref = `/fits/new?from=${encodeURIComponent(fit.id)}${revision ? `&rev=${revision.number}` : ""}`;
  const published = fit.status === "published";
  const own = viewer.authEnabled && viewer.userId !== null && viewer.userId === fit.authorUserId;
  const hullName = data.hull?.name ?? "UNKNOWN HULL";
  const rating = shown.reference?.rating ?? null;
  const hullIcon = data.hull ? itemIcon({ art: data.hull.art, category: "Ship" }, isOpenFit(fit.fit) ? fit.fit.hull.roll : { rarity: "Normal", isIdentified: true }) : null;
  return (
    <main className="page">
      <EngineBanner engine={engine} />
      {revision && (
        <div className="banner" role="status">
          <span>
            REVISION {revision.number} OF {revision.of} ·{" "}
            <Link className="link" href={`/fits/${encodeURIComponent(fit.id)}`}>
              VIEW LATEST
            </Link>
          </span>
          <small>
            {formatDate(revision.createdAt)}
            {revision.note ? ` · ${revision.note.toUpperCase()}` : ""}
          </small>
        </div>
      )}
      <div className="page-title fit-head">
        <ItemIcon src={hullIcon} size={48} className="fit-head__icon" />
        <span className="eyebrow">
          {hullName} · {data.hull ? `${data.hull.shipClass.toUpperCase()} · ${data.hull.role === "None" ? "NO ROLE" : data.hull.role.toUpperCase()}` : "NOT IN THIS BUILD"}
        </span>
      </div>
      <div className="fit-layout">
        <div className="fit-layout__main">
          {data.broken && <BrokenPanel broken={data.broken} />}
          <Panel
            title="FIT"
            aside={
              <>
                {statsShown && <StandingBadge standing={shown.standing} />}
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
              <>
                <div className="fg-scroll">
                  <FittingGrid model={grid.model} gridStyle={grid.style} words={statWords(engine.catalog?.stats ?? [])} />
                </div>
                <ModifiedCellsLegend cells={grid.model.modified.length} />
              </>
            ) : (
              <div className="empty-state">
                <span>{GRID_NOTES[grid.status]}</span>
              </div>
            )}
          </Panel>
          {grid.status === "ready" && grid.model.modules.length > 0 && <ModuleList modules={grid.model.modules} />}
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
          <FitAffinity progression={data.progression} catalog={engine.catalog} />
          {data.revisions.length > 0 && <History fitId={fit.id} revisions={data.revisions} viewing={revision?.number ?? null} />}
          <Comments threads={data.comments} fitId={fit.id} viewer={viewer} open={published} />
        </div>
        <aside className="fit-layout__side">
          <Panel title="PILOT FIT" aside={statsShown && rating !== null ? <span className="rating">RATING {rating}</span> : undefined}>
            <h1 className="fit-title">{fit.title}</h1>
            <div className="note">
              BY{" "}
              <Link className="link" href={`/u/${encodeURIComponent(fit.authorUserId)}`}>
                {fit.authorName}
              </Link>{" "}
              · {formatDate(fit.publishedAt ?? fit.updatedAt)}
            </div>
            <ForkNotes fork={data.fork} />
            <div className="flex flex-wrap items-center gap-2">
              {!published ? null : viewer.authEnabled ? (
                viewer.userId ? (
                  <>
                    <VoteButton fitId={fit.id} votes={fit.votes} voted={fit.viewerVoted} />
                    <BookmarkButton fitId={fit.id} bookmarked={fit.viewerBookmarked} />
                  </>
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
              <Link className="btn btn--quiet" href={fromHref}>
                COPY FIT TO BUILDER
              </Link>
              <ComparePicker fitId={fit.id} signedIn={viewer.authEnabled && viewer.userId !== null} />
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
            {viewer.moderation === "active" && fit.status !== "draft" && <HideToggle targetKind="fit" targetId={fit.id} hidden={fit.status === "hidden"} />}
            {/* One link for the whole page, in place of every HIDE control: it signs in again and comes back here. */}
            {viewer.moderation === "reverify" && fit.status !== "draft" && <ReverifyLink returnTo={`/fits/${encodeURIComponent(fit.id)}${revision ? `?rev=${revision.number}` : ""}`} />}
          </Panel>
          {!statsShown && (
            <Panel title="STATS">
              <p className="note">STATS ARE SHOWN FOR THE LATEST REVISION.</p>
            </Panel>
          )}
          {statsShown && (
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
          )}
          {statsShown && shown.reference !== null && (
            <Panel title="MODIFIERS">
              <Modifiers groups={shown.result.modifierGroups} stats={shown.result.stats} catalog={engine.catalog} />
            </Panel>
          )}
        </aside>
      </div>
    </main>
  );
}
