// The game data API's JSON, mirrored from its contract (tools/game-data-api/openapi/openapi.json) and the
// C# records behind it. The API writes camelCase with enums as their C# names. GUIDs are decimal strings and
// FP values are raw decimal strings. types.test.mjs checks these shapes against real API responses
// recorded in __fixtures__ (scripts/record-fixtures.mjs), so keep them in step with the contract.

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

/** No point rating: the API derives it from the roll, so a sent one is ignored. */
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
  /** The game's MODIFIERS list: `stats` with each stat's stages combined. Empty when the fit is invalid. */
  modifierGroups: ModifierGroup[];
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

/** A category of the MODIFIERS list (HullSpecModifierGroup), in the game's order; rows largest first. */
export type ModifierGroup = { category: string; label: string; rows: ModifierRow[] };

/** One stat and operation with every calculation stage combined (HullSpecModifierRow); sources largest first. */
export type ModifierRow = {
  stat: string;
  label: string;
  operation: string;
  total: number;
  sources: ModifierSource[];
};

/**
 * A source of a modifier row. The game stacks a fitted module's lines on one stat as one source; `parts`
 * lists each line (empty when the source is its module's only line, or isn't a module's).
 */
export type ModifierSource = {
  kind: string;
  asset: string | null;
  affinityType: string;
  raw: number;
  ratio: number;
  effective: number;
  isStackingExempt: boolean;
  parts: ModifierPart[];
};

export type ModifierPart = { kind: string; asset: string | null; raw: number };

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

/** `statLabel` and `statValue` name the stat the help is about, when it is one. An older engine sends neither. */
export type SpecHelp = { title: string; text: string; statLabel?: string | null; statValue?: string | null };

// ---- Item facts (ItemFacts.cs) -------------------------------------------------------------------

/** A line of the game's item tooltip facts: `value` then `unit`, toned "Neutral", "Positive" or "Negative". */
export type FactRow = {
  label: string;
  value: string | null;
  unit: string | null;
  tone: string;
  /** The stat the line shows, and its number (null for a word). An older engine sends neither. */
  id?: string;
  number?: number | null;
};

// ---- Request and response bodies ---------------------------------------------------------------

/** GET /v1/status: which build is live. */
export type StatusResponse = { build: string; liveSince: string; counts: StatusCounts };
export type StatusCounts = { hulls: number; items: number; ciphers: number; artifacts: number; regaliaSets: number };
export type FitBody = { fit: OpenFit };
export type FitStringBody = { fitString: string };
/** Every error: `code` is "bad_request", "not_found", "too_large", "rate_limited", "starting" or "internal". */
export type ErrorBody = { error: ErrorDetail };
export type ErrorDetail = { code: string; message: string };
/** POST /v1/items/facts: a rolled item, validated as /v1/fits/evaluate validates a module. */
export type ItemBody = { item: OpenItem };
export type FactsBody = { facts: FactRow[] };

// ---- The public resource routes (OpenAPI: ItemList, HullList, ...) -----------------------------

export type ItemsBody = { build: string; items: CatalogItem[] };
export type HullsBody = { build: string; hulls: CatalogHull[] };
export type CiphersBody = { build: string; ciphers: CatalogCipher[] };
export type ArtifactsBody = { build: string; artifacts: CatalogArtifact[] };
export type RegaliaSetsBody = { build: string; regaliaSets: CatalogRegaliaSet[] };
export type AffinityBody = { build: string; affinity: CatalogAffinity };
export type RegaliaBody = { build: string; regalia: CatalogRegalia[] };
export type HereticalSpecialsBody = { build: string; hereticalSpecials: CatalogHereticalSpecial[] };
export type HarmonicSetsBody = { build: string; harmonicSets: CatalogHarmonicSet[] };
export type ModifierPoolsBody = { build: string; modifierPools: CatalogModifierPool[] };
export type QualitiesBody = { build: string; qualities: CatalogQuality[] };
export type PlacementRulesBody = { build: string; placementRules: CatalogSlotPlacement[] };
export type GridConsumablesBody = { build: string; gridConsumables: CatalogGridConsumable[] };
export type BreachTiersBody = { build: string; breachTiers: CatalogBreachTier[] };
export type StatsBody = { build: string; stats: CatalogStat[] };
export type FittingGridBody = { build: string; fittingGrid: FittingGridStyle | null };

/**
 * An entity's art: API-relative URLs (`/v1/art/<file>.webp`, 128px; the 256px twin has @2x before .webp).
 * `base` is always there; the other variants only where the game authors tiered art. The catalog the
 * site holds has them made absolute (catalog-resources.ts).
 */
