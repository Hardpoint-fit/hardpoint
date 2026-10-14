// What the builder may offer for a roll, read from the engine's catalog (catalog v2, CatalogBuilder.cs).
// The engine publishes its roll rules there (RollRules.cs) so the builder offers only choices the
// engine accepts; nothing here judges a fit. Where the catalog leaves a cap implicit, the comment names
// the game rule it follows. Pure: no React.
import type {
  Catalog,
  CatalogArtifact,
  CatalogAuthoredRoll,
  CatalogCipher,
  CatalogHarmonicSet,
  CatalogHereticalSpecial,
  CatalogHull,
  CatalogItem,
  CatalogModifierSlots,
  CatalogPoolEntry,
  CatalogPortCandidate,
  CatalogPortRules,
  CatalogRegalia,
  CatalogRoll,
  CatalogScaledStatRange,
  CatalogSlotPlacement,
  CatalogTemplateLine,
  OpenModifier,
  OpenRoll,
} from "#/lib/engine/types";
import { isIntegerValued } from "#/lib/fits/stat-format";

/** FP's 1.0 as a raw value (16 fractional bits). */
export const FP_ONE = 65536;

export type BuilderCatalog = {
  catalog: Catalog;
  hulls: Map<string, CatalogHull>;
  items: Map<string, CatalogItem>;
  artifacts: Map<string, CatalogArtifact>;
  regalia: Map<string, CatalogRegalia>;
  hereticals: Map<string, CatalogHereticalSpecial>;
  harmonicSets: Map<string, CatalogHarmonicSet>;
  ciphers: Map<string, CatalogCipher>;
  /** Every module type's pool, for a THOTH type override. */
  pools: Map<string, CatalogModifierSlots>;
  /** Regalia set def to its name and piece count, as the grid model reads it. */
  regaliaSets: Map<string, { name: string; pieces: number }>;
  /** Item slot type to the cells it may cover and the hardpoint it needs (placement.ts reads it). */
  placement: Map<string, CatalogSlotPlacement>;
};

const byDef = <T extends { def: string }>(list: readonly T[]) => new Map(list.map((entry) => [entry.def, entry]));

export function indexCatalog(catalog: Catalog): BuilderCatalog {
  return {
    catalog,
    hulls: byDef(catalog.hulls),
    items: byDef(catalog.items),
    artifacts: byDef(catalog.artifacts),
    regalia: byDef(catalog.regalia),
    hereticals: byDef(catalog.hereticalSpecials),
    harmonicSets: byDef(catalog.harmonicSets),
    ciphers: byDef(catalog.ciphers),
    pools: new Map(catalog.modifierPools.map((pool) => [pool.moduleType, pool.modifiers])),
    regaliaSets: new Map(catalog.regaliaSets.map((set) => [set.def, { name: set.name, pieces: set.pieces.length }])),
    placement: new Map(catalog.placement.map((rule) => [rule.slotType, rule])),
  };
}

/** The hull or a module, with the catalog facts its roll rules read. */
export type RollSubject = {
  kind: "hull" | "module";
  def: string;
  name: string;
  category: string;
  /** The definition's own ModuleType ("None" for many turrets and every hull). */
  moduleType: string;
  roll: CatalogRoll;
  portRules: CatalogPortRules;
};

const NO_PORTS: CatalogPortRules = { maxPorts: 0, candidates: [] };

export function hullSubject(cat: BuilderCatalog, def: string): RollSubject | null {
  const hull = cat.hulls.get(def);
  return hull ? { kind: "hull", def, name: hull.name, category: "Ship", moduleType: "None", roll: hull.roll, portRules: NO_PORTS } : null;
}

export function moduleSubject(cat: BuilderCatalog, def: string): RollSubject | null {
  const item = cat.items.get(def);
  return item
    ? { kind: "module", def, name: item.name, category: item.category, moduleType: item.moduleType, roll: item.roll, portRules: item.portRules }
    : null;
}

export const isTemplated = (rarity: string) => rarity === "Artifact" || rarity === "Regalia";

// ---- Quality and rarity -----------------------------------------------------------------------

/** Every quality the item rolls, plus any an authored grant gives it. */
export function qualityOptions(subject: RollSubject): string[] {
  const qualities = [...subject.roll.qualities];
  for (const grant of subject.roll.authored) if (!qualities.includes(grant.quality)) qualities.push(grant.quality);
  return qualities;
}

/** The rarities drops, crafting and consumables reach at a quality: Faction-issue gear stays Normal. */
function rolledRarities(subject: RollSubject, quality: string): string[] {
  if (!subject.roll.qualities.includes(quality)) return [];
  return quality === "Faction" ? subject.roll.rarities.filter((rarity) => rarity === "Normal") : subject.roll.rarities;
}

