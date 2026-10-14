// The compare page: two fits' titles, hulls and ratings, their hull specs row by row (a value that differs
// is highlighted, a row one fit lacks reads "—") and their modules (only in A, only in B, in both). A plain
// render of what loadCompare read. A fit that is missing or hidden from the viewer is a "Fit not found" column.
import Link from "next/link";
import type { SpecRow } from "#/lib/engine/types";
import type { CompareData, CompareSide } from "#/lib/site/loaders";
import type { ModuleRow } from "#/lib/fits/compare";
import { EngineBanner, Panel, StandingBadge } from "#/components/ui";
import { ComparePickerForm } from "./compare-picker";

type Ready = Extract<CompareData, { status: "ok" }>;

function Head({ side, label }: { side: CompareSide; label: string }) {
  return (
    <div className="compare-side">
      <span className="eyebrow">FIT {label}</span>
      {side.status === "empty" && <p className="note">NO FIT CHOSEN.</p>}
      {side.status === "missing" && (
        <>
          <h2 className="compare-side__title">FIT NOT FOUND</h2>
          <p className="note">IT DOESN&apos;T EXIST, OR YOU CAN&apos;T SEE IT.</p>
        </>
      )}
      {side.status === "found" && (
        <>
          <h2 className="compare-side__title">
            <Link className="link" href={`/fits/${encodeURIComponent(side.id)}`}>
              {side.title}
            </Link>
          </h2>
          <span className="note">
            {side.hullName} · BY{" "}
            <Link className="link" href={`/u/${encodeURIComponent(side.authorUserId)}`}>
              {side.authorName}
            </Link>
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <StandingBadge standing={side.standing} />
            {side.fitStatus !== "published" && <span className={`badge badge--${side.fitStatus}`}>{side.fitStatus.toUpperCase()}</span>}
            {side.rating !== null && <span className="rating">RATING {side.rating}</span>}
          </span>
          {side.statsNote && <span className="note note--error">{side.statsNote}</span>}
        </>
      )}
    </div>
  );
}

function Cell({ row, tag }: { row: SpecRow | null; tag: string }) {
  const value = row ? (row.secondary ?? row.primary) : null;
  const tone = row ? (row.secondary ? row.secondaryTone : row.primaryTone) : "";
  return (
    <span className="compare-row__cell">
      <span className="compare-row__tag">{tag}</span>
      {value ? (
        <>
          <span className={`specs__value ${tone === "Positive" ? "positive" : tone === "Negative" ? "negative" : ""}`}>{value.text}</span>
          {value.unit && <span className="specs__unit">{value.unit}</span>}
        </>
      ) : (
        <span className="compare-missing" aria-label="Missing">
          —
        </span>
      )}
    </span>
  );
}

function ModuleColumn({ title, rows, side }: { title: string; rows: ModuleRow[]; side: "a" | "b" | "both" }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="note">
        {title} · {rows.length}
      </span>
      {rows.length === 0 ? (
        <p className="note">NONE.</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.def}>
              <Link className="link" href={`/?module=${encodeURIComponent(row.def)}`}>
                {row.name}
              </Link>{" "}
              {side === "a" && row.a > 1 && `×${row.a}`}
              {side === "b" && row.b > 1 && `×${row.b}`}
              {side === "both" && (row.a === row.b ? (row.a > 1 ? `×${row.a}` : "") : <span className="tone-negative">A ×{row.a} · B ×{row.b}</span>)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CompareView({ data, signedIn }: { data: Ready; signedIn: boolean }) {
  const { a, b } = data;
  const bothFound = a.status === "found" && b.status === "found";
  return (
    <main className="page">
      <EngineBanner engine={data.engine} />
      <div className="page-title">
        <h1>COMPARE</h1>
        <span className="eyebrow">TWO FITS SIDE BY SIDE · STORED RESULTS</span>
      </div>
      <Panel title="FITS">
        <div className="compare-heads">
          <Head side={a} label="A" />
          <Head side={b} label="B" />
        </div>
      </Panel>
      {a.status === "found" && b.status !== "found" && (
        <Panel title={b.status === "empty" ? "CHOOSE THE SECOND FIT" : "CHOOSE ANOTHER FIT"}>
          <ComparePickerForm a={a.id} signedIn={signedIn} />
        </Panel>
      )}
      {a.status !== "found" && (
        <Panel title="START FROM A FIT">
          <p className="note">OPEN A FIT AND PRESS COMPARE, THEN CHOOSE THE FIT TO SET IT AGAINST.</p>
        </Panel>
      )}
      {bothFound && (
        <>
          <Panel title="HULL SPECS" aside="CHANGED VALUES ARE HIGHLIGHTED">
            {data.sections.length === 0 ? (
              <p className="note">NEITHER FIT HAS STATS YET.</p>
            ) : (
              <div className="specs">
                {data.sections.map((section) => (
                  <section key={section.id} className="specs__section" aria-label={section.label}>
                    <header className="specs__header">
                      <span className="specs__title">{section.label}</span>
                    </header>
                    {section.rows.map((row) => (
                      <div key={row.id} className={`compare-row ${row.differs ? "compare-row--differs" : ""}`} data-differs={row.differs}>
                        <span className="compare-row__label">{row.label}</span>
                        <Cell row={row.a} tag="A" />
                        <Cell row={row.b} tag="B" />
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            )}
          </Panel>
          <Panel title="MODULES">
            <div className="compare-modules">
              <ModuleColumn title="ONLY IN A" rows={data.modules.onlyA} side="a" />
              <ModuleColumn title="IN BOTH" rows={data.modules.both} side="both" />
              <ModuleColumn title="ONLY IN B" rows={data.modules.onlyB} side="b" />
            </div>
          </Panel>
        </>
      )}
    </main>
  );
}