export type ArtKeys = {
  base: string;
  Augmented?: string;
  Prototype?: string;
  Artifact?: string;
  Heretical?: string;
};

// ---- The catalog the site holds: the resource routes assembled (catalog-resources.ts) ---------

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
  /** The consumables that modify a fitting grid (GridMods.cs), by GUID. */
  gridConsumables: CatalogGridConsumable[];
  /** The breach tiers a modifier roll can be made at, by index (ModifierRolls.cs). Absent from an older engine. */
  breachTiers: CatalogBreachTier[];
  /** Every stat type as the game words it (GET /v1/stats). */
  stats: CatalogStat[];
  /** How the game draws its fitting grid (GET /v1/ui/fitting-grid); null from an older engine, which then has no grid to draw. */
  gridStyle: FittingGridStyle | null;
};

/**
 * A stat type as the game words it (StatTypeText, StatTypeRules): its label, whether lower is better,
 * whether its values are whole numbers, and whether a multiplier of it shows its sign inverted.
 */
export type CatalogStat = { id: string; label: string; lowerIsBetter: boolean; integer: boolean; invertedSign: boolean };

/** A rectangle in the grid's art space: pixels of a `cellSize` cell, from the slot box's top left. */
export type GridArtRect = { x: number; y: number; width: number; height: number };
/** A hardpoint icon as SVG: its viewBox and each path's `d`. */
export type GridHardpointIcon = { viewBox: string; paths: string[] };
/** A port notch: its fill, the bridge toward the next cell (zero size when none) and its edge lines. */
export type GridPortNotch = { body: GridArtRect; bridge: GridArtRect; borders: GridArtRect[] };

/**
 * How the game draws its fitting grid (the API reads it from the files Unity exports for its UI prototype):
 * every length in pixels of a `cellSize` cell, slot boxes inset `slotInset` from their cell, port notches per
 * form with one per direction (Up, Down, Left, Right), each hardpoint slot type's icon, and the grid's state
 * colours as CSS rgba().
 */
export type FittingGridStyle = {
  cellSize: number;
  slotInset: number;
  ports: { FemaleOpen: GridPortNotch[]; MaleAttached: GridPortNotch[]; Expansion: GridPortNotch[] };
  /** By the slot type a hull's grid names a cell with. */
  hardpoints: Record<string, GridHardpointIcon>;
  colors: Record<string, string>;
};

/** A breach tier as the game names it; `index` is what POST /v1/roll takes as `breachTier`. */
export type CatalogBreachTier = { index: number; name: string };

/**
 * A grid consumable (FittingGridConsumableRules.TryResolveSpec). `kind` is "FittingGridExtender" (BROKKR SLOT
 * adds a Core beside the grid) or "FittingCoreSlotTransformer"; `behavior` is "FixedTarget" (a converter
 * turns a Core into `fixedTargetSlotType`) or "RandomCorrupt" (SKULD retypes or destroys a hardpoint, or adds
 * a Core beside it). `fixedTargetSlotType` is null for all but the converters.
 */
export type CatalogGridConsumable = {
  def: string;
  name: string;
  kind: string;
  behavior: string;
  fixedTargetSlotType: string | null;
  art: ArtKeys | null;
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
  shipClass: string;
  /** The ShipRole of the ship the hull unlocks; "None" when it has none. */
  role: string;
  rows: number;
  cols: number;
  /** The fitting grid, row-major SlotType names. */
  slots: string[];
  roll: CatalogRoll;
  art: ArtKeys | null;
  /** An older engine sends none of these three. `model` is a /v1/art URL of the hull's 3D model. */
  baseCargoCapacity?: number;
  safetyHoldSlots?: number;
  model?: string | null;
};

export type CatalogItem = {
  def: string;
  name: string;
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
  art: ArtKeys | null;
  /** How its ability aims, the ability itself (null for a passive module) and whether it fires on overheat. An older engine sends none. */
  targeting?: string;
  ability?: CatalogAbility | null;
  autoActivateOnOverheat?: boolean;
};

/** `bonuses`, lowest piece count first, is what the set adds as more of it is linked. An older engine sends none. */
export type CatalogRegaliaSet = { def: string; name: string; pieces: string[]; bonuses?: CatalogSetBonus[] };

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
  item: string;
  modifiers: CatalogTemplateLine[];
  scaledStat: CatalogScaledStatRange | null;
  pointRating: number;
  patinaMax: number;
  /** The artifact's own icon, shown for an identified artifact; only artifacts whose definition authors one have it. */
  art: ArtKeys | null;
  /** How its ability aims ("SelectedEnemy", "WorldAim", "CasterAnchored"). An older engine sends none. */
  targeting?: string;
  /** The ability the artifact grants, in the game's words; null for most. An older engine sends none. */
  ability?: CatalogAbility | null;
};

