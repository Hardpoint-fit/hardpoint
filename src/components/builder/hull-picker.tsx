// Where a new fit starts: every hull in the build by class, with its role and grid size.
import { Panel } from "#/components/ui";
import { roleName } from "./labels";
import type { BuilderCatalog } from "./rules";

export function HullPicker({ cat, current, onPick, onCancel }: { cat: BuilderCatalog; current?: string | null; onPick: (hull: string) => void; onCancel?: () => void }) {
  const classes = new Map<string, typeof cat.catalog.hulls>();
  for (const hull of cat.catalog.hulls) classes.set(hull.shipClass, [...(classes.get(hull.shipClass) ?? []), hull]);
  return (
    <Panel
      title={current ? "CHANGE HULL" : "CHOOSE A HULL"}
      aside={
        onCancel ? (
          <button type="button" className="btn btn--quiet btn--small" onClick={onCancel}>
            CANCEL
          </button>
        ) : undefined
      }
    >
      {current && <p className="note">MODULES STAY WHERE THEY ARE. THE ENGINE MARKS ANY THAT NO LONGER FIT.</p>}
      {[...classes].map(([shipClass, hulls]) => (
        <section key={shipClass} className="hull-group" aria-label={shipClass}>
          <h2 className="hull-group__title">{shipClass.toUpperCase()}</h2>
          <ul className="hull-list">
            {hulls
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((hull) => {
                const open = hull.slots.filter((slot) => slot !== "None").length;
                return (
                  <li key={hull.def}>
                    <button type="button" className={`hull-card ${hull.def === current ? "hull-card--current" : ""}`} onClick={() => onPick(hull.def)} aria-pressed={hull.def === current}>
                      <span className="hull-card__name">{hull.name}</span>
                      <span className="hull-card__meta">
                        {roleName(hull.role)} · {open} CELLS
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </Panel>
  );
}
