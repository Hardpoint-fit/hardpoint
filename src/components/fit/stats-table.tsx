// The fit's stat changes from an engine verdict, each row with its modifier breakdown in a game tooltip on
// hover or focus. `Modifiers` draws the engine's `modifierGroups`, the game's MODIFIERS list: a header per
// category, one row per stat with its stages combined. A verdict stored before the engine sent them has
// only `stats`, a line per stat and stage, which `StatsTable` lists until the next check fills them in.
import type { Catalog, ModifierGroup, StatLine, StatSource } from "#/lib/engine/types";
import { describeSource, formatStatValue, sourceNames, statLabel, statTone, statWords, type StatWords } from "#/lib/fits/stat-format";

type RowProps = {
  label: string;
  stat: string;
  operation: string;
  total: number;
  sources: readonly StatSource[];
  words: StatWords;
  names: ReadonlyMap<string, string>;
};

function StatRow({ label, stat, operation, total, sources, words, names }: RowProps) {
  const tone = statTone(words, stat, total).toLowerCase();
  const value = formatStatValue(words, stat, operation, total);
  return (
    <li className="stats__row tip-anchor" tabIndex={0}>
      <span className="stats__label">{label}</span>
      <span className={`stats__value tone-${tone}`}>{value}</span>
      <div className="tip stats__tip">
        <div className="plate">
          <div className="plate__name">{label}</div>
          <div className="plate__sub tone-neutral">
            {sources.length} {sources.length === 1 ? "SOURCE" : "SOURCES"}
          </div>
          <div className="plate__divider" />
          {sources.map((source, j) => {
            const row = describeSource(words, { stat, operation }, source, names);
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
            TOTAL <b className={`tone-${tone}`}>{value}</b>
          </div>
        </div>
      </div>
    </li>
  );
}

function wording(catalog: Catalog | null) {
  // Without a catalog a stat reads as its spaced name (statLabel's fallback) and a source by its kind.
  return { words: statWords(catalog?.stats ?? []), names: catalog ? sourceNames(catalog) : new Map<string, string>() };
}

const NO_CHANGES = <p className="note">NO STAT CHANGES.</p>;

/** The engine's per-stage lines, for a verdict stored before it sent modifier groups. */
export function StatsTable({ stats, catalog }: { stats: readonly StatLine[]; catalog: Catalog | null }) {
  if (stats.length === 0) return NO_CHANGES;
  const { words, names } = wording(catalog);
  return (
    <ul className="stats" aria-label="Stats">
      {stats.map((line, i) => (
        <StatRow key={`${line.stat}-${line.stage}-${line.operation}-${i}`} label={statLabel(words, line.stat)} {...line} words={words} names={names} />
      ))}
    </ul>
  );
}

/** The game's MODIFIERS list; `stats` stands in while `groups` is null (a verdict stored before them). */
export function Modifiers({ groups, stats, catalog }: { groups: readonly ModifierGroup[] | null; stats: readonly StatLine[]; catalog: Catalog | null }) {
  if (groups === null) return <StatsTable stats={stats} catalog={catalog} />;
  if (groups.length === 0) return NO_CHANGES;
  const { words, names } = wording(catalog);
  return (
    <div className="stats-groups" aria-label="Modifiers">
      {groups.map((group) => (
        <section key={group.category} className="stats-group" aria-label={group.label} data-category={group.category}>
          <div className="stats-group__header">
            <span className="stats-group__title">{group.label}</span>
            <span className="stats-group__count">{group.rows.length}</span>
          </div>
          <ul className="stats">
            {group.rows.map((row) => (
              <StatRow key={`${row.stat}-${row.operation}`} {...row} words={words} names={names} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
