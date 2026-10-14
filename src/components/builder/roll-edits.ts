// Edits to one roll (the hull's or a module's), each limited to what rules.ts says the catalog allows.
// An edit the rules don't allow returns the roll unchanged. When an edit changes what the roll needs
// (a rarity's modifier count, a template, a heretical inversion, a harmonic set's ciphers), the roll is
// brought to the nearest choice the rules allow, so a builder fit only moves between producible rolls.
// The engine still judges every result. Pure: no React.
import type { OpenModifier, OpenPort, OpenRoll } from "#/lib/engine/types";
import {
  addableModifiers,
  artifactOptions,
  canFracture,
  canInvert,
  canMirror,
  clampToRange,
  entriesFor,
  grantFor,
  harmonicOptions,
  ascendedOptions,
  hereticalOptions,
  inversionCount,
  invertValue,
  isGrantOnly,
  isTemplated,
  midpoint,
  modifierCount,
  portOptions,
  qualityOptions,
  rarityOptions,
  regaliaOptions,
  rolledValue,
  samePort,
  templateOf,
  templateRange,
  tierOptions,
  typeOverrideOptions,
  valueRange,
  type BuilderCatalog,
  type PoolOption,
  type RollSubject,
  type Slot,
} from "./rules";

const raw = (value: number) => String(Math.round(value));

/** The roll a freshly fitted item has: Standard (or its first quality), Normal, identified, bare. */
export function defaultRoll(subject: RollSubject): OpenRoll {
  const qualities = qualityOptions(subject);
  return bare({
    quality: qualities.includes("Standard") ? "Standard" : (qualities[0] ?? "Standard"),
    rarity: "Normal",
    modifiers: [],
    ports: [],
    artifact: null,
    regalia: null,
    heretical: null,
    ascended: null,
    moduleTypeOverride: null,
    isIdentified: true,
    isHarmonized: false,
    isMirrored: false,
    harmonicSet: null,
    scaledStat: null,
  });
}

/** No modifiers, ports, references, type or copy: what Faction-issue gear and authored grants hold. */
function bare(roll: OpenRoll): OpenRoll {
  return {
    ...roll,
    modifiers: [],
    ports: [],
    artifact: null,
    regalia: null,
    heretical: null,
    ascended: null,
    moduleTypeOverride: null,
    isHarmonized: false,
    isMirrored: false,
    harmonicSet: null,
    scaledStat: null,
  };
}

function lineFrom(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, option: PoolOption): OpenModifier | null {
  const tiers = option.entry.tiers.filter((tier) => tier.allowed).map((tier) => tier.tier);
  if (tiers.length === 0) return null;
  const tier = Math.max(...tiers);
  const draft: OpenModifier = { stat: option.entry.stat, operation: option.entry.operation, tier, value: "0", slot: option.slot, isInverted: false, isFractured: false };
  const range = valueRange(cat, subject, { ...roll, modifiers: [draft] }, 0, tier);
  return range ? { ...draft, value: raw(midpoint(range)) } : null;
}

/** Adds lines from the pool until the rarity's minimum is met. */
function fill(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll): OpenRoll {
  let next = roll;
  while (next.modifiers.length < modifierCount(cat, subject, next).min) {
    const option = addableModifiers(cat, subject, next)[0];
    const line = option && lineFrom(cat, subject, next, option);
    if (!line) break;
    next = { ...next, modifiers: [...next.modifiers, line] };
  }
  return next;
}

/** Keeps the lines the pool still has and the rarity can hold, with no inversion; drops the rest. */
function keepPoolLines(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll): OpenRoll {
  const kept: OpenModifier[] = [];
  const max = modifierCount(cat, subject, roll).max;
  for (const modifier of roll.modifiers) {
    if (kept.length >= max) break;
    const line = modifier.isInverted ? { ...modifier, isInverted: false, value: raw(rolledValue(modifier)) } : modifier;
    const probe = { ...roll, modifiers: [...kept, line] };
    if (entriesFor(cat, subject, probe, line).length === 0) continue;
    const range = valueRange(cat, subject, probe, kept.length, line.tier);
    if (!range) continue;
    kept.push({ ...line, value: raw(clampToRange(range, Number(line.value))) });
  }
  return { ...roll, modifiers: kept };
}

const flip = (modifier: OpenModifier, inverted: boolean): OpenModifier =>
  modifier.isInverted === inverted ? modifier : { ...modifier, isInverted: inverted, value: raw(invertValue(modifier.operation, Number(modifier.value))) };

/**
 * A Heretical item carries one inverted line, two with an ascended form; any other none. The lines already
 * inverted stay so while they can be, and the first lines that can be fill the rest.
 */