export function grantFor(subject: RollSubject, quality: string, rarity: string): CatalogAuthoredRoll | null {
  return subject.roll.authored.find((grant) => grant.quality === quality && grant.rarity === rarity) ?? null;
}

/** A roll only an authored grant explains: it must stay bare (no modifiers, ports or references). */
export function isGrantOnly(subject: RollSubject, roll: Pick<OpenRoll, "quality" | "rarity">): boolean {
  return !rolledRarities(subject, roll.quality).includes(roll.rarity) && grantFor(subject, roll.quality, roll.rarity) !== null;
}

/**
 * The rarities to offer at the roll's quality. A rarity that needs a reference (artifact, regalia piece,
 * heretical special, harmonic set) is offered only when the catalog has one this item can take now.
 */
export function rarityOptions(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll): string[] {
  const options = rolledRarities(subject, roll.quality).filter((rarity) => {
    const probe = { ...roll, rarity };
    switch (rarity) {
      case "Artifact":
        return artifactOptions(cat, subject).length > 0;
      case "Regalia":
        return regaliaOptions(cat, subject).length > 0;
      case "Heretical":
        return hereticalOptions(cat, subject, probe).length > 0;
      case "Harmonic":
        return harmonicOptions(cat, subject, probe).length > 0;
      default:
        return true;
    }
  });
  for (const grant of subject.roll.authored) if (grant.quality === roll.quality && !options.includes(grant.rarity)) options.push(grant.rarity);
  return options;
}

// ---- References -------------------------------------------------------------------------------

export function artifactOptions(cat: BuilderCatalog, subject: RollSubject): CatalogArtifact[] {
  return subject.roll.artifacts.flatMap((def) => cat.artifacts.get(def) ?? []);
}

export function regaliaOptions(cat: BuilderCatalog, subject: RollSubject): CatalogRegalia[] {
  return subject.roll.regalia.flatMap((def) => cat.regalia.get(def) ?? []);
}

/** ModuleTypeRules.Resolve: the THOTH type, else the definition's own. Heretical specials key on it. */
export function effectiveType(subject: RollSubject, roll: Pick<OpenRoll, "moduleTypeOverride">): string {
  return roll.moduleTypeOverride ?? subject.moduleType;
}

/** ModifierRoller.PoolModuleType: a hull, and an item of no type, roll and match harmonics as Hull. */
export function poolType(subject: RollSubject, roll: Pick<OpenRoll, "moduleTypeOverride">): string {
  if (subject.kind === "hull") return "Hull";
  const type = effectiveType(subject, roll);
  return type === "None" ? "Hull" : type;
}

/** The specials a GULLVEIG BRAND gives this item's effective type. */
export function hereticalOptions(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll): CatalogHereticalSpecial[] {
  if (subject.kind !== "module" || !subject.roll.rarities.includes("Heretical")) return [];
  if (roll.moduleTypeOverride === null) return subject.roll.hereticals.flatMap((def) => cat.hereticals.get(def) ?? []);
  return cat.catalog.hereticalSpecials.filter((special) => special.moduleTypes.includes(roll.moduleTypeOverride!));
}

/** The harmonic sets a Cipher Key completes on this item at its effective type and port count. */
export function harmonicOptions(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll): CatalogHarmonicSet[] {
  if (subject.kind !== "module" || roll.quality === "Faction") return [];
  const type = poolType(subject, roll);
  return subject.roll.harmonicSets.flatMap((def) => {
    const set = cat.harmonicSets.get(def);
    if (!set || set.ciphers.length === 0 || set.ciphers.length > subject.portRules.maxPorts) return [];
    return set.moduleTypes.length === 0 || set.moduleTypes.includes(type) ? [set] : [];
  });
}

/** THOTH types: modules only, never Faction-issue (FactionQuartermasterRules). */
export function typeOverrideOptions(subject: RollSubject, roll: OpenRoll): string[] {
  if (roll.quality === "Faction" || isGrantOnly(subject, roll)) return [];
  return subject.roll.typeOverrides;
}

/** YATA copies anything but an artifact, a regalia piece or Faction-issue gear. */
export function canMirror(subject: RollSubject, roll: OpenRoll): boolean {
  return !isTemplated(roll.rarity) && roll.quality !== "Faction" && !isGrantOnly(subject, roll);
}

export function patinaMax(cat: BuilderCatalog, roll: OpenRoll): number {
  return roll.artifact ? (cat.artifacts.get(roll.artifact)?.patinaMax ?? 0) : 0;
}

// ---- Modifiers --------------------------------------------------------------------------------

/** ModifierSlot: 0 prefix, 1 suffix. */
export type Slot = 0 | 1;

