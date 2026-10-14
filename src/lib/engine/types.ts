// The loadout engine's JSON, mirrored from its C# records (tools/loadout-engine/Citadel.LoadoutEngine:
// OpenFit.cs, Evaluator.cs, CatalogBuilder.cs, ItemFacts.cs, Program.cs). The engine writes camelCase with enums as
// their C# names. GUIDs are decimal strings and FP values are raw decimal strings. types.test.mjs checks
// these shapes against real engine responses recorded in __fixtures__, so keep them in step with the C#.

// ---- Open fit (OpenFit.cs) ---------------------------------------------------------------------

export type OpenFit = {
  version: number;
  hull: OpenItem;
  progression: OpenProgression;
  modules: OpenModule[];
  ammo: OpenAmmo[];
  /** Ordered by cell. */
  slotOverrides: OpenSlotOverride[];
};

export type OpenItem = { def: string; roll: OpenRoll; patina: number };

/** No point rating: the engine derives it from the roll, so a sent one is ignored. */
export type OpenRoll = {
  quality: string;
  rarity: string;
  modifiers: OpenModifier[];
  ports: OpenPort[];
  artifact: string | null;
  regalia: string | null;
  heretical: string | null;
  /** The ascended form an ascended brand gave beside the special; an older item carries its form as `heretical`. */
  ascended: string | null;
  moduleTypeOverride: string | null;
  isIdentified: boolean;
  isHarmonized: boolean;
  isMirrored: boolean;
  harmonicSet: string | null;
  scaledStat: OpenScaledStat | null;
};

export type OpenModifier = {
  stat: string;
  operation: string;
  tier: number;
  value: string;
  slot: number;
  isInverted: boolean;
  isFractured: boolean;
};

export type OpenPort = { row: number; col: number; direction: string; cipher: string | null };

export type OpenScaledStat = { rule: string | null; strength: string };

export type OpenModule = { item: OpenItem; row: number; col: number; rotation: number };

export type OpenProgression = {
  affinityType: string;
  affinityXp: number;
  allocatedPoints: number[];
  thresholdSelections: number[];
};

export type OpenAmmo = { moduleIndex: number; ammoType: string };

/** Cell is row * columns + col. */
export type OpenSlotOverride = { cell: number; slotType: string };

// ---- Evaluation (Evaluator.cs) -----------------------------------------------------------------

export type EvaluationResponse = {
  buildSha: string;
  valid: boolean;
  issues: EvaluationIssue[];
  conduits: ConduitLink[];
  regaliaSets: RegaliaGroup[];
  stats: StatLine[];
  rating: number;
  /** The game's Hull Specs panel for the fit; empty when the fit is invalid. */
  sections: SpecSection[];
};

/** `moduleIndex` is -1 for the hull and for fit-wide issues. */
export type EvaluationIssue = { moduleIndex: number; kind: string; message: string };

export type ConduitLink = { moduleIndex: number; connectionCount: number };

export type RegaliaGroup = { set: string; fittedCount: number; moduleIndices: number[] };

export type StatLine = {
  stat: string;
  stage: string;
  operation: string;
  total: number;
  sources: StatSource[];
};

export type StatSource = {
  kind: string;
  asset: string | null;
  affinityType: string;
  raw: number;
  ratio: number;
  effective: number;
  isStackingExempt: boolean;
};

/**
 * A section of the game's Hull Specs panel (HullSpecSection), in the panel's order: defense, offense,
 * each guided weapon by name, reactor, agility, targeting, utility.
 */
export type SpecSection = { id: string; label: string; rows: SpecRow[] };

/**
 * A Hull Specs row as the game shows it. With a `secondary` value the row compares: `primary` (shown
 * without its unit) is the stat before and `secondary` the stat now. Tones are "Neutral", "Positive"
 * or "Negative".
 */
export type SpecRow = {
  id: string;
  label: string;
  primary: SpecValue;
  secondary: SpecValue | null;
  primaryTone: string;
  secondaryTone: string;
  help: SpecHelp;
};

/** `text` then `unit` is what the game shows; `number` is the shown number in that unit, null for a word (STABLE, ∞). */
export type SpecValue = { text: string; unit: string; number: number | null };

export type SpecHelp = { title: string; text: string };

// ---- Item facts (ItemFacts.cs) -------------------------------------------------------------------

/** A line of the game's item tooltip facts: `value` then `unit`, toned "Neutral", "Positive" or "Negative". */
export type FactRow = { label: string; value: string | null; unit: string | null; tone: string };

// ---- Request and response bodies (Program.cs) --------------------------------------------------

export type HealthResponse = { buildSha: string };
export type FitBody = { fit: OpenFit };
export type FitStringBody = { fitString: string };
export type ErrorBody = { error: string };
/** POST /v1/item-facts: a rolled item, validated as /v1/evaluate validates a module. */
export type ItemBody = { item: OpenItem };
export type FactsBody = { facts: FactRow[] };

// ---- Catalog v2 (CatalogBuilder.cs) ------------------------------------------------------------

export type Catalog = {
  buildSha: string;
  hulls: CatalogHull[];
  items: CatalogItem[];
  regaliaSets: CatalogRegaliaSet[];
  /** Every module type's pool; a THOTH type override makes the pools of `roll.typeOverrides` reachable. */
  modifierPools: CatalogModifierPool[];
  artifacts: CatalogArtifact[];
  regalia: CatalogRegalia[];
  hereticalSpecials: CatalogHereticalSpecial[];
  harmonicSets: CatalogHarmonicSet[];
  ciphers: CatalogCipher[];
  affinity: CatalogAffinity;
  qualities: CatalogQuality[];
  /** Where an item of each slot type may sit on a fitting grid, read from the game's FittingSlotRules. */
  placement: CatalogSlotPlacement[];
};

