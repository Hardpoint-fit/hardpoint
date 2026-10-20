// What makes a rolled item more than its base module, for the tooltip, the inspector and the set lists: a
// regalia piece's set and bonuses, an artifact's ability, a harmonic set's ciphers, a heretical special.
// Pure. The wording of bonus lines and effects is the API's (each line's `row`, each effect's
// `displayText`); how many pieces count is the evaluation's regalia group, since the game counts a set by
// its linked pieces. An older engine's catalog lacks the bonuses, which then read as none.
import type {
  CatalogArtifact,
  CatalogCipher,
  CatalogHarmonicSet,
  CatalogHereticalSpecial,
  CatalogItem,
  CatalogRegalia,
  CatalogRegaliaSet,
  CatalogSetBonus,
  CatalogTemplateLine,
  OpenRoll,
} from "#/lib/engine/types";

export type SpecialLookups = {
  items: ReadonlyMap<string, CatalogItem>;
  regalia: ReadonlyMap<string, CatalogRegalia>;
  regaliaSets: ReadonlyMap<string, CatalogRegaliaSet>;
  artifacts: ReadonlyMap<string, CatalogArtifact>;
  harmonicSets: ReadonlyMap<string, CatalogHarmonicSet>;
  hereticals: ReadonlyMap<string, CatalogHereticalSpecial>;
  ciphers: ReadonlyMap<string, CatalogCipher>;
};

const byDef = <T extends { def: string }>(list: readonly T[] | undefined) => new Map((list ?? []).map((entry) => [entry.def, entry]));

/** The lookups, built once per catalog. A catalog from before regalia, harmonic sets or specials has empty ones. */
export function specialLookups(catalog: {
  items: readonly CatalogItem[];
  regalia?: readonly CatalogRegalia[];
  regaliaSets: readonly CatalogRegaliaSet[];
  artifacts: readonly CatalogArtifact[];
  harmonicSets?: readonly CatalogHarmonicSet[];
  hereticalSpecials?: readonly CatalogHereticalSpecial[];
  ciphers: readonly CatalogCipher[];
}): SpecialLookups {
  return {
    items: byDef(catalog.items),
    regalia: byDef(catalog.regalia),
    regaliaSets: byDef(catalog.regaliaSets),
    artifacts: byDef(catalog.artifacts),
    harmonicSets: byDef(catalog.harmonicSets),
    hereticals: byDef(catalog.hereticalSpecials),
    ciphers: byDef(catalog.ciphers),
  };
}

/** A bonus line in the game's words. */
export type BonusLine = { label: string; value: string; unit: string | null; tone: string };

/** What a set adds at `pieces` linked; `active` once that many are. */
export type BonusTier = { pieces: number; active: boolean; lines: BonusLine[]; effects: string[] };

export type RegaliaPiece = { def: string; name: string; slotType: string | null; linked: boolean };

export type RegaliaSpecial = {
  kind: "regalia";
  name: string;
  set: string | null;
  setName: string | null;
  /** Pieces of the set linked with this one, itself included. */
  linked: number;
  /** Pieces in the whole set. */
  size: number;
  pieces: RegaliaPiece[];
  /** This piece's own bonus once linked. */
  own: BonusTier[];
  /** The set's bonuses. */
  bonuses: BonusTier[];
  /** Stats whose modifier reaches the whole ship rather than the module. */
  shipWide: string[];
};

export type ArtifactSpecial = {
  kind: "artifact";
  name: string;
  targeting: string | null;
  ability: { name: string; description: string } | null;
  shipWide: string[];
};

export type HarmonicSpecial = {
  kind: "harmonic";
  name: string;
  description: string;
  ciphers: { name: string; stat: string; operation: string; value: string }[];
};

export type HereticalSpecial = { kind: "heretical"; name: string; heresy: string; ascended: string | null };

export type RollSpecial = RegaliaSpecial | ArtifactSpecial | HarmonicSpecial | HereticalSpecial;

function tiers(bonuses: readonly CatalogSetBonus[] | undefined, linked: number): BonusTier[] {
  return [...(bonuses ?? [])]
    .sort((a, b) => a.pieces - b.pieces)
    .map((bonus) => ({
      pieces: bonus.pieces,
      active: linked >= bonus.pieces,
      lines: bonus.modifiers.map(({ row }) => ({ label: row.label, value: row.value, unit: row.unit, tone: row.tone })),
      effects: bonus.effects.map((effect) => effect.displayText || effect.text),
    }));
}

