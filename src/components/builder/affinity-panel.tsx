// Affinity points: the hull's level sets how many there are to spend, each module type takes up to its
// cap, and threshold choices open once a type holds enough points (the catalog's affinity tree).
import { useState, type Dispatch } from "react";
import type { OpenProgression } from "#/lib/engine/types";
import { Panel } from "#/components/ui";
import { canAllocate, choiceTiers, earnedPoints, levelOf, pointsAt, selectionAt, totalPoints, typePoints } from "./affinity";
import type { BuilderCatalog } from "./rules";
import type { BuilderAction } from "./state";

export function AffinityPanel({ cat, progression, dispatch }: { cat: BuilderCatalog; progression: OpenProgression; dispatch: Dispatch<BuilderAction> }) {
  const affinity = cat.catalog.affinity;
  const level = levelOf(affinity, progression.affinityXp);
  const earned = earnedPoints(affinity, progression.affinityXp);
  const spent = totalPoints(progression);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Panel
      title="AFFINITY"
      className="affinity"
      aside={
        <span className={spent < earned ? "affinity__unspent" : "note"}>
          {spent}/{earned} POINTS
        </span>
      }
    >
      <div className="affinity__ship">
        <label className="field affinity__level">
          SHIP LEVEL
          <select className="select" value={level} onChange={(event) => dispatch({ type: "level", level: Number(event.target.value) })}>
            {Array.from({ length: affinity.maxLevel }, (_, i) => i + 1).map((each) => (
              <option key={each} value={each}>
                LVL {each}
              </option>
            ))}
          </select>
        </label>
        <p className="note">
          ONE POINT PER LEVEL. {affinity.maxPointsPerCategory} PER TYPE, {affinity.maxPointsPerBonus} PER BONUS.
        </p>
      </div>
      <ul className="affinity__types">
        {affinity.types.map((type) => {
          const points = typePoints(progression, type.moduleType);
          const expanded = open === type.moduleType;
          const tiers = choiceTiers(type);
          return (
            <li key={type.moduleType} className={`affinity-type ${points > 0 ? "affinity-type--spent" : ""}`}>
              <button type="button" className="affinity-type__head" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : type.moduleType)}>
                <span>{type.optionName || type.name}</span>
                <span className="affinity-type__points">
                  {points}/{affinity.maxPointsPerCategory}
                </span>
              </button>
              {expanded && (
                <div className="affinity-type__body">
                  {type.bonuses.map((bonus) => {
                    const at = pointsAt(progression, type.moduleType, bonus.option);
                    return (
                      <div key={bonus.option} className="affinity-bonus">
                        <div className="affinity-bonus__text">
                          <span>{bonus.name}</span>
                          <span className="note">{bonus.description}</span>
                        </div>
                        <div className="stepper">
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`Take a point from ${bonus.name}`}
                            disabled={at === 0}
                            onClick={() => dispatch({ type: "allocate", moduleType: type.moduleType, option: bonus.option, delta: -1 })}
                          >
                            −
                          </button>
                          <span className="stepper__value">{at}</span>
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`Add a point to ${bonus.name}`}
                            disabled={!canAllocate(affinity, progression, type.moduleType, bonus.option)}
                            onClick={() => dispatch({ type: "allocate", moduleType: type.moduleType, option: bonus.option, delta: 1 })}
                          >
                            +
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {tiers.map((tier) => {
                    const reached = points >= tier.requiredPoints;
                    const chosen = selectionAt(progression, type.moduleType, tier.tier);
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
                              onClick={() => dispatch({ type: "threshold", moduleType: type.moduleType, tier: tier.tier, choice: chosen === choice.option ? null : choice.option })}
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