/**
 * Every cell an item of `slotType` covers must be one of `covers`; with a `hardpoint`, at least one must be
 * a cell of that type. Bounds and overlap are geometry; battery families and unique rolls stay with the
 * evaluation.
 */
export type CatalogSlotPlacement = { slotType: string; covers: string[]; hardpoint: string | null };

export type CatalogHull = {
  def: string;
  name: string;
  /** The hull item prototype's asset path (Identifier.Path), which keys its art. */
  path: string;
  shipClass: string;
  /** The ShipRole of the ship the hull unlocks; "None" when it has none. */
  role: string;
  rows: number;
  cols: number;
  /** The fitting grid, row-major SlotType names. */
  slots: string[];
  roll: CatalogRoll;
};

export type CatalogItem = {
  def: string;
  name: string;
  /** The item prototype's asset path (Identifier.Path), which keys its art. */
  path: string;
  /** The module's authored description, trimmed; null when it has none. Plain text, may hold newlines. */
  description: string | null;
  /** The item tooltip's facts for its default roll (ItemFacts.Default): Standard quality, the lowest of `roll.rarities`. */
  facts: FactRow[];
  category: string;
  slotType: string;
  slotSize: string;
  moduleType: string;
  payloads: string[];
  shape: CatalogShape;
  portRules: CatalogPortRules;
  roll: CatalogRoll;
};

export type CatalogRegaliaSet = { def: string; name: string; pieces: string[] };

/** The rotation-0 footprint in the 5x5 shape grid ports are anchored in. */
export type CatalogShape = { originRow: number; originCol: number; cells: CatalogCell[] };
export type CatalogCell = { row: number; col: number };

export type CatalogPortRules = { maxPorts: number; candidates: CatalogPortCandidate[] };
export type CatalogPortCandidate = { row: number; col: number; direction: string };

export type CatalogRoll = {
  qualities: string[];
  /** In ModuleRarity order, lowest first. */
  rarities: string[];
  modifierCounts: CatalogModifierCount[];
  modifierPool: CatalogModifierSlots;
  typeOverrides: string[];
  artifacts: string[];
  regalia: string[];
  hereticals: string[];
  harmonicSets: string[];
  rating: CatalogItemRating;
  authored: CatalogAuthoredRoll[];
};

/** A roll the config grants outright: this quality and rarity with no modifiers, ports or references. */
export type CatalogAuthoredRoll = {
  source: string;
  quality: string;
  rarity: string;
  isIdentified: boolean;
  pointRating: number;
};

export type CatalogModifierCount = { rarity: string; min: number; max: number };

export type CatalogModifierSlots = { prefix: CatalogPoolEntry[]; suffix: CatalogPoolEntry[] };

export type CatalogPoolEntry = {
  stat: string;
  operation: string;
  /** A module type name, or `Role:<ShipRole>`. */
  pool: string;
  /** Nonzero groups in one pool exclude each other. */
  group: number;
  augmentedOnly: boolean;
  onlyOnModule: string | null;
  tiers: CatalogTier[];
};

/** Min and max are the raw FP range, inclusive, in the stat system's format. */
export type CatalogTier = { tier: number; min: string; max: string; allowed: boolean };

export type CatalogModifierPool = { moduleType: string; modifiers: CatalogModifierSlots };

export type CatalogItemRating = {
  base: number;
  scalesWithQuality: boolean;
  /** Rating each modifier adds, by tier - 1. */
  tierShares: number[];
  regaliaShare: number;
  hereticalShare: number;
  ascendedHereticalShare: number;
};

export type CatalogQuality = { quality: string; multiplier: string };

export type CatalogArtifact = {
  def: string;
  name: string;
  /** The artifact definition's asset path (Identifier.Path), which keys its art; its name is a display name. */
  path: string;
  item: string;
  modifiers: CatalogTemplateLine[];
  scaledStat: CatalogScaledStatRange | null;
  pointRating: number;
  patinaMax: number;
};

export type CatalogRegalia = {
  def: string;
  name: string;
  item: string;
  set: string | null;
  modifiers: CatalogTemplateLine[];
  scaledStat: CatalogScaledStatRange | null;
};

export type CatalogTemplateLine = { stat: string; operation: string; tier: number; min: string; max: string };

export type CatalogScaledStatRange = { rule: string; min: string; max: string };

export type CatalogHereticalSpecial = {
  def: string;
  name: string;
  heresy: string;
  ascended: boolean;
  moduleTypes: string[];
};

export type CatalogHarmonicSet = {
  def: string;
  name: string;
  description: string;
  moduleTypes: string[];
  ciphers: string[];
  pointRating: number;
};

export type CatalogCipher = {
  def: string;
  name: string;
  /** The cipher item prototype's asset path (Identifier.Path), which keys its art. */
  path: string;
  stat: string;
  operation: string;
  value: string;
  pointRating: number;
};

export type CatalogAffinity = {
  maxLevel: number;
  maxPointsPerCategory: number;
  maxPointsPerBonus: number;
  /** `levelXp[level - 1]` is the XP a level needs. */
  levelXp: number[];
  ratingByPoints: number[];
  types: CatalogAffinityType[];
};

export type CatalogAffinityType = {
  moduleType: string;
  name: string;
  optionName: string;
  description: string;
  bonuses: CatalogAffinityBonus[];
  thresholds: CatalogAffinityTier[];
};

export type CatalogAffinityBonus = {
  option: number;
  stat: string;
  operation: string;
  valuePerPoint: string;
  name: string;
  description: string;
  invertDisplaySign: boolean;
};

export type CatalogAffinityTier = { tier: number; requiredPoints: number; choices: CatalogAffinityChoice[] };
export type CatalogAffinityChoice = { option: number; name: string; description: string };