function settleInversion(roll: OpenRoll): OpenRoll {
  const count = inversionCount(roll);
  const chosen = roll.modifiers.flatMap((modifier, index) => (modifier.isInverted && canInvert(roll, index) ? [index] : [])).slice(0, count);
  for (let index = 0; index < roll.modifiers.length && chosen.length < count; index++)
    if (!chosen.includes(index) && canInvert(roll, index)) chosen.push(index);
  return { ...roll, modifiers: roll.modifiers.map((modifier, index) => flip(modifier, chosen.includes(index))) };
}

function applyTemplate(cat: BuilderCatalog, roll: OpenRoll): OpenRoll {
  const template = templateOf(cat, roll);
  if (!template) return { ...roll, modifiers: [], scaledStat: null };
  const modifiers = template.lines.map((line, index): OpenModifier => {
    const range = templateRange(cat, roll, index);
    return { stat: line.stat, operation: line.operation, tier: line.tier, value: raw(range ? midpoint(range) : 0), slot: 0, isInverted: false, isFractured: false };
  });
  const scaled = template.scaledStat;
  return {
    ...roll,
    modifiers,
    isMirrored: false,
    scaledStat: scaled ? { rule: scaled.rule, strength: raw((Number(scaled.min) + Number(scaled.max)) / 2) } : null,
  };
}

/** Gives the item the set's ciphers: its ports keep their places, with candidates added or dropped to match. */
function applyHarmonicSet(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, setDef: string): OpenRoll {
  const set = cat.harmonicSets.get(setDef);
  if (!set) return roll;
  const ports: OpenPort[] = roll.ports.slice(0, set.ciphers.length).map((port) => ({ ...port }));
  for (const candidate of subject.portRules.candidates) {
    if (ports.length >= set.ciphers.length) break;
    if (!ports.some((port) => samePort(port, candidate))) ports.push({ row: candidate.row, col: candidate.col, direction: candidate.direction, cipher: null });
  }
  return { ...roll, harmonicSet: setDef, isHarmonized: true, ports: ports.map((port, index) => ({ ...port, cipher: set.ciphers[index] ?? null })) };
}

/** Puts the roll in the shape its rarity needs, keeping what it can. */
function settleRarity(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll): OpenRoll {
  if (isGrantOnly(subject, roll) || roll.quality === "Faction") return bare(roll);
  switch (roll.rarity) {
    case "Artifact":
    case "Regalia":
      return applyTemplate(cat, roll);
    case "Harmonic": {
      const set = harmonicOptions(cat, subject, roll).find((each) => each.def === roll.harmonicSet) ?? harmonicOptions(cat, subject, roll)[0];
      return set ? applyHarmonicSet(cat, subject, { ...roll, modifiers: [] }, set.def) : { ...roll, modifiers: [] };
    }
    case "Heretical": {
      const specials = hereticalOptions(cat, subject, roll);
      const heretical = specials.some((special) => special.def === roll.heretical) ? roll.heretical : (specials[0]?.def ?? null);
      const next = { ...roll, heretical };
      const ascended = ascendedOptions(cat, subject, next).some((form) => form.def === roll.ascended) ? roll.ascended : null;
      return settleInversion(fill(cat, subject, keepPoolLines(cat, subject, { ...next, ascended })));
    }
    default:
      return fill(cat, subject, keepPoolLines(cat, subject, roll));
  }
}

function withoutReferences(roll: OpenRoll, rarity: string): OpenRoll {
  const wasTemplated = isTemplated(roll.rarity);
  return {
    ...roll,
    rarity,
    modifiers: wasTemplated ? [] : roll.modifiers,
    artifact: null,
    regalia: null,
    heretical: rarity === "Heretical" ? roll.heretical : null,
    ascended: rarity === "Heretical" ? roll.ascended : null,
    harmonicSet: rarity === "Harmonic" ? roll.harmonicSet : null,
    isHarmonized: false,
    scaledStat: null,
  };
}

export function setQuality(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, quality: string): OpenRoll {
  if (roll.quality === quality || !qualityOptions(subject).includes(quality)) return roll;
  let next: OpenRoll = { ...roll, quality };
  if (quality === "Faction") next = bare({ ...next, rarity: "Normal" });
  const rarities = rarityOptions(cat, subject, next);
  if (!rarities.includes(next.rarity)) next = withoutReferences(next, rarities.includes("Normal") ? "Normal" : (rarities[0] ?? "Normal"));
  return settleRarity(cat, subject, next);
}

export function setRarity(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, rarity: string): OpenRoll {
  if (roll.rarity === rarity || !rarityOptions(cat, subject, roll).includes(rarity)) return roll;
  let next = withoutReferences(roll, rarity);
  if (rarity === "Artifact") next = { ...next, artifact: artifactOptions(cat, subject)[0]?.def ?? null };
  if (rarity === "Regalia") next = { ...next, regalia: regaliaOptions(cat, subject)[0]?.def ?? null };
  return settleRarity(cat, subject, next);
}

