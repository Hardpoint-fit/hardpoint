// Shared page pieces: the chamfered panel, outage banners and states, and the standing badge.
import type { ReactNode } from "react";
import { SIGN_IN_UNAVAILABLE_MESSAGE } from "#/lib/auth-errors";
import type { Standing } from "#/lib/fits/standing";
import type { PageEngine } from "#/lib/site/loaders";

export function Panel({
  title,
  aside,
  children,
  className,
  contentClassName,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section className={["panel", className].filter(Boolean).join(" ")}>
      <div className="panel__body">
        {title !== undefined && (
          <header className="panel__header">
            <span>{title}</span>
            {aside !== undefined && <span className="panel__header-aside">{aside}</span>}
          </header>
        )}
        <div className={["panel__content", contentClassName].filter(Boolean).join(" ")}>{children}</div>
      </div>
    </section>
  );
}

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 8).toUpperCase() : "UNKNOWN");

/** Shown while the engine doesn't answer: pages keep rendering from the verdicts already stored. */
export function EngineBanner({ engine }: { engine: PageEngine }) {
  if (engine.state.status === "up") return null;
  return (
    <div className="banner" role="status">
      <span>THE ENGINE ISN&apos;T ANSWERING. SHOWING STORED RESULTS.</span>
      <small>
        {engine.currentSha ? `LAST BUILD SEEN ${shortSha(engine.currentSha)}` : "NO BUILD SEEN YET"}
        {engine.catalog ? "" : " · GRIDS RETURN WHEN IT DOES"}
      </small>
    </div>
  );
}

export function UnavailableState({ what = "FITS" }: { what?: string }) {
  return (
    <Panel title="UNAVAILABLE">
      <div className="empty-state">
        <span>{what} ARE UNAVAILABLE RIGHT NOW.</span>
        <span className="note">THE FITS DATABASE CAN&apos;T BE REACHED. TRY AGAIN IN A MOMENT.</span>
      </div>
    </Panel>
  );
}

/** Stands in for a write control while the site has no sign-in. */
export function NotConfigured() {
  return <span className="note">{SIGN_IN_UNAVAILABLE_MESSAGE}</span>;
}

const STANDING_TEXT: Record<Standing, string> = {
  current: "WORKS ON CURRENT BUILD",
  outdated: "OUTDATED",
  invalid: "NOT VALID",
  pending: "CHECKING ON NEW BUILD",
  unknown: "BUILD UNKNOWN",
};

export function StandingBadge({ standing, quiet = false }: { standing: Standing; quiet?: boolean }) {
  if (quiet && standing === "current") return null;
  return <span className={`badge badge--${standing}`}>{STANDING_TEXT[standing]}</span>;
}

export function buildLabel(sha: string | null): string {
  return `BUILD ${shortSha(sha)}`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10).replace(/-/g, ".");
}

/** "1 UPVOTE", "2 UPVOTES". */
export function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "S"}`;
}