const shipWideStats = (lines: readonly CatalogTemplateLine[]) => [...new Set(lines.filter((line) => line.scope === "ShipWide").map((line) => line.stat))];

/**
 * The roll's special, or null for a plain roll or one naming something the catalog lacks. `linkedPieces`
 * are the regalia defs linked with this module, itself included (the evaluation's group); null when the
 * evaluation put it in no group, so it counts alone. `linkedCount` is the group's count when there is one.
 */
export function rollSpecial(
  lookups: SpecialLookups,
  roll: Pick<OpenRoll, "rarity" | "artifact" | "regalia" | "harmonicSet" | "heretical" | "ascended">,
  group: { linkedCount: number; linkedPieces: readonly string[] } | null = null,
): RollSpecial | null {
  if (roll.rarity === "Regalia" && roll.regalia) {
    const piece = lookups.regalia.get(roll.regalia);
    if (!piece) return null;
    const set = piece.set ? lookups.regaliaSets.get(piece.set) : undefined;
    const linked = group?.linkedCount ?? 1;
    const linkedPieces = new Set(group?.linkedPieces ?? [piece.def]);
    return {
      kind: "regalia",
      name: piece.name,
      set: piece.set,
      setName: set?.name ?? null,
      linked,
      size: set?.pieces.length ?? 1,
      pieces: (set?.pieces ?? [piece.def]).map((def) => {
        const each = lookups.regalia.get(def);
        return { def, name: each?.name ?? "UNKNOWN PIECE", slotType: (each && lookups.items.get(each.item)?.slotType) ?? null, linked: linkedPieces.has(def) };
      }),
      own: tiers(piece.linkedBonuses, linked),
      bonuses: tiers(set?.bonuses, linked),
      shipWide: shipWideStats(piece.modifiers),
    };
  }
  if (roll.rarity === "Artifact" && roll.artifact) {
    const artifact = lookups.artifacts.get(roll.artifact);
    if (!artifact) return null;
    return {
      kind: "artifact",
      name: artifact.name,
      targeting: artifact.ability ? (artifact.targeting ?? null) : null,
      ability: artifact.ability ?? null,
      shipWide: shipWideStats(artifact.modifiers),
    };
  }
  if (roll.harmonicSet) {
    const set = lookups.harmonicSets.get(roll.harmonicSet);
    if (!set) return null;
    return {
      kind: "harmonic",
      name: set.name,
      description: set.description,
      ciphers: set.ciphers.flatMap((def) => {
        const cipher = lookups.ciphers.get(def);
        return cipher ? [{ name: cipher.name, stat: cipher.stat, operation: cipher.operation, value: cipher.value }] : [];
      }),
    };
  }
  if (roll.rarity === "Heretical" && roll.heretical) {
    const special = lookups.hereticals.get(roll.heretical);
    if (!special) return null;
    return { kind: "heretical", name: special.name, heresy: special.heresy, ascended: roll.ascended ? (lookups.hereticals.get(roll.ascended)?.name ?? null) : null };
  }
  return null;
}

/** The name the game gives the rolled item: a regalia piece's or an artifact's own, else the module's. */
export function specialName(special: RollSpecial | null, base: string): string {
  return special?.kind === "regalia" || special?.kind === "artifact" ? special.name : base;
}

/** A regalia set as fitted: its linked count and bonuses, once per set (the group with most pieces linked). */
export type SetSummary = { set: string; name: string; linked: number; size: number; pieces: RegaliaPiece[]; bonuses: BonusTier[] };

export function setSummaries(specials: readonly (RollSpecial | null)[]): SetSummary[] {
  const best = new Map<string, RegaliaSpecial>();
  for (const special of specials) {
    if (special?.kind !== "regalia" || special.set === null) continue;
    const seen = best.get(special.set);
    if (!seen || special.linked > seen.linked) best.set(special.set, special);
  }
  return [...best.values()].map((special) => ({
    set: special.set!,
    name: special.setName ?? "REGALIA SET",
    linked: special.linked,
    size: special.size,
    pieces: special.pieces,
    bonuses: special.bonuses,
  }));
}