/**
 * At most two prefixes and two suffixes: ModifierRoller.GetPrefixCap / GetSuffixCap at Prototype, which
 * NORN keeps (RollRules.ModifierError checks the same cap).
 */
export const SLOT_CAP = 2;

export type PoolOption = { slot: Slot; entry: CatalogPoolEntry };

/** The pool entries the roll can draw from: its own pool, and with a THOTH type every adapter type's pool. */
export function poolOptions(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll): PoolOption[] {
  const options: PoolOption[] = [];
  const seen = new Set<string>();
  const add = (slots: CatalogModifierSlots | undefined) => {
    if (!slots) return;
    ([0, 1] as const).forEach((slot) => {
      for (const entry of slot === 0 ? slots.prefix : slots.suffix) {
        if (entry.onlyOnModule !== null && entry.onlyOnModule !== subject.def) continue;
        const key = `${slot}|${entry.pool}|${entry.stat}|${entry.operation}|${entry.group}`;
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({ slot, entry });
      }
    });
  };
  add(subject.roll.modifierPool);
  if (roll.moduleTypeOverride !== null) for (const type of subject.roll.typeOverrides) add(cat.pools.get(type));
  return options;
}

/** Template lines and scaled stat of the roll's artifact or regalia piece. */
export function templateOf(
  cat: BuilderCatalog,
  roll: Pick<OpenRoll, "rarity" | "artifact" | "regalia">,
): { lines: CatalogTemplateLine[]; scaledStat: CatalogScaledStatRange | null } | null {
  const template =
    roll.rarity === "Artifact" && roll.artifact ? cat.artifacts.get(roll.artifact) : roll.rarity === "Regalia" && roll.regalia ? cat.regalia.get(roll.regalia) : undefined;
  return template ? { lines: template.modifiers, scaledStat: template.scaledStat } : null;
}

/** How many modifiers the roll holds (RarityRoller.GetModifierCountRange; a template its line count). */
export function modifierCount(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll): { min: number; max: number } {
  if (isTemplated(roll.rarity)) {
    const lines = templateOf(cat, roll)?.lines.length ?? 0;
    return { min: lines, max: lines };
  }
  if (isGrantOnly(subject, roll)) return { min: 0, max: 0 };
  const count = subject.roll.modifierCounts.find((entry) => entry.rarity === roll.rarity);
  return count ? { min: count.min, max: count.max } : { min: 0, max: 0 };
}

const sameLine = (option: PoolOption, modifier: Pick<OpenModifier, "stat" | "operation" | "slot">) =>
  option.entry.stat === modifier.stat && option.entry.operation === modifier.operation && option.slot === modifier.slot;

/** The pool entries a rolled line can have come from. */
export function entriesFor(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, modifier: Pick<OpenModifier, "stat" | "operation" | "slot">): PoolOption[] {
  return poolOptions(cat, subject, roll).filter((option) => sameLine(option, modifier));
}

/** Nonzero modifier groups the roll's lines are tied to: a line whose every candidate shares one group. */
function usedGroups(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, except = -1): Set<number> {
  const used = new Set<number>();
  roll.modifiers.forEach((modifier, index) => {
    if (index === except) return;
    const groups = new Set(entriesFor(cat, subject, roll, modifier).map((option) => option.entry.group));
    if (groups.size === 1) {
      const [group] = groups;
      if (group !== 0) used.add(group!);
    }
  });
  return used;
}

/**
 * The lines that can still be added: free stat and operation, room in their slot and in the rarity's
 * count, an allowed tier, and no modifier group already taken. One option per stat, operation and slot.
 */
export function addableModifiers(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll): PoolOption[] {
  if (isTemplated(roll.rarity)) return [];
  if (roll.modifiers.length >= modifierCount(cat, subject, roll).max) return [];
  const taken = new Set(roll.modifiers.map((modifier) => `${modifier.stat}|${modifier.operation}`));
  const inSlot = (slot: Slot) => roll.modifiers.filter((modifier) => modifier.slot === slot).length;
  const groups = usedGroups(cat, subject, roll);
  const result: PoolOption[] = [];
  const offered = new Set<string>();
  for (const option of poolOptions(cat, subject, roll)) {
    const key = `${option.entry.stat}|${option.entry.operation}`;
    if (taken.has(key) || offered.has(`${key}|${option.slot}`)) continue;
    if (inSlot(option.slot) >= SLOT_CAP) continue;
    if (option.entry.group !== 0 && groups.has(option.entry.group)) continue;
    if (!option.entry.tiers.some((tier) => tier.allowed)) continue;
    offered.add(`${key}|${option.slot}`);
    result.push(option);
  }
  return result;
}

