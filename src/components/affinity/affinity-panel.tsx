// The AFFINITY panel, one renderer for the builder and the fit page: the hull's level sets how many
// points there are to spend, each module type takes up to its cap, and threshold choices open once a type
// holds enough points (the catalog's affinity tree). Without `editor` it is read-only: the stored
// progression as text, with no control rendered.
import type { CatalogAffinity, OpenProgression } from "#/lib/engine/types";
import { Panel } from "#/components/ui";
import { affinityTypeLabel, canAllocate, choiceTiers, earnedPoints, hasAffinity, levelOf, pointsAt, selectionAt, totalPoints, typePoints } from "./affinity";
import "./affinity.css";

/** What the builder adds to make the panel editable: the open type and what each control does. */
export type AffinityEditor = {
  open: string | null;
  onToggle: (moduleType: string) => void;
  onLevel: (level: number) => void;
  onAllocate: (moduleType: string, option: number, delta: 1 | -1) => void;
  onThreshold: (moduleType: string, tier: number, choice: number | null) => void;
};

export function AffinityPanel({ affinity, progression, editor }: { affinity: CatalogAffinity; progression: OpenProgression; editor?: AffinityEditor }) {
  const layout = affinity.layout;
  if (!layout) {
    // An older engine: it sends the affinity tree without saying where a fit keeps its points.
    return (
      <Panel title="AFFINITY" className="affinity">
        <p className="note">AFFINITY POINTS AREN&apos;T AVAILABLE FROM THE ENGINE RIGHT NOW.</p>
        {progression.affinityType !== "None" && <p className="note">{affinityTypeLabel(affinity, progression.affinityType)} AFFINITY · SHIP LEVEL {levelOf(affinity, progression.affinityXp)}</p>}
      </Panel>
    );
  }
  const level = levelOf(affinity, progression.affinityXp);
  const earned = earnedPoints(affinity, progression.affinityXp);
  const spent = totalPoints(progression);

  if (!editor && !hasAffinity(affinity, progression)) {
    return (
      <Panel title="AFFINITY" className="affinity">
        <p className="note">NO AFFINITY.</p>
      </Panel>
    );
  }

  return (
    <Panel
      title="AFFINITY"
      className="affinity"
      aside={
        <span className={spent < earned ? "affinity__unspent" : "note"}>
          {spent}/{earned} AFFINITY POINTS
        </span>
      }
    >
      <div className="affinity__ship">
        {editor ? (
          <label className="field affinity__level">
            SHIP LEVEL
            <select className="select" value={level} onChange={(event) => editor.onLevel(Number(event.target.value))}>
              {Array.from({ length: affinity.maxLevel }, (_, i) => i + 1).map((each) => (
                <option key={each} value={each}>
                  LVL {each}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="affinity__facts">
            {progression.affinityType !== "None" && <span>{affinityTypeLabel(affinity, progression.affinityType)} AFFINITY</span>}
            <span>SHIP LEVEL {level}</span>
          </div>
        )}
        <p className="note">
          ONE POINT PER LEVEL. {affinity.maxPointsPerCategory} PER TYPE, {affinity.maxPointsPerBonus} PER BONUS.
        </p>
      </div>
      <ul className="affinity__types">
        {affinity.types.map((type) => {
          const points = typePoints(layout, progression, type.moduleType);
          const expanded = editor ? editor.open === type.moduleType : points > 0;
          const tiers = choiceTiers(type);
          const head = (
            <>
              <span>{type.optionName || type.name}</span>
              <span className="affinity-type__points">
                {points}/{affinity.maxPointsPerCategory}
              </span>
            </>
          );
          return (
            <li key={type.moduleType} className={`affinity-type ${points > 0 ? "affinity-type--spent" : ""}`}>
              {editor ? (
                <button type="button" className="affinity-type__head" aria-expanded={expanded} onClick={() => editor.onToggle(type.moduleType)}>
                  {head}
                </button>
              ) : (
                <div className="affinity-type__head affinity-type__head--static">{head}</div>
              )}
              {expanded && (
                <div className="affinity-type__body">
                  {type.bonuses
                    .filter((bonus) => editor || pointsAt(layout, progression, type.moduleType, bonus.option) > 0)
                    .map((bonus) => {
                      const at = pointsAt(layout, progression, type.moduleType, bonus.option);
                      return (
                        <div key={bonus.option} className="affinity-bonus">
                          <div className="affinity-bonus__text">
                            <span>{bonus.name}</span>
                            <span className="note">{bonus.description}</span>
                          </div>
                          {editor ? (
                            <div className="stepper">
                              <button
                                type="button"
                                className="icon-btn"
                                aria-label={`Take a point from ${bonus.name}`}
                                disabled={at === 0}
                                onClick={() => editor.onAllocate(type.moduleType, bonus.option, -1)}
                              >
                                −
                              </button>
                              <span className="stepper__value">{at}</span>
                              <button
                                type="button"
                                className="icon-btn"
                                aria-label={`Add a point to ${bonus.name}`}
                                disabled={!canAllocate(affinity, progression, type.moduleType, bonus.option)}
                                onClick={() => editor.onAllocate(type.moduleType, bonus.option, 1)}
                              >
                                +
                              </button>
                            </div>
                          ) : (
                            <span className="stepper__value">{at}</span>
                          )}
                        </div>
                      );
                    })}
                  {tiers.map((tier) => {
                    const reached = points >= tier.requiredPoints;
                    const chosen = selectionAt(layout, progression, type.moduleType, tier.tier);
                    if (!editor) {
                      if (!reached) return null;
                      const picked = tier.choices.find((choice) => choice.option === chosen);
                      return (
                        <div key={tier.tier} className="affinity-tier">
                          <span className="note">AT {tier.requiredPoints} POINTS</span>
                          {picked ? (
                            <div className="affinity-choice">
                              <span>{picked.name}</span>
                              <span className="note">{picked.description}</span>
                            </div>
                          ) : (
                            <span className="note">NO CHOICE MADE</span>
                          )}
                        </div>
                      );
                    }
                    return (
                      <div key={tier.tier} className={`affinity-tier ${reached ? "" : "affinity-tier--locked"}`}>
                        <span className="note">{reached ? `AT ${tier.requiredPoints} POINTS, CHOOSE ONE` : `NEEDS ${tier.requiredPoints} POINTS`}</span>
                        <div className="choices" role="radiogroup" aria-label={`${type.name} at ${tier.requiredPoints} points`}>
                          {tier.choices.map((choice) => (
                            <button
                              key={choice.option}
                              type="button"
                              role="radio"
                              aria-checked={chosen === choice.option}
                              className={`choice choice--wide ${chosen === choice.option ? "choice--on" : ""}`}
                              disabled={!reached}
                              title={choice.description}
                              onClick={() => editor.onThreshold(type.moduleType, tier.tier, chosen === choice.option ? null : choice.option)}
                            >
                              <span>{choice.name}</span>
                              <span className="note">{choice.description}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