/** An active ability in the game's words. */
export type CatalogAbility = { name: string; description: string };

export type CatalogRegalia = {
  def: string;
  name: string;
  item: string;
  set: string | null;
  modifiers: CatalogTemplateLine[];
  scaledStat: CatalogScaledStatRange | null;
  /** The piece's own bonus once linked to others of its set. An older engine sends none. */
  linkedBonuses?: CatalogSetBonus[];
};

/**
 * A template's modifier line. `scope` is "Local" (the module itself) or "ShipWide"; `row` words its rolled
 * range, `minRow` and `maxRow` its ends, as the item tooltip does. An older engine sends none of the four.
 */
export type CatalogTemplateLine = {
  stat: string;
  operation: string;
  tier: number;
  min: string;
  max: string;
  scope?: string;
  row?: CatalogStatRow;
  minRow?: CatalogStatRow;
  maxRow?: CatalogStatRow;
};

/** A stat line as the game words it: `value` carries its sign and, for a percentage, its "%". */
export type CatalogStatRow = { label: string; value: string; unit: string | null; tone: string; id: string; number: number | null };

/** What a regalia set, or a piece of one, adds once `pieces` of the set are linked. */
export type CatalogSetBonus = { pieces: number; modifiers: CatalogSetBonusLine[]; effects: CatalogSetEffect[] };

export type CatalogSetBonusLine = { stat: string; operation: string; value: string; row: CatalogStatRow };

/** A triggered effect; `displayText` is the game's line, with its chance when that is below 100%. */
export type CatalogSetEffect = {
  kind: string;
  rule: string;
  text: string;
  chance: string;
  strength: string | null;
  displayText: string;
  chanceNumber: number;
};

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
  stat: string;
  operation: string;
  value: string;
  pointRating: number;
  art: ArtKeys | null;
};

export type CatalogAffinity = {
  maxLevel: number;
  maxPointsPerCategory: number;
  maxPointsPerBonus: number;
  /** `levelXp[level - 1]` is the XP a level needs. */
  levelXp: number[];
  ratingByPoints: number[];
  types: CatalogAffinityType[];
  /** Where a progression keeps each point and choice. An older engine sends none; the assembled catalog then holds null. */
  layout?: ProgressionLayout | null;
};

/**
 * Where an open fit's progression keeps each value (AffinitySystem's indices): the points on a bonus at
 * `allocatedPoints[moduleTypes[type] * optionsPerType + option]`, a threshold choice at
 * `thresholdSelections[moduleTypes[type] * tiersPerType + tier]`, `selectionUnset` for no choice.
 */
export type ProgressionLayout = {
  moduleTypes: Record<string, number>;
  optionsPerType: number;
  tiersPerType: number;
  allocationSlots: number;
  thresholdSlots: number;
  selectionUnset: number;
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

// ---- Grid modification (GridMods.cs: POST /v1/grid-mods {fit}) -------------------------------------

/**
 * What each grid consumable can do to a fit's grid as it is now, answered by the game's own rules.
 * `refusal` says why nothing applies (a mirrored hull). Cells are row * cols + col, as in slot overrides.
 */
export type GridModsResponse = {
  buildSha: string;
  refusal: string | null;
  budget: GridModBudget;
  consumables: GridModOption[];
};

/** Grid extender cells used out of `maxExpansions`, and the hardpoint types whose one converter is spent. */
export type GridModBudget = { expansions: number; maxExpansions: number; convertersSpent: string[] };

export type GridModOption = { def: string; targets: GridModTarget[] };

/** A cell the consumable can be used on, and every change a use can make: one, or SKULD's several. */
export type GridModTarget = { cell: number; results: GridModResult[] };

/** The cell a use changes and the slot type it leaves there ("None" for a destroyed cell). */
export type GridModResult = { cell: number; slotType: string };

// ---- Modifier rolls (ModifierRolls.cs: POST /v1/roll) ----------------------------------------------

/**
 * Rolls an Augmented or Prototype item's modifiers with the game's own roller, as a drop rolls them.
 * `breachTier` defaults to the highest, `seed` to one the engine picks (its answer echoes it), and `line`
 * re-rolls only that modifier against the others.
 */
export type RollRequest = { item: OpenItem; breachTier?: number; seed?: number; line?: number };

/** The item with its new modifiers, everything else kept, and the tier and seed that reproduce it. */
export type RollResponse = { item: OpenItem; breachTier: number; seed: number };
