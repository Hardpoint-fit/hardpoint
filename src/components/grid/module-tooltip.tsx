// A fitted module's tooltip, in the game's item tooltip shape (ItemTooltip.uss .mtt): icon, name, tier,
// quality and slot, the description and the stat lines, then what the engine said about it and its
// rolled modifiers in the game's words.
import { formatStatValue, statLabel, statTone } from "#/lib/fits/stat-format";
import { ItemDescription, ItemIcon } from "#/components/item-text";
import { TooltipFacts } from "#/components/rolled-facts";
import type { GridModule } from "./model";

/** An FP value as an open fit stores it: the raw 48.16 fixed-point integer, as a decimal string. */
export function fromRawFp(raw: string): number {
  return Number(raw) / 65536;
}

const RARITY_NAMES: Record<string, string> = { Normal: "STANDARD" };

export function ModuleTooltip({ module }: { module: GridModule }) {
  const quality = module.quality.toLowerCase();
  const filledPorts = module.ports.filter((port) => port.cipher !== null).length;
  return (
    <div className="plate">
      <div className="plate__head">
        <ItemIcon src={module.icon} size={32} />
        <div className="plate__head-text">
          <div className="plate__name">{module.name}</div>
          <div className="plate__sub">
            {module.known ? (
              <>
                <span className={`accent-${module.tier}`}>{RARITY_NAMES[module.rarity] ?? module.rarity.toUpperCase()}</span>
                <span className={`accent-quality-${quality}`}>{module.quality.toUpperCase()} QUALITY</span>
                {module.slotType && <span className="tone-neutral">{module.slotType.toUpperCase()}</span>}
              </>
            ) : (
              <span className="tone-negative">NOT IN THE CURRENT BUILD</span>
            )}
          </div>
        </div>
      </div>
      <ItemDescription text={module.description} />
      {module.known && <TooltipFacts item={module.item} catalogFacts={module.facts} />}
      {module.issues.length > 0 && (
        <>
          <div className="plate__divider" />
          {module.issues.map((issue, i) => (
            <div key={i} className="plate__row tone-negative">
              {issue.message.toUpperCase()}
            </div>
          ))}
        </>
      )}
      {(module.conduitConnections !== null || module.regalia || module.ports.length > 0 || module.ammo) && <div className="plate__divider" />}
      {module.conduitConnections !== null && (
        <div className="plate__row">
          CONDUIT LINKS <b>x{module.conduitConnections}</b>
        </div>
      )}
      {module.regalia && (
        <div className="plate__row">
          <span className="accent-regalia">{module.regalia.setName.toUpperCase()}</span>
          <b className="accent-regalia">
            {module.regalia.fittedCount}/{module.regalia.pieces}
          </b>
        </div>
      )}
      {module.ports.length > 0 && (
        <div className="plate__row">
          PORTS{" "}
          <b>
            {filledPorts}/{module.ports.length}
          </b>
        </div>
      )}
      {module.ammo && (
        <div className="plate__row">
          AMMO <b>{statLabel(module.ammo)}</b>
        </div>
      )}
      {module.modifiers.length > 0 && (
        <>
          <div className="plate__heading">MODIFIERS {module.modifiers.length}</div>
          {module.modifiers.map((modifier, i) => {
            const raw = fromRawFp(modifier.value);
            const change = modifier.operation === "Multiply" ? raw - 1 : raw;
            return (
              <div key={i} className="plate__row">
                <span>{statLabel(modifier.stat)}</span>
                <b className={`tone-${statTone(modifier.stat, change).toLowerCase()}`}>
                  {formatStatValue(modifier.stat, modifier.operation, change)}
                  {modifier.tier > 0 && <span className="plate__tier-badge">T{modifier.tier}</span>}
                </b>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
