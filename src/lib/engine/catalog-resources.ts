// The catalog the site holds, assembled from the game data API's public resource routes. This is the one
// place that knows which routes make up the catalog and how their bodies join into the shape the builder
// and the fit pages read (types.ts `Catalog`), and the one place art URLs become absolute.
import type {
  AffinityBody,
  ArtKeys,
  ArtifactsBody,
  BreachTiersBody,
  Catalog,
  CiphersBody,
  GridConsumablesBody,
  HarmonicSetsBody,
  HereticalSpecialsBody,
  HullsBody,
  ItemsBody,
  ModifierPoolsBody,
  PlacementRulesBody,
  QualitiesBody,
  RegaliaBody,
  RegaliaSetsBody,
} from "./types.ts";

/** Every body carries the build it was served from. */
type Body = { build: string };

/** The route behind each part of the catalog, and how to recognise its body. */
export const CATALOG_ROUTES = {
  items: { path: "/v1/items", key: "items" },
  hulls: { path: "/v1/hulls", key: "hulls" },
  ciphers: { path: "/v1/ciphers", key: "ciphers" },
  artifacts: { path: "/v1/artifacts", key: "artifacts" },
  regaliaSets: { path: "/v1/regalia-sets", key: "regaliaSets" },
  affinity: { path: "/v1/affinity", key: "affinity" },
  regalia: { path: "/v1/regalia", key: "regalia" },
  hereticalSpecials: { path: "/v1/heretical-specials", key: "hereticalSpecials" },
  harmonicSets: { path: "/v1/harmonic-sets", key: "harmonicSets" },
  modifierPools: { path: "/v1/modifier-pools", key: "modifierPools" },
  qualities: { path: "/v1/qualities", key: "qualities" },
  placementRules: { path: "/v1/placement-rules", key: "placementRules" },
  gridConsumables: { path: "/v1/grid-consumables", key: "gridConsumables" },
  breachTiers: { path: "/v1/breach-tiers", key: "breachTiers" },
} as const;

export type CatalogPart = keyof typeof CATALOG_ROUTES;
export const CATALOG_PARTS = Object.keys(CATALOG_ROUTES) as CatalogPart[];

/**
 * Parts an older API doesn't serve yet. A 404 from one of these routes reads as an empty list, which hides
 * the builder feature built on it (grid modification, rolling), instead of failing the whole catalog.
 */
export const OPTIONAL_CATALOG_PARTS = ["gridConsumables", "breachTiers"] as const satisfies readonly CatalogPart[];
export type OptionalCatalogPart = (typeof OPTIONAL_CATALOG_PARTS)[number];

export const isOptionalPart = (part: CatalogPart): part is OptionalCatalogPart =>
  (OPTIONAL_CATALOG_PARTS as readonly CatalogPart[]).includes(part);

/** The body an optional part reads as when its route is missing: no entries, of the catalog's build. */
export function absentPartBody<P extends OptionalCatalogPart>(part: P, build: string): CatalogBodies[P] {
  return { build, [CATALOG_ROUTES[part].key]: [] } as unknown as CatalogBodies[P];
}

/** What each route answered, by part. */
export type CatalogBodies = {
  items: ItemsBody;
  hulls: HullsBody;
  ciphers: CiphersBody;
  artifacts: ArtifactsBody;
  regaliaSets: RegaliaSetsBody;
  affinity: AffinityBody;
  regalia: RegaliaBody;
  hereticalSpecials: HereticalSpecialsBody;
  harmonicSets: HarmonicSetsBody;
  modifierPools: ModifierPoolsBody;
  qualities: QualitiesBody;
  placementRules: PlacementRulesBody;
  gridConsumables: GridConsumablesBody;
  breachTiers: BreachTiersBody;
};

/** Just enough of a check to tell the API from a proxy's error page or a wrong URL. */
export function isPartBody<P extends CatalogPart>(part: P, value: unknown): value is CatalogBodies[P] {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  const content = body[CATALOG_ROUTES[part].key];
  return typeof body.build === "string" && (part === "affinity" ? typeof content === "object" && content !== null && !Array.isArray(content) : Array.isArray(content));
}

/** The build every part was served from, or null when they disagree (a deploy landed between two requests). */
export function commonBuild(bodies: CatalogBodies): string | null {
  const builds = new Set(CATALOG_PARTS.map((part) => (bodies[part] as Body).build));
  return builds.size === 1 ? [...builds][0]! : null;
}

/** An API-relative art URL made absolute under `base` (no trailing slash); null base keeps it as sent. */
function absolute(url: string, base: string | null): string {
  return base === null ? url : `${base}${url}`;
}

function absoluteArt(art: ArtKeys | null, base: string | null): ArtKeys | null {
  if (art === null) return null;
  return Object.fromEntries(Object.entries(art).map(([variant, url]) => [variant, absolute(url, base)])) as ArtKeys;
}

const withArt = <T extends { art: ArtKeys | null }>(entries: T[], base: string | null): T[] =>
  entries.map((entry) => ({ ...entry, art: absoluteArt(entry.art, base) }));

/**
 * The catalog from the bodies of CATALOG_ROUTES, which must all be of one build. `artBase` is the PUBLIC
 * API origin the browser loads art from: art URLs come as `/v1/art/...` and are made absolute with it.
 */
export function assembleCatalog(bodies: CatalogBodies, artBase: string | null): Catalog {
  const build = commonBuild(bodies);
  if (build === null) throw new Error("The catalog's parts are of different builds.");
  return {
    buildSha: build,
    hulls: withArt(bodies.hulls.hulls, artBase),
    items: withArt(bodies.items.items, artBase),
    regaliaSets: bodies.regaliaSets.regaliaSets,
    modifierPools: bodies.modifierPools.modifierPools,
    artifacts: withArt(bodies.artifacts.artifacts, artBase),
    regalia: bodies.regalia.regalia,
    hereticalSpecials: bodies.hereticalSpecials.hereticalSpecials,
    harmonicSets: bodies.harmonicSets.harmonicSets,
    ciphers: withArt(bodies.ciphers.ciphers, artBase),
    affinity: bodies.affinity.affinity,
    qualities: bodies.qualities.qualities,
    placement: bodies.placementRules.placementRules,
    gridConsumables: withArt(bodies.gridConsumables.gridConsumables, artBase),
    breachTiers: bodies.breachTiers.breachTiers,
  };
}
