// The game's Hull Specs panel, drawn from the engine's `sections` (the game's own HullSpecSections):
// a header per section with its headline value, then label / value / unit rows, the row's help in the
// game's hint bubble on hover or focus. The site formats nothing: every word, number and unit is the
// engine's (HullSpecsPanel.uss .fitting-stat-category, .fitting-stat-row, .stat-hint-bubble).
import type { SpecRow, SpecSection, SpecValue } from "#/lib/engine/types";

/** The row a section's header repeats, as the streamlined panel's hero and pillars pick them. */
const HEADLINES: Record<string, string> = {
  defense: "effective-health",
  offense: "damage-per-second",
  reactor: "time-to-scram",
  agility: "max-speed",
  targeting: "sensor-range",
};

const TONES: Record<string, string> = { Positive: "positive", Negative: "negative" };

function headline(section: SpecSection): SpecRow | null {
  const id = HEADLINES[section.id];
  if (id) return section.rows.find((row) => row.id === id) ?? null;
  // A guided weapon's section is named for it; its first row is its damage.
  return section.id.startsWith("guided-weapon") ? (section.rows[0] ?? null) : null;
}

function Value({ value, tone, unit = true }: { value: SpecValue; tone: string; unit?: boolean }) {
  return (
    <>
      <span className={`specs__value ${TONES[tone] ?? ""}`}>{value.text}</span>
      {unit && value.unit && <span className="specs__unit">{value.unit}</span>}
    </>
  );
}

function Row({ row }: { row: SpecRow }) {
  return (
    <li className="specs__row tip-anchor" tabIndex={0} data-spec={row.id}>
      <span className="specs__label">{row.label}</span>
      <span className="specs__values">
        {row.secondary ? (
          <>
            {/* A comparison: the stat before (no unit), an arrow, the stat now. */}
            <Value value={row.primary} tone={row.primaryTone} unit={false} />
            <span className="specs__arrow">→</span>
            <Value value={row.secondary} tone={row.secondaryTone} />
          </>
        ) : (
          <Value value={row.primary} tone={row.primaryTone} />
        )}
      </span>
      {(row.help.title || row.help.text) && (
        <div className="tip specs__tip">
          <div className="hint">
            <span className="hint__title">{row.help.title}</span>
            {row.help.statLabel && (
              <span className="hint__stat">
                {row.help.statLabel} <b>{row.help.statValue}</b>
              </span>
            )}
            <span className="hint__text">{row.help.text}</span>
          </div>
        </div>
      )}
    </li>
  );
}

export function HullSpecs({ sections }: { sections: readonly SpecSection[] }) {
  return (
    <div className="specs" aria-label="Hull specs">
      {sections.map((section) => {
        const lead = headline(section);
        const shown = lead ? (lead.secondary ?? lead.primary) : null;
        return (
          <section key={section.id} className="specs__section" aria-label={section.label}>
            <header className="specs__header">
              <span className="specs__title">{section.label}</span>
              {lead && shown && (
                <span className="specs__summary">
                  <Value value={shown} tone={lead.secondary ? lead.secondaryTone : lead.primaryTone} />
                </span>
              )}
            </header>
            <ul className="specs__rows">
              {section.rows.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Where the panel would be, for a stored verdict from before the engine sent hull specs. */
export const SPECS_PENDING = "STATS APPEAR AFTER THE NEXT CHECK.";
