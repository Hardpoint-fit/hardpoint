// The item inspector: the selected module's (or the hull's) roll, every control limited to what the
// catalog's rules allow (rules.ts). Edits dispatch to the reducer, which applies the same rules again.
import type { Dispatch, ReactNode } from "react";
import type { CatalogItem, OpenFit, OpenModifier, OpenRoll } from "#/lib/engine/types";
import { formatStatValue, statLabel, statTone } from "#/lib/fits/stat-format";
import { Panel } from "#/components/ui";
import { enumWords, rarityName } from "./labels";
import { ItemDescription, ItemIcon } from "#/components/item-text";
import { RolledFacts } from "#/components/rolled-facts";
import { catalogFacts } from "#/lib/engine/item-facts";
import { itemIcon } from "#/lib/art/item-icon";
import {
  FP_ONE,
  addableModifiers,
  ammoOptions,
  artifactOptions,
  ascendedOptions,
  canFracture,
  canInvert,
  canMirror,
  harmonicOptions,
  hereticalOptions,
  hullSubject,
  inversionCount,
  isGrantOnly,
  isTemplated,
  modifierCount,
  moduleSubject,
  patinaMax,
  portOptions,
  qualityOptions,
  rarityOptions,
  regaliaOptions,
  rolledValue,
  samePort,
  templateOf,
  tierOptions,
  typeOverrideOptions,
  valueRange,
  type BuilderCatalog,
  type RollSubject,
} from "./rules";
import type { BuilderAction, RollEdit, Target } from "./state";

/** A modifier's raw FP as the game shows it: a Multiply as the change from 1. */
export function modifierText(stat: string, operation: string, raw: number): { text: string; tone: string } {
  const value = raw / FP_ONE;
  const change = operation === "Multiply" ? value - 1 : value;
  return { text: formatStatValue(stat, operation, change), tone: statTone(stat, change).toLowerCase() };
}

const TIER_OF_RARITY: Record<string, string> = {
  Normal: "standard",
  Augmented: "augmented",
  Prototype: "prototype",
  Artifact: "artifact",
  Regalia: "regalia",
  Harmonic: "harmonic",
  Heretical: "heretical",
};

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="inspector__section">
      <header className="inspector__heading">
        <span>{title}</span>
        {aside !== undefined && <span className="inspector__heading-aside">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function Choices({ label, options, value, onChange, render, className }: { label: string; options: string[]; value: string; onChange: (value: string) => void; render: (value: string) => ReactNode; className?: (value: string) => string }) {
  return (
    <div className="choices" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === value}
          className={`choice ${option === value ? "choice--on" : ""} ${className?.(option) ?? ""}`}
          onClick={() => onChange(option)}
        >
          {render(option)}
        </button>
      ))}
    </div>
  );
}

