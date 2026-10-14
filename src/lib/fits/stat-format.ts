// How a stat line and its sources read, in the game's words (StatTypeText labels, ItemModifierText
// signs and tones). The wording is the catalog's `stats` (GET /v1/stats), indexed once per catalog by
// `statWords`. Pure: no React, no server-only import.
import type { Catalog, CatalogStat, StatLine, StatSource } from "../engine/types";

export type Tone = "Positive" | "Negative" | "Neutral";

/** The catalog's stats by id. A stat it doesn't list reads as its spaced enum name, higher is better. */
export type StatWords = ReadonlyMap<string, CatalogStat>;

const indexed = new WeakMap<readonly CatalogStat[], StatWords>();

/** The catalog's stats indexed by id, built once per list (the catalog's list is replaced on a new build). */
export function statWords(stats: readonly CatalogStat[]): StatWords {
  let words = indexed.get(stats);
  if (!words) {
    words = new Map(stats.map((stat) => [stat.id, stat]));
    indexed.set(stats, words);
  }
  return words;
}

/** The game's label for a stat; a stat the catalog doesn't word reads as its spaced enum name. */
export function statLabel(words: StatWords, stat: string): string {
  return words.get(stat)?.label ?? stat.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toUpperCase();
}

/** DisplayNumberText.FormatNumber: whole numbers from 100 up, one decimal below. */
export function formatNumber(value: number): string {
  if (Math.abs(value) >= 100) return Math.round(value).toLocaleString("en-US");
  return String(Math.round(value * 10) / 10);
}

function signed(text: string, value: number): string {
  return value > 0 ? `+${text}` : text;
}

/**
 * A breakdown value as the game shows a modifier: a Multiply is the change in percent (its sign flipped
 * where the game inverts it), a DamageReduction a percent, an Add the number itself (whole for
 * whole-number stats). Breakdown totals and sources are already the change, not the factor.
 */
export function formatStatValue(words: StatWords, stat: string, operation: string, value: number): string {
  if (operation === "Multiply") {
    // StatTypeText.InvertsDisplayedSign, which only a multiplier can (Stat.invertedSign).
    const shown = (words.get(stat)?.invertedSign ? -value : value) * 100;
    return `${signed(formatNumber(shown), shown)}%`;
  }
  if (operation === "DamageReduction") return `${signed(formatNumber(value * 100), value)}%`;
  const shown = isIntegerValued(words, stat) ? Math.round(value) : value;
  return signed(formatNumber(shown), shown);
}

/** StatTypeRules.IsIntegerValued: an Add of this stat rolls and shows whole numbers. */
export function isIntegerValued(words: StatWords, stat: string): boolean {
  return words.get(stat)?.integer ?? false;
}

/** Whether a change is good for the ship: higher is better unless the game says the stat is lower-better. */
export function statTone(words: StatWords, stat: string, value: number): Tone {
  if (value === 0) return "Neutral";
  const higherIsBetter = !words.get(stat)?.lowerIsBetter;
  return value > 0 === higherIsBetter ? "Positive" : "Negative";
}

/** Every catalog name an evaluation source can point at, by definition GUID. */
export function sourceNames(catalog: Pick<Catalog, "hulls" | "items" | "regaliaSets" | "regalia" | "artifacts" | "ciphers" | "harmonicSets" | "hereticalSpecials">): Map<string, string> {
  const names = new Map<string, string>();
  for (const list of [catalog.hulls, catalog.items, catalog.regaliaSets, catalog.regalia, catalog.artifacts, catalog.ciphers, catalog.harmonicSets, catalog.hereticalSpecials]) {
    for (const entry of list) names.set(entry.def, entry.name);
  }
  return names;
}

const KIND_LABELS: Record<string, string> = {
  Module: "MODULE",
  Hull: "HULL",
  RegaliaPiece: "REGALIA",
  RegaliaSet: "SET BONUS",
  Affinity: "AFFINITY",
};

export type SourceRow = { name: string; kind: string; value: string; tone: Tone; stacking: string | null };

/** One source of a stat line, named from the catalog when it can be. */
export function describeSource(words: StatWords, line: Pick<StatLine, "stat" | "operation">, source: StatSource, names: ReadonlyMap<string, string>): SourceRow {
  const kind = KIND_LABELS[source.kind] ?? statLabel(words, source.kind);
  const fromCatalog = source.asset ? names.get(source.asset) : undefined;
  const name =
    fromCatalog?.toUpperCase() ??
    (source.kind === "Affinity" && source.affinityType !== "None" ? `${statLabel(words, source.affinityType)} AFFINITY` : source.asset ? "UNKNOWN SOURCE" : kind);
  return {
    name,
    kind,
    value: formatStatValue(words, line.stat, line.operation, source.effective),
    tone: statTone(words, line.stat, source.effective),
    // A source the stacking rules scaled shows the share it kept.
    stacking: source.ratio !== 1 && !source.isStackingExempt ? `x${Math.round(source.ratio * 100) / 100}` : null,
  };
}
