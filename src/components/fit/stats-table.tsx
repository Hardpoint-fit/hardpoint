// The ship's final stats from a stored engine verdict, each row with its modifier breakdown in a
// game tooltip on hover or focus.
import type { Catalog, StatLine } from "#/lib/engine/types";
import { describeSource, formatStatValue, sourceNames, statLabel, statTone } from "#/lib/fits/stat-format";

export function StatsTable({ stats, catalog }: { stats: readonly StatLine[]; catalog: Catalog | null }) {
  if (stats.length === 0) return <p className="note">NO STAT CHANGES.</p>;
  const names = catalog ? sourceNames(catalog) : new Map<string, string>();
  return (
    <ul className="stats" aria-label="Stats">
      {stats.map((line, i) => {
        const tone = statTone(line.stat, line.total).toLowerCase();
        return (
          <li key={`${line.stat}-${line.stage}-${line.operation}-${i}`} className="stats__row tip-anchor" tabIndex={0}>
            <span className="stats__label">{statLabel(line.stat)}</span>
            <span className={`stats__value tone-${tone}`}>{formatStatValue(line.stat, line.operation, line.total)}</span>
            <div className="tip stats__tip">
              <div className="plate">
                <div className="plate__name">{statLabel(line.stat)}</div>
                <div className="plate__sub tone-neutral">
                  {line.sources.length} {line.sources.length === 1 ? "SOURCE" : "SOURCES"}
                </div>
                <div className="plate__divider" />
                {line.sources.map((source, j) => {
                  const row = describeSource(line, source, names);
                  return (
                    <div key={j} className="plate__row">
                      <span>
                        {row.name}
                        <span className="tone-neutral"> · {row.kind}</span>
                      </span>
                      <b className={`tone-${row.tone.toLowerCase()}`}>
                        {row.value}
                        {row.stacking && <span className="plate__tier-badge">{row.stacking}</span>}
                      </b>
                    </div>
                  );
                })}
                <div className="plate__divider" />
                <div className="plate__row">
                  TOTAL <b className={`tone-${tone}`}>{formatStatValue(line.stat, line.operation, line.total)}</b>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
