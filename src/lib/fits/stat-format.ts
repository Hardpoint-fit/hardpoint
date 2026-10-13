// How a stat line and its sources read, in the game's words (StatTypeText labels, ItemModifierText
// signs and tones). The wording is generated from the game's source by scripts/prepare-game-assets.mjs.
// Pure: no React, no server-only import.
import type { Catalog, StatLine, StatSource } from "../engine/types";
import statText from "./stat-text.generated.json";

export type Tone = "Positive" | "Negative" | "Neutral";

type StatText = {
  labels: Record<string, string>;
  integer: string[];
  lowerIsBetter: string[];
  inverted: { stat: string; operation: string }[];
};

const TEXT = statText as StatText;

/** The game's label for a stat; a stat newer than the site reads as its spaced enum name. */
export function statLabel(stat: string): string {
  return TEXT.labels[stat] ?? stat.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toUpperCase();
}

/** DisplayNumberText.FormatNumber: whole numbers from 100 up, one decimal below. */
export function formatNumber(value: number): string {
  if (Math.abs(value) >= 100) return Math.round(value).toLocaleString("en-US");
  return String(Math.round(value * 10) / 10);
}

function signed(text: string, value: number): string {
  return value > 0 ? `+${text}` : text;
}

const inverts = (stat: string, operation: string) => TEXT.inverted.some((rule) => rule.stat === stat && rule.operation === operation);

/**
 * A breakdown value as the game shows a modifier: a Multiply is the change in percent (its sign flipped
 * where the game inverts it), a DamageReduction a percent, an Add the number itself (whole for
 * whole-number stats). Breakdown totals and sources are already the change, not the factor.
 */
export function formatStatValue(stat: string, operation: string, value: number): string {
  if (operation === "Multiply") {
    const shown = (inverts(stat, operation) ? -value : value) * 100;
    return `${signed(formatNumber(shown), shown)}%`;
  }
  if (operation === "DamageReduction") return `${signed(formatNumber(value * 100), value)}%`;
  const shown = TEXT.integer.includes(stat) ? Math.round(value) : value;
  return signed(formatNumber(shown), shown);
}

/** Whether a change is good for the ship: higher is better unless the game says the stat is lower-better. */
export function statTone(stat: string, value: number): Tone {
  if (value === 0) return "Neutral";
  const higherIsBetter = !TEXT.lowerIsBetter.includes(stat);
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
export function describeSource(line: Pick<StatLine, "stat" | "operation">, source: StatSource, names: ReadonlyMap<string, string>): SourceRow {
  const kind = KIND_LABELS[source.kind] ?? statLabel(source.kind);
  const fromCatalog = source.asset ? names.get(source.asset) : undefined;
  const name =
    fromCatalog?.toUpperCase() ??
    (source.kind === "Affinity" && source.affinityType !== "None" ? `${statLabel(source.affinityType)} AFFINITY` : source.asset ? "UNKNOWN SOURCE" : kind);
  return {
    name,
    kind,
    value: formatStatValue(line.stat, line.operation, source.effective),
    tone: statTone(line.stat, source.effective),
    // A source the stacking rules scaled shows the share it kept.
    stacking: source.ratio !== 1 && !source.isStackingExempt ? `x${Math.round(source.ratio * 100) / 100}` : null,
  };
}
