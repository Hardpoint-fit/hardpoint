import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ModerationButtons } from "#/components/fit/controls";
import { AdminNav, ReverifyPanel } from "#/components/moderation";
import { Panel, UnavailableState, formatDate } from "#/components/ui";
import { loadReports } from "#/lib/site/loaders";
import { pageViewer, siteDeps } from "#/lib/site/server";

export const metadata: Metadata = { title: "Reports · hardpoint.fit", robots: { index: false } };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await pageViewer();
  // The queue doesn't exist for anyone but a moderator; one whose role expired is offered a fresh sign-in, no data.
  if (viewer.moderation === "none") notFound();
  const after = (await searchParams).after;
  const data = viewer.isAdmin ? await loadReports(siteDeps(), typeof after === "string" ? after : undefined) : null;
  return (
    <main className="page">
      <div className="page-title">
        <h1>OPEN REPORTS</h1>
        <span className="eyebrow">HIDE WHAT BREAKS THE RULES · RESOLVE THE REST</span>
      </div>
      <AdminNav current="reports" />
      {data === null ? (
        <ReverifyPanel returnTo="/admin/reports" />
      ) : data.status === "unavailable" ? (
        <UnavailableState what="REPORTS" />
      ) : data.reports.length === 0 ? (
        <Panel title="QUEUE">
          <div className="empty-state">NO OPEN REPORTS.</div>
        </Panel>
      ) : (
        <Panel title="QUEUE" aside={String(data.reports.length)}>
          <ul className="reports">
            {data.reports.map((report) => (
              <li key={report.id} className="report">
                <div className="report__head">
                  <span className="badge badge--pending">{report.targetKind === "fit" ? "FIT" : "COMMENT"}</span>
                  {report.target?.hidden && <span className="badge badge--hidden">HIDDEN</span>}
                  <span className="note">{formatDate(report.createdAt)}</span>
                </div>
                {report.target ? (
                  <Link
                    className="link report__preview"
                    href={`/fits/${report.target.fitId}${report.targetKind === "comment" ? `#comment-${report.targetId}` : ""}`}
                  >
                    {report.target.preview}
                  </Link>
                ) : (
                  <span className="note">NO LONGER EXISTS</span>
                )}
                {report.target && (
                  <span className="note">
                    BY{" "}
                    <Link className="link" href={`/u/${encodeURIComponent(report.target.authorUserId)}`}>
                      {report.target.authorName}
                    </Link>
                  </span>
                )}
                <p className="report__reason">{report.reason}</p>
                <ModerationButtons reportId={report.id} targetKind={report.targetKind} targetId={report.targetId} hidden={report.target?.hidden ?? null} />
              </li>
            ))}
          </ul>
          {data.nextAfterId && (
            <Link className="btn btn--quiet self-center" href={`/admin/reports?after=${data.nextAfterId}`}>
              MORE REPORTS
            </Link>
          )}
        </Panel>
      )}
    </main>
  );
}