/** Applies an authored grant's roll: its quality and rarity, bare. */
export function applyGrant(subject: RollSubject, roll: OpenRoll, quality: string, rarity: string): OpenRoll {
  const grant = grantFor(subject, quality, rarity);
  return grant ? bare({ ...roll, quality: grant.quality, rarity: grant.rarity, isIdentified: grant.isIdentified }) : roll;
}

export function setArtifact(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, def: string): OpenRoll {
  if (roll.rarity !== "Artifact" || roll.artifact === def || !artifactOptions(cat, subject).some((each) => each.def === def)) return roll;
  return applyTemplate(cat, { ...roll, artifact: def });
}

export function setRegalia(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, def: string): OpenRoll {
  if (roll.rarity !== "Regalia" || roll.regalia === def || !regaliaOptions(cat, subject).some((each) => each.def === def)) return roll;
  return applyTemplate(cat, { ...roll, regalia: def });
}

/** Sets the special; an ascended form of another heresy, or beside an older item's form, is dropped. */
export function setHeretical(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, def: string): OpenRoll {
  if (roll.rarity !== "Heretical" || !hereticalOptions(cat, subject, roll).some((each) => each.def === def)) return roll;
  const next = { ...roll, heretical: def };
  const keeps = ascendedOptions(cat, subject, next).some((form) => form.def === roll.ascended);
  return settleInversion({ ...next, ascended: keeps ? roll.ascended : null });
}

/** Adds or clears the ascended form beside the special; an ascended brand inverts a second line. */
export function setAscended(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, def: string | null): OpenRoll {
  if (roll.ascended === def) return roll;
  if (def !== null && !ascendedOptions(cat, subject, roll).some((form) => form.def === def)) return roll;
  return settleInversion({ ...roll, ascended: def });
}

export function setHarmonicSet(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, def: string): OpenRoll {
  if (roll.rarity !== "Harmonic" || !harmonicOptions(cat, subject, roll).some((each) => each.def === def)) return roll;
  return applyHarmonicSet(cat, subject, roll, def);
}

/** Sets or clears the THOTH type; lines, specials and sets the new type can't hold are replaced. */
export function setTypeOverride(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, type: string | null): OpenRoll {
  if (roll.moduleTypeOverride === type) return roll;
  if (type !== null && !typeOverrideOptions(subject, roll).includes(type)) return roll;
  let next: OpenRoll = { ...roll, moduleTypeOverride: type };
  if (next.rarity === "Heretical" && hereticalOptions(cat, subject, next).length === 0) next = withoutReferences(next, "Prototype");
  if (next.rarity === "Harmonic" && harmonicOptions(cat, subject, next).length === 0) next = withoutReferences(next, "Normal");
  return settleRarity(cat, subject, next);
}

export function addModifier(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, line: { stat: string; operation: string; slot: Slot }): OpenRoll {
  const option = addableModifiers(cat, subject, roll).find(
    (each) => each.entry.stat === line.stat && each.entry.operation === line.operation && each.slot === line.slot,
  );
  const modifier = option && lineFrom(cat, subject, roll, option);
  if (!modifier) return roll;
  return settleInversion({ ...roll, modifiers: [...roll.modifiers, modifier] });
}

export function removeModifier(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, index: number): OpenRoll {
  if (isTemplated(roll.rarity) || index < 0 || index >= roll.modifiers.length) return roll;
  if (roll.modifiers.length <= modifierCount(cat, subject, roll).min) return roll;
  return settleInversion({ ...roll, modifiers: roll.modifiers.filter((_, each) => each !== index) });
}

function replaceLine(roll: OpenRoll, index: number, line: OpenModifier): OpenRoll {
  return { ...roll, modifiers: roll.modifiers.map((modifier, each) => (each === index ? line : modifier)) };
}

/** Stores an un-inverted value, clamped into the line's range, inverting it again if the line is. */
function withValue(modifier: OpenModifier, rolled: number): OpenModifier {
  return { ...modifier, value: raw(modifier.isInverted ? invertValue(modifier.operation, rolled) : rolled) };
}

export function setModifierTier(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, index: number, tier: number): OpenRoll {
  const modifier = roll.modifiers[index];
  if (!modifier || modifier.tier === tier || !tierOptions(cat, subject, roll, modifier).includes(tier)) return roll;
  const range = valueRange(cat, subject, roll, index, tier);
  if (!range) return roll;
  return replaceLine(roll, index, withValue({ ...modifier, tier }, clampToRange(range, rolledValue(modifier))));
}