/** The tiers a line can show: those some candidate entry allows (RollRules.TierAllowed). */
export function tierOptions(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, modifier: OpenModifier): number[] {
  if (isTemplated(roll.rarity)) return [modifier.tier];
  const tiers = new Set<number>();
  for (const option of entriesFor(cat, subject, roll, modifier)) for (const tier of option.entry.tiers) if (tier.allowed) tiers.add(tier.tier);
  return [...tiers].sort((a, b) => a - b);
}

export type ValueRange = {
  /** Raw FP, inclusive, of the un-inverted value. */
  min: number;
  max: number;
  /** Raw step: whole numbers for an integer-valued Add stat (ModifierRoller.UsesWholeNumbers). */
  step: number;
};

function rangeOf(stat: string, operation: string, min: string, max: string): ValueRange | null {
  let low = Number(min);
  let high = Number(max);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  if (low > high) [low, high] = [high, low];
  if (operation === "Add" && isIntegerValued(stat)) {
    low = Math.ceil(low / FP_ONE) * FP_ONE;
    high = Math.floor(high / FP_ONE) * FP_ONE;
    if (low > high) return null;
    return { min: low, max: high, step: FP_ONE };
  }
  return { min: low, max: high, step: 1 };
}

/** The range of a template's line (ModifierRoller.TryGetRollRange), which KISHAR rerolls within. */
export function templateRange(cat: BuilderCatalog, roll: Pick<OpenRoll, "rarity" | "artifact" | "regalia">, index: number): ValueRange | null {
  const line = templateOf(cat, roll)?.lines[index];
  return line ? rangeOf(line.stat, line.operation, line.min, line.max) : null;
}

/** The value range of a line at a tier: the template's line, or the first candidate entry allowing the tier. */
export function valueRange(cat: BuilderCatalog, subject: RollSubject, roll: OpenRoll, index: number, tier: number): ValueRange | null {
  const modifier = roll.modifiers[index];
  if (!modifier) return null;
  if (isTemplated(roll.rarity)) return templateRange(cat, roll, index);
  for (const option of entriesFor(cat, subject, roll, modifier)) {
    const data = option.entry.tiers.find((each) => each.tier === tier && each.allowed);
    if (data) {
      const range = rangeOf(modifier.stat, modifier.operation, data.min, data.max);
      if (range) return range;
    }
  }
  return null;
}

export function midpoint(range: ValueRange): number {
  const mid = (range.min + range.max) / 2;
  return clampToRange(range, mid);
}

export function clampToRange(range: ValueRange, value: number): number {
  const clamped = Math.min(range.max, Math.max(range.min, value));
  return range.step === 1 ? Math.round(clamped) : range.min + Math.round((clamped - range.min) / range.step) * range.step;
}

/** HereticalRules.Invert: a brand mirrors a Multiply around 1 and negates anything else. */
export function invertValue(operation: string, raw: number): number {
  return operation === "Multiply" ? 2 * FP_ONE - raw : -raw;
}

/** The value as rolled, before a brand inverted it: what the tier range bounds. */
export function rolledValue(modifier: OpenModifier): number {
  const raw = Number(modifier.value);
  return modifier.isInverted ? invertValue(modifier.operation, raw) : raw;
}

/** STYX fractures one line, never an inverted one, and never a template's. */
export function canFracture(roll: OpenRoll, index: number): boolean {
  const modifier = roll.modifiers[index];
  if (!modifier || isTemplated(roll.rarity) || modifier.isInverted) return false;
  return modifier.isFractured || !roll.modifiers.some((other) => other.isFractured);
}

/** A brand inverts one line of a Heretical item: not a fractured one, never VENDOR LICENSE (HereticalRules.CanInvert). */
export function canInvert(roll: OpenRoll, index: number): boolean {
  const modifier = roll.modifiers[index];
  return roll.rarity === "Heretical" && modifier !== undefined && !modifier.isFractured && modifier.stat !== "MerchantSystem";
}

// ---- Ports ------------------------------------------------------------------------------------

export type PortOptions = { max: number; candidates: CatalogPortCandidate[]; editable: boolean };

/** Ports: modules only, never on Faction-issue gear, at most the catalog's count, at its candidate cells. */
export function portOptions(subject: RollSubject, roll: OpenRoll): PortOptions {
  const editable = subject.kind === "module" && subject.portRules.maxPorts > 0 && roll.quality !== "Faction" && !isGrantOnly(subject, roll);
  return { max: subject.portRules.maxPorts, candidates: subject.portRules.candidates, editable };
}

export const samePort = (a: { row: number; col: number; direction: string }, b: { row: number; col: number; direction: string }) =>
  a.row === b.row && a.col === b.col && a.direction === b.direction;

// ---- Ammo -------------------------------------------------------------------------------------

/** The ammo a turret can be set to: its payloads. */
export function ammoOptions(item: CatalogItem | undefined): string[] {
  return item?.payloads ?? [];
}
