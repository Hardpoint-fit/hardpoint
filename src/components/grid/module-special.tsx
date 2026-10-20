// A rolled item's special in the item tooltip's plate rows: a regalia piece's set, its pieces and the
// bonuses linking more of them adds, an artifact's ability, a harmonic set's ciphers, a heretical special.
// Also the fit-wide list of regalia sets with their bonuses. What each line says is the API's wording
// (specials.ts); a bonus not yet reached is drawn dim.
import { formatStatValue, statLabel, statTone, type StatWords } from "#/lib/fits/stat-format";
import type { BonusTier, RollSpecial, SetSummary } from "./specials";

/** FP's 1.0 as a raw value (16 fractional bits). */
const FP_ONE = 65536;

const enumUpper = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();

function BonusTiers({ tiers }: { tiers: readonly BonusTier[] }) {
  return (
    <>
      {tiers.map((tier) => (
        <div key={tier.pieces} className={`bonus-tier ${tier.active ? "bonus-tier--on" : ""}`}>
          <span className="bonus-tier__count" aria-label={`${tier.pieces} linked`}>
            {tier.pieces}
          </span>
          <div className="bonus-tier__lines">
            {tier.lines.map((line, i) => (
              <div key={i} className="plate__row">
                <span>{line.label}</span>
                <b className={tier.active ? `tone-${line.tone.toLowerCase()}` : undefined}>
                  {line.value}
                  {line.unit && <span className="facts__unit"> {line.unit}</span>}
                </b>
              </div>
            ))}
            {tier.effects.map((effect, i) => (
              <div key={`e${i}`} className="bonus-tier__effect">
                {effect}
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function cipherValue(words: StatWords, stat: string, operation: string, raw: string): { text: string; tone: string } {
  const value = Number(raw) / FP_ONE;
  const change = operation === "Multiply" ? value - 1 : value;
  return { text: formatStatValue(words, stat, operation, change), tone: statTone(words, stat, change).toLowerCase() };
}

/** The special's rows, starting with a divider. */
export function SpecialDetails({ special, words }: { special: RollSpecial; words: StatWords }) {
  switch (special.kind) {
    case "regalia":
      return (
        <>
          <div className="plate__divider" />
          <div className="plate__row special__head">
            <span className="accent-regalia">{special.setName ?? "REGALIA"}</span>
            <b className="accent-regalia">
              {special.linked}/{special.size} LINKED
            </b>
          </div>
          {special.pieces.length > 1 &&
            special.pieces.map((piece) => (
              <div key={piece.def} className={`plate__row special__piece ${piece.linked ? "special__piece--on" : ""}`}>
                <span>{piece.name}</span>
                {piece.slotType && <b>{enumUpper(piece.slotType)}</b>}
              </div>
            ))}
          {special.own.length > 0 && (
            <>
              <div className="plate__heading">LINKED BONUS</div>
              <BonusTiers tiers={special.own} />
            </>
          )}
          {special.bonuses.length > 0 && (
            <>
              <div className="plate__heading">SET BONUSES</div>
              <BonusTiers tiers={special.bonuses} />
            </>
          )}
        </>
      );
    case "artifact":
      if (!special.ability) return null;
      return (
        <>
          <div className="plate__divider" />
          <div className="plate__row special__head">
            <span className="accent-artifact">{special.ability.name}</span>
            {special.targeting && <b>{enumUpper(special.targeting)}</b>}
          </div>
          <p className="item-desc">{special.ability.description}</p>
        </>
      );
    case "harmonic":
      return (
        <>
          <div className="plate__divider" />
          <div className="plate__row special__head">
            <span className="accent-harmonic">{special.name}</span>
            <b className="accent-harmonic">HARMONIC SET</b>
          </div>
          {special.description && <p className="item-desc">{special.description}</p>}
          {special.ciphers.length > 0 && <div className="plate__heading">CIPHERS {special.ciphers.length}</div>}
          {special.ciphers.map((cipher, i) => {
            const value = cipherValue(words, cipher.stat, cipher.operation, cipher.value);
            return (
              <div key={i} className="plate__row">
                <span>{cipher.name}</span>
                <b>
                  {statLabel(words, cipher.stat)} <span className={`tone-${value.tone}`}>{value.text}</span>
                </b>
              </div>
            );
          })}
        </>
      );
    case "heretical":
      return (
        <>
          <div className="plate__divider" />
          <div className="plate__row special__head">
            <span className="accent-heretical">{special.name}</span>
            <b className="accent-heretical">{enumUpper(special.heresy)}</b>
          </div>
          {special.ascended && (
            <div className="plate__row">
              <span>ASCENDED</span>
              <b className="accent-heretical">{special.ascended}</b>
            </div>
          )}
        </>
      );
  }
}

/** The fit's regalia sets, each with its linked count and every bonus, those not reached dim. */
export function SetBonusList({ sets }: { sets: readonly SetSummary[] }) {
  return (
    <ul className="set-bonuses" aria-label="Regalia sets">
      {sets.map((set) => (
        <li key={set.set} className="set-bonuses__set">
          <div className="plate__row special__head">
            <span className="accent-regalia">{set.name}</span>
            <b className="accent-regalia">
              {set.linked}/{set.size} LINKED
            </b>
          </div>
          <BonusTiers tiers={set.bonuses} />
        </li>
      ))}
    </ul>
  );
}