/** `rolled` is the value before any inversion, in raw FP. */
export function setModifierValue(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, index: number, rolled: number): OpenRoll {
  const modifier = roll.modifiers[index];
  const range = modifier && valueRange(cat, subject, roll, index, modifier.tier);
  if (!modifier || !range || !Number.isFinite(rolled)) return roll;
  return replaceLine(roll, index, withValue(modifier, clampToRange(range, rolled)));
}

export function setModifierFractured(roll: OpenRoll, index: number, fractured: boolean): OpenRoll {
  const modifier = roll.modifiers[index];
  if (!modifier || modifier.isFractured === fractured || !canFracture(roll, index)) return roll;
  return replaceLine(roll, index, { ...modifier, isFractured: fractured });
}

/**
 * Inverts this line of a Heretical item in place of another: the one inverted line moves here, and of an
 * ascended item's two the line inverted first gives way.
 */
export function setModifierInverted(roll: OpenRoll, index: number): OpenRoll {
  if (!canInvert(roll, index) || roll.modifiers[index]!.isInverted) return roll;
  const inverted = roll.modifiers.flatMap((modifier, each) => (modifier.isInverted ? [each] : []));
  const kept = inverted.slice(Math.max(0, inverted.length - (inversionCount(roll) - 1)));
  return { ...roll, modifiers: roll.modifiers.map((modifier, each) => flip(modifier, each === index || kept.includes(each))) };
}

export function setScaledStrength(cat: BuilderCatalog, roll: OpenRoll, strength: number): OpenRoll {
  const scaled = templateOf(cat, roll)?.scaledStat;
  if (!scaled || !roll.scaledStat || !Number.isFinite(strength)) return roll;
  const [low, high] = [Number(scaled.min), Number(scaled.max)].sort((a, b) => a - b);
  return { ...roll, scaledStat: { rule: scaled.rule, strength: raw(Math.min(high!, Math.max(low!, strength))) } };
}

/** Opens or closes a port at a candidate cell. A harmonic item's ports take its set's ciphers in order. */
export function togglePort(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, at: { row: number; col: number; direction: string }): OpenRoll {
  const options = portOptions(subject, roll);
  if (!options.editable || !options.candidates.some((candidate) => samePort(candidate, at))) return roll;
  const existing = roll.ports.findIndex((port) => samePort(port, at));
  let ports: OpenPort[];
  if (existing >= 0) ports = roll.ports.filter((_, index) => index !== existing);
  else if (roll.ports.length < options.max) ports = [...roll.ports, { row: at.row, col: at.col, direction: at.direction, cipher: null }];
  else return roll;
  const set = roll.harmonicSet ? cat.harmonicSets.get(roll.harmonicSet) : undefined;
  if (roll.rarity === "Harmonic" && set) ports = ports.map((port, index) => ({ ...port, cipher: set.ciphers[index] ?? null }));
  return { ...roll, ports };
}

/** Slots a Tek Cipher into a port, or empties it. A harmonic item's ciphers are its set's. */
export function setPortCipher(cat: BuilderCatalog, roll: OpenRoll, index: number, cipher: string | null): OpenRoll {
  const port = roll.ports[index];
  if (!port || roll.rarity === "Harmonic" || port.cipher === cipher) return roll;
  if (cipher !== null && !cat.ciphers.has(cipher)) return roll;
  return { ...roll, ports: roll.ports.map((each, i) => (i === index ? { ...each, cipher } : each)) };
}

export function setMirrored(subject: RollSubject, roll: OpenRoll, mirrored: boolean): OpenRoll {
  if (roll.isMirrored === mirrored || (mirrored && !canMirror(subject, roll))) return roll;
  return { ...roll, isMirrored: mirrored };
}

/** The rarities whose modifiers the game rolls from a pool, and so the engine can roll (POST /v1/roll). */
export const ROLLED_RARITIES: readonly string[] = ["Augmented", "Prototype"];

const sameRoll = (a: OpenRoll, b: OpenRoll) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The engine's roll of this roll's modifiers. Only the modifiers are taken, and only while the roll is still
 * the one sent: an answer that arrives after another edit, or for another rarity, changes nothing.
 */
export function takeRolledModifiers(roll: OpenRoll, sent: OpenRoll, rolled: OpenRoll): OpenRoll {
  if (!sameRoll(roll, sent) || !ROLLED_RARITIES.includes(roll.rarity) || rolled.rarity !== roll.rarity) return roll;
  if (JSON.stringify(rolled.modifiers) === JSON.stringify(roll.modifiers)) return roll;
  return { ...roll, modifiers: rolled.modifiers.map((modifier) => ({ ...modifier })) };
}