function ReferenceSelect({ label, value, options, onChange }: { label: string; value: string | null; options: { def: string; name: string; note?: string }[]; onChange: (def: string) => void }) {
  return (
    <label className="field">
      {label}
      <select className="select" value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
        {value === null && <option value="">CHOOSE</option>}
        {options.map((option) => (
          <option key={option.def} value={option.def}>
            {option.name}
            {option.note ? ` · ${option.note}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function ModifierRow({
  cat,
  subject,
  roll,
  index,
  removable,
  edit,
}: {
  cat: BuilderCatalog;
  subject: RollSubject;
  roll: OpenRoll;
  index: number;
  removable: boolean;
  edit: (edit: RollEdit) => void;
}) {
  const modifier: OpenModifier = roll.modifiers[index]!;
  const range = valueRange(cat, subject, roll, index, modifier.tier);
  const tiers = tierOptions(cat, subject, roll, modifier);
  const shown = modifierText(modifier.stat, modifier.operation, Number(modifier.value));
  const templated = isTemplated(roll.rarity);
  const label = statLabel(modifier.stat);
  return (
    <li className={`modifier ${modifier.isInverted ? "modifier--inverted" : ""}`}>
      <div className="modifier__head">
        <span className="modifier__name">
          {label}
          <span className="modifier__slot">{modifier.slot === 0 ? "PREFIX" : "SUFFIX"}</span>
        </span>
        <b className={`modifier__value tone-${shown.tone}`}>{shown.text}</b>
      </div>
      <div className="modifier__controls">
        {templated ? (
          <span className="plate__tier-badge">T{modifier.tier}</span>
        ) : (
          <select className="select select--small" aria-label={`${label} tier`} value={modifier.tier} onChange={(event) => edit({ kind: "modifierTier", index, tier: Number(event.target.value) })}>
            {tiers.map((tier) => (
              <option key={tier} value={tier}>
                T{tier}
              </option>
            ))}
          </select>
        )}
        {range && range.min < range.max ? (
          <input
            className="slider"
            type="range"
            min={range.min}
            max={range.max}
            step={range.step}
            value={rolledValue(modifier)}
            aria-label={`${label} value`}
            aria-valuetext={shown.text}
            onChange={(event) => edit({ kind: "modifierValue", index, value: Number(event.target.value) })}
          />
        ) : (
          <span className="slider slider--fixed note">FIXED</span>
        )}
        {removable && (
          <button type="button" className="icon-btn" aria-label={`Remove ${label}`} onClick={() => edit({ kind: "removeModifier", index })}>
            ×
          </button>
        )}
      </div>
      {!templated && (canFracture(roll, index) || canInvert(roll, index) || modifier.isFractured || modifier.isInverted) && (
        <div className="modifier__flags">
          {(canFracture(roll, index) || modifier.isFractured) && (
            <label className="check">
              <input type="checkbox" checked={modifier.isFractured} disabled={!canFracture(roll, index)} onChange={(event) => edit({ kind: "fractured", index, on: event.target.checked })} />
              FRACTURED
            </label>
          )}
          {roll.rarity === "Heretical" && (
            <label className="check">
              <input
                type={inversionCount(roll) > 1 ? "checkbox" : "radio"}
                name="inverted"
                checked={modifier.isInverted}
                disabled={!canInvert(roll, index) || (inversionCount(roll) > 1 && modifier.isInverted)}
                onChange={() => edit({ kind: "inverted", index })}
              />
              INVERTED
            </label>
          )}
        </div>
      )}
    </li>
  );
}

function AddModifier({ cat, subject, roll, edit }: { cat: BuilderCatalog; subject: RollSubject; roll: OpenRoll; edit: (edit: RollEdit) => void }) {
  const options = addableModifiers(cat, subject, roll);
  if (options.length === 0) return null;
  const key = (o: (typeof options)[number]) => `${o.slot}|${o.entry.stat}|${o.entry.operation}`;
  return (
    <label className="field">
      ADD A MODIFIER
      <select
        className="select"
        value=""
        onChange={(event) => {
          const option = options.find((each) => key(each) === event.target.value);
          if (option) edit({ kind: "addModifier", stat: option.entry.stat, operation: option.entry.operation, slot: option.slot });
        }}
      >
        <option value="">CHOOSE</option>
        {([0, 1] as const).map((slot) => (
          <optgroup key={slot} label={slot === 0 ? "PREFIX" : "SUFFIX"}>
            {options
              .filter((option) => option.slot === slot)
              .map((option) => (
                <option key={key(option)} value={key(option)}>
                  {statLabel(option.entry.stat)}
                  {option.entry.operation === "Multiply" ? "" : ` (${enumWords(option.entry.operation)})`}
                  {option.entry.pool.startsWith("Role:") ? " · ROLE" : option.entry.pool !== subject.moduleType ? ` · ${enumWords(option.entry.pool)}` : ""}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

const CELL = 30;

/** The module's rotation-0 shape with every port it can roll on its edge: press one to open or close it. */
function PortEditor({ cat, item, roll, edit }: { cat: BuilderCatalog; item: CatalogItem; roll: OpenRoll; edit: (edit: RollEdit) => void }) {
  const subject = moduleSubject(cat, item.def)!;
  const options = portOptions(subject, roll);
  const cells = item.shape.cells;
  const minRow = Math.min(...cells.map((c) => c.row)) - 1;
  const minCol = Math.min(...cells.map((c) => c.col)) - 1;
  const rows = Math.max(...cells.map((c) => c.row)) - minRow + 2;
  const cols = Math.max(...cells.map((c) => c.col)) - minCol + 2;
  const harmonic = roll.rarity === "Harmonic";
  const notch = (direction: string) => {
    switch (direction) {
      case "Up":
        return { left: CELL / 2 - 7, top: -3, width: 14, height: 6 };
      case "Down":
        return { left: CELL / 2 - 7, top: CELL - 3, width: 14, height: 6 };
      case "Left":
        return { left: -3, top: CELL / 2 - 7, width: 6, height: 14 };
      default:
        return { left: CELL - 3, top: CELL / 2 - 7, width: 6, height: 14 };
    }
  };
  return (
    <>
      <div className="port-editor" style={{ width: cols * CELL, height: rows * CELL }}>
        {cells.map((cell) => (
          <span key={`${cell.row},${cell.col}`} className="port-editor__cell" style={{ left: (cell.col - minCol) * CELL, top: (cell.row - minRow) * CELL, width: CELL, height: CELL }} />
        ))}
        {options.candidates.map((candidate) => {
          const index = roll.ports.findIndex((port) => samePort(port, candidate));
          const open = index >= 0;
          const at = notch(candidate.direction);
          const full = !open && roll.ports.length >= options.max;
          return (
            <button
              key={`${candidate.row},${candidate.col},${candidate.direction}`}
              type="button"
              className={`port-notch ${open ? "port-notch--open" : ""}`}
              style={{ left: (candidate.col - minCol) * CELL + at.left, top: (candidate.row - minRow) * CELL + at.top, width: at.width, height: at.height }}
              disabled={!options.editable || full}
              aria-pressed={open}
              aria-label={`${open ? "Close" : "Open"} the port facing ${candidate.direction.toLowerCase()} at row ${candidate.row - minRow}, column ${candidate.col - minCol}`}
              onClick={() => edit({ kind: "port", row: candidate.row, col: candidate.col, direction: candidate.direction })}
            />
          );
        })}
      </div>
      {roll.ports.length > 0 && (
        <ol className="ports">
          {roll.ports.map((port, index) => (
            <li key={`${port.row},${port.col},${port.direction}`} className="ports__row">
              <span className="ports__label">
                PORT {index + 1} · {enumWords(port.direction)}
              </span>
              <select
                className="select select--small"
                aria-label={`Tek Cipher in port ${index + 1}`}
                value={port.cipher ?? ""}
                disabled={harmonic}
                onChange={(event) => edit({ kind: "cipher", index, cipher: event.target.value || null })}
              >
                <option value="">EMPTY</option>
                {port.cipher && !cat.ciphers.has(port.cipher) && <option value={port.cipher}>UNKNOWN CIPHER</option>}
                {cat.catalog.ciphers.map((cipher) => (
                  <option key={cipher.def} value={cipher.def}>
                    {cipher.name} · {statLabel(cipher.stat)} {modifierText(cipher.stat, cipher.operation, Number(cipher.value)).text}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ol>
      )}
      {harmonic && <p className="note">THE HARMONIC SET FIXES THE CIPHERS; OPEN OR CLOSE PORTS TO MOVE THEM.</p>}
    </>
  );
}

export function Inspector({ cat, fit, target, dispatch }: { cat: BuilderCatalog; fit: OpenFit; target: Target | null; dispatch: Dispatch<BuilderAction> }) {
  if (target === null) {
    return (
      <Panel title="INSPECTOR">
        <p className="note">SELECT A MODULE ON THE GRID, OR THE HULL, TO SET ITS ROLL.</p>
        <button type="button" className="btn btn--quiet self-start" onClick={() => dispatch({ type: "select", target: "hull" })}>
          INSPECT HULL
        </button>
      </Panel>
    );
  }
  const item = target === "hull" ? fit.hull : fit.modules[target]?.item;
  const subject = target === "hull" ? hullSubject(cat, fit.hull.def) : item ? moduleSubject(cat, item.def) : null;
  const catalogItem = target === "hull" ? undefined : item ? cat.items.get(item.def) : undefined;
  const edit = (edit: RollEdit) => dispatch({ type: "roll", target, edit });

  if (!item) return null;
  if (!subject) {
    return (
      <Panel title="INSPECTOR">
        <p className="tone-negative">THIS ITEM ISN&apos;T IN THE CURRENT BUILD.</p>
        {target !== "hull" && (
          <button type="button" className="btn self-start" onClick={() => dispatch({ type: "remove", index: target })}>
            REMOVE
          </button>
        )}
      </Panel>
    );
  }

  const roll = item.roll;
  const tier = TIER_OF_RARITY[roll.rarity] ?? "standard";
  const count = modifierCount(cat, subject, roll);
  const grantOnly = isGrantOnly(subject, roll);
  const types = typeOverrideOptions(subject, roll);
  const ammo = target !== "hull" ? ammoOptions(catalogItem) : [];
  const currentAmmo = target !== "hull" ? (fit.ammo.find((each) => each.moduleIndex === target)?.ammoType ?? null) : null;
  const template = templateOf(cat, roll);
  const maxPatina = patinaMax(cat, roll);
  const ports = portOptions(subject, roll);
  const hull = target === "hull" ? cat.hulls.get(fit.hull.def) : undefined;
  const artifactArt = roll.artifact ? (cat.artifacts.get(roll.artifact)?.art ?? null) : null;
  const icon = catalogItem
    ? itemIcon({ art: catalogItem.art, category: catalogItem.category }, roll, artifactArt)
    : hull
      ? itemIcon({ art: hull.art, category: "Ship" }, roll, artifactArt)
      : null;

  return (
    <Panel
      title={target === "hull" ? "HULL" : "MODULE"}
      className={`inspector inspector--${tier}`}
      aside={
        target !== "hull" ? (
          <span className="flex gap-1">
            <button type="button" className="btn btn--quiet btn--small" onClick={() => dispatch({ type: "rotate" })} title="R">
              ROTATE
            </button>
            <button type="button" className="btn btn--quiet btn--small" onClick={() => dispatch({ type: "remove", index: target })} title="DELETE">
              REMOVE
            </button>
          </span>
        ) : undefined
      }
    >
      <div className="inspector__title">
        <ItemIcon src={icon} size={48} />
        <div>
          <div className={`inspector__name accent-${tier}`}>{subject.name}</div>
          <div className="note">
            {catalogItem ? `${enumWords(catalogItem.slotType)} · ${catalogItem.moduleType === "None" ? "NO TYPE" : enumWords(catalogItem.moduleType)}` : "HULL"}
            {roll.moduleTypeOverride ? ` · THOTH ${enumWords(roll.moduleTypeOverride)}` : ""}
          </div>
        </div>
      </div>
      {catalogItem && (
        <div className="inspector__about">
          <ItemDescription text={catalogItem.description} />
          <RolledFacts item={item} catalog={catalogFacts(catalogItem)} />
        </div>
      )}

      <Section title="QUALITY">
        <Choices
          label="Quality"
          options={qualityOptions(subject)}
          value={roll.quality}
          onChange={(quality) => edit({ kind: "quality", quality })}
          render={(quality) => quality.toUpperCase()}
          className={(quality) => `accent-quality-${quality.toLowerCase()}`}
        />
      </Section>

      <Section title="RARITY">
        <Choices
          label="Rarity"
          options={rarityOptions(cat, subject, roll)}
          value={roll.rarity}
          onChange={(rarity) => edit(isGrantOnly(subject, { quality: roll.quality, rarity }) ? { kind: "grant", quality: roll.quality, rarity } : { kind: "rarity", rarity })}
          render={rarityName}
          className={(rarity) => `accent-${TIER_OF_RARITY[rarity] ?? "standard"}`}
        />
        {grantOnly && <p className="note">A GRANTED ROLL: NO MODIFIERS, PORTS OR COPIES.</p>}
        {roll.rarity === "Artifact" && (
          <ReferenceSelect label="ARTIFACT" value={roll.artifact} options={artifactOptions(cat, subject)} onChange={(def) => edit({ kind: "artifact", def })} />
        )}
        {roll.rarity === "Regalia" && (
          <ReferenceSelect
            label="REGALIA PIECE"
            value={roll.regalia}
            options={regaliaOptions(cat, subject).map((piece) => ({ ...piece, note: piece.set ? cat.regaliaSets.get(piece.set)?.name : undefined }))}
            onChange={(def) => edit({ kind: "regalia", def })}
          />
        )}
        {roll.rarity === "Heretical" && (
          <ReferenceSelect
            label="HERETICAL SPECIAL"
            value={roll.heretical}
            options={hereticalOptions(cat, subject, roll).map((special) => ({ ...special, note: special.ascended ? "ASCENDED" : enumWords(special.heresy) }))}
            onChange={(def) => edit({ kind: "heretical", def })}
          />
        )}
        {roll.rarity === "Heretical" && ascendedOptions(cat, subject, roll).length > 0 && (
          <label className="field">
            ASCENDED FORM
            <select className="select" value={roll.ascended ?? ""} onChange={(event) => edit({ kind: "ascended", def: event.target.value || null })}>
              <option value="">NONE</option>
              {ascendedOptions(cat, subject, roll).map((form) => (
                <option key={form.def} value={form.def}>
                  {form.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {roll.rarity === "Harmonic" && (
          <ReferenceSelect label="HARMONIC SET" value={roll.harmonicSet} options={harmonicOptions(cat, subject, roll)} onChange={(def) => edit({ kind: "harmonicSet", def })} />
        )}
      </Section>

      {types.length > 0 && (
        <Section title="THOTH TYPE">
          <select className="select" aria-label="THOTH type" value={roll.moduleTypeOverride ?? ""} onChange={(event) => edit({ kind: "typeOverride", type: event.target.value || null })}>
            <option value="">NONE</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {enumWords(type)}
              </option>
            ))}
          </select>
        </Section>
      )}

      {(count.max > 0 || roll.modifiers.length > 0) && (
        <Section title="MODIFIERS" aside={count.min === count.max ? `${roll.modifiers.length}/${count.max}` : `${roll.modifiers.length} · ${count.min} TO ${count.max}`}>
          <ul className="modifiers">
            {roll.modifiers.map((_, index) => (
              <ModifierRow key={index} cat={cat} subject={subject} roll={roll} index={index} removable={!isTemplated(roll.rarity) && roll.modifiers.length > count.min} edit={edit} />
            ))}
          </ul>
          <AddModifier cat={cat} subject={subject} roll={roll} edit={edit} />
        </Section>
      )}

      {template?.scaledStat && roll.scaledStat && (
        <Section title="SCALED STAT" aside={enumWords(template.scaledStat.rule)}>
          <input
            className="slider"
            type="range"
            min={Math.min(Number(template.scaledStat.min), Number(template.scaledStat.max))}
            max={Math.max(Number(template.scaledStat.min), Number(template.scaledStat.max))}
            step={1}
            value={Number(roll.scaledStat.strength)}
            aria-label="Scaled stat strength"
            onChange={(event) => edit({ kind: "scaledStrength", value: Number(event.target.value) })}
          />
          <span className="note">STRENGTH {(Number(roll.scaledStat.strength) / FP_ONE).toFixed(2)}</span>
        </Section>
      )}

      {maxPatina > 0 && (
        <Section title="PATINA" aside={`${item.patina}/${maxPatina}`}>
          <input className="slider" type="range" min={0} max={maxPatina} step={1} value={item.patina} aria-label="Patina" onChange={(event) => dispatch({ type: "patina", target, value: Number(event.target.value) })} />
        </Section>
      )}

      {catalogItem && ports.max > 0 && (
        <Section title="PORTS" aside={`${roll.ports.length}/${ports.max}`}>
          {ports.editable ? <PortEditor cat={cat} item={catalogItem} roll={roll} edit={edit} /> : <p className="note">{roll.quality === "Faction" ? "FACTION-ISSUE GEAR HAS NO PORTS." : "THIS ROLL HAS NO PORTS."}</p>}
        </Section>
      )}

      {ammo.length > 0 && typeof target === "number" && (
        <Section title="AMMO">
          <select className="select" aria-label="Ammo" value={currentAmmo ?? ""} onChange={(event) => dispatch({ type: "ammo", index: target, ammoType: event.target.value || null })}>
            <option value="">NONE</option>
            {ammo.map((payload) => (
              <option key={payload} value={payload}>
                {enumWords(payload)}
              </option>
            ))}
          </select>
        </Section>
      )}

      {(canMirror(subject, roll) || roll.isMirrored) && (
        <label className="check">
          <input type="checkbox" checked={roll.isMirrored} onChange={(event) => edit({ kind: "mirrored", on: event.target.checked })} />
          MIRRORED (YATA COPY)
        </label>
      )}
    </Panel>
  );
}
