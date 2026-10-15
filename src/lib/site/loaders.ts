// What each page reads, as plain functions over their dependencies, so route tests can run them on
// pglite and a stub (or dead) engine. Reads never throw for an outage: a database that is missing or
// failing gives { status: "unavailable" }, and an engine that is down gives pages that render from
// the verdicts already stored, with `engine.state.status === "down"` for the banner.
import type { EngineResult } from "../engine/client";
import type { EngineMonitor, EngineState } from "../engine/engine-state";
import type { ArtKeys, Catalog, CatalogHull, FittingGridStyle, OpenFit } from "../engine/types";
import type { DatabaseState, Queryable } from "../fits/db";
import { parseBrowseParams, type BrowseQuery, type SearchParamsInput } from "../fits/filters";
import {
  browseFits,
  getFit,
  listComments,
  listOpenReports,
  type CommentThread,
  type FitDetail,
  type FitSummary,
  type HullLookup,
  type Report,
  type Viewer,
} from "../fits/queries";
import { listBookmarks } from "../fits/bookmarks";
import { countUnread, listNotifications, UNREAD_DISPLAY_CAP, type Notification } from "../fits/notifications";
import { getForkInfo, type ForkInfo } from "../fits/forks";
import { getPilotProfile, type PilotProfile } from "../fits/pilots";
import { getBan, isBanned, listPilots, type AdminPilot, type PilotBan } from "../fits/bans";
import type { ModerationState } from "../auth-core";
import { getRevision, listRevisions, parseRevisionParam, type Revision, type RevisionSummary } from "../fits/revisions";
import { shownEvaluation, standingOf, type Shown, type Standing } from "../fits/standing";
import { buildGridModel, catalogLookups, type GridModel } from "#/components/grid/model";
import { moduleInfos, type ModuleInfo } from "./module-search";
import { alignSections, countModules, diffModules, type CompareSection, type ModuleDiff } from "../fits/compare";
import { UNKNOWN_ITEM_NAME } from "#/components/grid/model";
import { isEditableFit, isOpenFit } from "../engine/open-fit";
import { baseIcon, itemIcon } from "../art/item-icon";
import { affinityTag, compareAffinity, readProgression, type AffinityCompareRow } from "#/components/affinity/affinity";
import type { OpenProgression } from "../engine/types";

export type SiteDeps = {
  database: () => DatabaseState;
  engine: EngineMonitor;
  catalog: { get(): Promise<EngineResult<Catalog>>; peek(): Catalog | null; etag(): string | null };
};

export type PageEngine = {
  state: EngineState;
  /** The current build's catalog, or the last one held while the engine is down; null if never fetched. */
  catalog: Catalog | null;
  /** The build stored verdicts are compared with: the engine's, or the last one it reported. */
  currentSha: string | null;
};

export type Unavailable = { status: "unavailable"; engine: PageEngine };

export async function pageEngine(deps: SiteDeps): Promise<PageEngine> {
  const state = await deps.engine.current();
  // A down engine would make a catalog fetch wait for its timeout; use what is held.
  const fetched = state.status === "up" ? await deps.catalog.get() : null;
  const catalog = fetched?.ok ? fetched.value : deps.catalog.peek();
  return { state, catalog, currentSha: state.buildSha ?? catalog?.buildSha ?? null };
}

/** Runs a read; a database error (down, unreachable, schema missing) becomes null, logged without data. */
async function guarded<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    console.error(`fits database ${what} failed:`, code ?? (error as Error).message);
    return null;
  }
}

function databaseOf(deps: Pick<SiteDeps, "database">): Queryable | null {
  const database = deps.database();
  return database.status === "ready" ? database.db : null;
}

// ---------------------------------------------------------------------------------------------------
// Browse and author pages

export type HullInfo = { def: string; name: string; hullClass: string; role: string };

export function hullInfos(catalog: Catalog | null): HullInfo[] {
  return (catalog?.hulls ?? []).map((hull) => ({ def: hull.def, name: hull.name, hullClass: hull.shipClass, role: hull.role }));
}

export function hullLookup(catalog: Catalog | null): HullLookup {
  return new Map((catalog?.hulls ?? []).map((hull) => [hull.def, { hullClass: hull.shipClass, role: hull.role }]));
}

export type FitCard = {
  id: string;
  title: string;
  hullName: string;
  /** The hull item's base icon, or null (no art, or a hull the build doesn't have). */
  hullIcon: string | null;
  authorUserId: string;
  authorName: string;
  tags: string[];
  votes: number;
  comments: number;
  /** Whether the viewer has bookmarked it. */
  bookmarked: boolean;
  status: FitSummary["status"];
  standing: Standing;
  /** The engine's rating on the current build, or the last valid one for an outdated fit. */
  rating: number | null;
  /** The fit's modules, one per item kind in mount order, with how many it fits and the icon its roll shows. */
  modules: CardModule[];
  /** The small affinity tag, "<TYPE> <LEVEL>" (level from the catalog's XP table); the focus type, else the type with most points; null with neither. */
  affinity: string | null;
};

export type CardModule = { def: string; name: string; icon: string | null; count: number };

/** Catalog lookups for cards, built once per catalog (the catalog object is replaced on a new build). */
const cardLookups = new WeakMap<Catalog, { items: Map<string, Catalog["items"][number]>; artifacts: Map<string, ArtKeys | null> }>();

function lookupsFor(catalog: Catalog) {
  let lookups = cardLookups.get(catalog);
  if (!lookups) {
    lookups = { items: new Map(catalog.items.map((item) => [item.def, item])), artifacts: new Map(catalog.artifacts.map((artifact) => [artifact.def, artifact.art])) };
    cardLookups.set(catalog, lookups);
  }
  return lookups;
}

/** The card's module icons, by the grid's own icon rule (itemIcon); an item the build lacks is UNKNOWN ITEM. */
export function cardModules(fit: Pick<FitSummary, "moduleItems">, catalog: Catalog | null): CardModule[] {
  const lookups = catalog ? lookupsFor(catalog) : null;
  const byDef = new Map<string, CardModule>();
  for (const ref of fit.moduleItems) {
    const seen = byDef.get(ref.def);
    if (seen) {
      seen.count += 1;
      continue;
    }
    const item = lookups?.items.get(ref.def);
    const artifactArt = ref.artifact ? (lookups?.artifacts.get(ref.artifact) ?? null) : null;
    byDef.set(ref.def, {
      def: ref.def,
      name: item?.name ?? UNKNOWN_ITEM_NAME,
      icon: item ? itemIcon({ art: item.art, category: item.category }, ref, artifactArt) : null,
      count: 1,
    });
  }
  return [...byDef.values()];
}

export function toCard(fit: FitSummary, catalog: Catalog | null, currentSha: string | null): FitCard {
  const standing = standingOf(fit, currentSha);
  const rating = standing === "current" ? fit.evaluation!.rating : (fit.lastValidEvaluation?.rating ?? null);
  const hull = catalog?.hulls.find((each) => each.def === fit.hullItem);
  return {
    id: fit.id,
    title: fit.title,
    hullName: hull?.name ?? "UNKNOWN HULL",
    hullIcon: hull ? baseIcon(hull.art) : null,
    authorUserId: fit.authorUserId,
    authorName: fit.authorName,
    tags: fit.tags,
    votes: fit.votes,
    comments: fit.comments,
    bookmarked: fit.viewerBookmarked,
    status: fit.status,
    standing,
    rating,
    modules: cardModules(fit, catalog),
    affinity: affinityTag(catalog?.affinity ?? null, fit.affinityType, fit.affinityXp, fit.affinityPoints),
  };
}

export type BrowseData =
  | Unavailable
  | { status: "ok"; engine: PageEngine; query: BrowseQuery; cards: FitCard[]; nextCursor: string | null; hulls: HullInfo[]; selectedModules: ModuleInfo[] };

export async function loadBrowse(
  deps: SiteDeps,
  params: SearchParamsInput,
  viewer: Viewer,
  overrides: Partial<BrowseQuery> = {},
): Promise<BrowseData> {
  const engine = await pageEngine(deps);
  const db = databaseOf(deps);
  if (!db) return { status: "unavailable", engine };
  const parsed = { ...parseBrowseParams(params), ...overrides };
  // "From pilots I follow" means nothing signed out: drop it so the form and links don't carry it either.
  const query = viewer.userId === null ? { ...parsed, following: false } : parsed;
  const cursor = params instanceof URLSearchParams ? params.get("cursor") : params.cursor;
  const page = await guarded("browse", () =>
    browseFits(db, {
      query,
      cursor: typeof cursor === "string" ? cursor : undefined,
      buildSha: engine.currentSha,
      hulls: hullLookup(engine.catalog),
      viewer,
    }),
  );
  if (!page) return { status: "unavailable", engine };
  return {
    status: "ok",
    engine,
    query,
    cards: page.fits.map((fit) => toCard(fit, engine.catalog, engine.currentSha)),
    nextCursor: page.nextCursor,
    hulls: hullInfos(engine.catalog),
    selectedModules: moduleInfos(engine.catalog, query.modules),
  };
}

export type BookmarksData = Unavailable | { status: "ok"; engine: PageEngine; cards: FitCard[]; nextCursor: string | null };

/** The signed-in pilot's bookmarked fits that are published now, newest bookmark first. */
export async function loadBookmarks(deps: SiteDeps, params: SearchParamsInput, userId: string): Promise<BookmarksData> {
  const engine = await pageEngine(deps);
  const db = databaseOf(deps);
  if (!db) return { status: "unavailable", engine };
  const cursor = params instanceof URLSearchParams ? params.get("cursor") : params.cursor;
  const page = await guarded("bookmarks", () =>
    listBookmarks(db, { userId, cursor: typeof cursor === "string" ? cursor : undefined, buildSha: engine.currentSha }),
  );
  if (!page) return { status: "unavailable", engine };
  return { status: "ok", engine, cards: page.fits.map((fit) => toCard(fit, engine.catalog, engine.currentSha)), nextCursor: page.nextCursor };
}

export type NotificationsData = Unavailable | { status: "ok"; engine: PageEngine; notifications: Notification[]; nextCursor: string | null };

/** The signed-in pilot's notifications whose fit and comment are still visible, newest first. */
export async function loadNotifications(deps: SiteDeps, params: SearchParamsInput, userId: string): Promise<NotificationsData> {
  const engine = await pageEngine(deps);
  const db = databaseOf(deps);
  if (!db) return { status: "unavailable", engine };
  const cursor = params instanceof URLSearchParams ? params.get("cursor") : params.cursor;
  const page = await guarded("notifications", () => listNotifications(db, { userId, cursor: typeof cursor === "string" ? cursor : undefined }));
  if (!page) return { status: "unavailable", engine };
  return { status: "ok", engine, notifications: page.notifications, nextCursor: page.nextCursor };
}

/** The header bell's number: unread notifications, capped for display; 0 when the database can't answer (the header never fails). */
export async function loadUnreadCount(deps: Pick<SiteDeps, "database">, userId: string): Promise<number> {
  const db = databaseOf(deps);
  if (!db) return 0;
  return (await guarded("unread count", () => countUnread(db, userId))) ?? 0;
}

/** "3", or "99+" past the cap. */
export function unreadLabel(count: number): string {
  return count > UNREAD_DISPLAY_CAP ? `${UNREAD_DISPLAY_CAP}+` : String(count);
}

export type AuthorData =
  | Unavailable
  | { status: "not_found"; engine: PageEngine }
  | (Extract<BrowseData, { status: "ok" }> & {
      pilot: PilotProfile;
      /** The pilot's ban, read only for an admin viewer (null for everyone else, banned or not). */
      ban: PilotBan | null;
    });

/** An empty profile for a signed-in pilot whose row sign-in hasn't written yet (their first write creates it). */
function freshPilot(userId: string, name: string): PilotProfile {
  return { userId, name, avatarUrl: null, bio: "", publishedFits: 0, upvotesReceived: 0, topFit: null, followers: 0, following: 0, viewerFollows: false };
}

/**
 * A pilot's page: their header (profile and totals) and their fits. A pilot with no row doesn't exist,
 * except to themself when signed in before their row was written; then `viewerName` names them.
 */
export async function loadAuthor(
  deps: SiteDeps,
  userId: string,
  params: SearchParamsInput,
  viewer: Viewer & { name?: string | null },
): Promise<AuthorData> {
  const data = await loadBrowse(deps, params, viewer, { author: userId, hull: undefined, hullClass: undefined, role: undefined, tags: [], following: false, q: undefined, modules: [] });
  if (data.status !== "ok") return data;
  const db = databaseOf(deps)!;
  const profile = await guarded("pilot", async () => ({ found: await getPilotProfile(db, userId, viewer) }));
  if (!profile) return { status: "unavailable", engine: data.engine };
  const own = viewer.userId === userId;
  const pilot = profile.found ?? (own && viewer.name ? freshPilot(userId, viewer.name) : null);
  if (!pilot) return { status: "not_found", engine: data.engine };
  // Bans are moderators' business: nobody else's page read asks.
  const ban = viewer.isAdmin ? await guarded("ban", () => getBan(db, userId)) : null;
  return { ...data, pilot, ban };
}

// ---------------------------------------------------------------------------------------------------
// Fit page

export type GridState =
  | { status: "ready"; model: GridModel; style: FittingGridStyle }
  /** No catalog: the engine has been down since this server started. */
  | { status: "no_catalog" }
  /** The engine doesn't say how to draw a grid (an older one, without /v1/ui/fitting-grid). */
  | { status: "no_style" }
  /** The hull isn't in the current build. */
  | { status: "unknown_hull" }
  /** The stored JSON isn't an open fit this site can draw. */
  | { status: "unreadable" };

export type FitPageData =
  | Unavailable
  | { status: "not_found"; engine: PageEngine }
  | {
      status: "ok";
      engine: PageEngine;
      fit: FitDetail;
      hull: CatalogHull | null;
      shown: Shown;
      grid: GridState;
      comments: CommentThread[];
      /** Where the fit was copied from (as far as this viewer may be told) and how many published fits were copied from it. */
      fork: ForkInfo;
      /** Newest first; empty for a fit with no history (published before history existed, or still a draft). */
      revisions: RevisionSummary[];
      /**
       * Set when the page shows one revision read-only (`?rev=N`): `fit` then carries that revision's words and
       * content, and `statsShown` says whether `shown` describes it (only the latest revision has a verdict).
       */
      revision: { number: number; of: number; statsShown: boolean; note: string | null; createdAt: string } | null;
      /** Set for an outdated published fit: what the engine says is wrong with it on the current build. */
      broken: BrokenOnBuild | null;
      /** The shown fit's (or revision's) stored progression, for the AFFINITY panel; null when the JSON holds none that can be read. */
      progression: OpenProgression | null;
    };

export type BrokenIssue = {
  /** The module's catalog name; null for a fit-wide issue ("Whole fit") or when no catalog is held. */
  moduleName: string | null;
  /** The module's item def when the catalog knows the item (so "fits using this module" can be offered); else null. */
  def: string | null;
  message: string;
};

export type BrokenOnBuild = { issues: BrokenIssue[]; /** The build of the most recent valid verdict, if any. */ lastWorkedBuild: string | null };

/**
 * The "broken on this build" panel's content: only for a published fit that is outdated (it passed on an
 * earlier build and fails on the current one). Issues are the engine's stored ones for the current build;
 * each module is read from `moduleIndex` against the fit's modules and named by the catalog.
 */
export function brokenOnBuild(fit: Pick<FitDetail, "status" | "fit">, shown: Pick<Shown, "standing" | "issues" | "reference">, catalog: Catalog | null): BrokenOnBuild | null {
  if (fit.status !== "published" || shown.standing !== "outdated") return null;
  const modules = isOpenFit(fit.fit) ? fit.fit.modules : [];
  const items = new Map((catalog?.items ?? []).map((item) => [item.def, item.name]));
  return {
    issues: shown.issues.map((issue) => {
      const module = issue.moduleIndex >= 0 ? modules[issue.moduleIndex] : undefined;
      if (!module) return { moduleName: null, def: null, message: issue.message };
      const known = items.get(module.item.def);
      return { moduleName: known ?? (catalog ? UNKNOWN_ITEM_NAME : "MODULE"), def: known === undefined ? null : module.item.def, message: issue.message };
    }),
    lastWorkedBuild: shown.reference?.buildSha ?? null,
  };
}

/** What `shown` holds for a revision that has no verdict of its own. */
const NO_STATS: Shown = { standing: "unknown", reference: null, referenceIsOld: false, result: { stats: [], conduits: [], regaliaSets: [], sections: null, modifierGroups: null }, issues: [] };

export function gridFor(fit: FitDetail, catalog: Catalog | null, shown: Shown): GridState {
  const open = fit.fit;
  if (!isOpenFit(open)) return { status: "unreadable" };
  if (!catalog) return { status: "no_catalog" };
  const hull = catalog.hulls.find((each) => each.def === open.hull.def);
  if (!hull) return { status: "unknown_hull" };
  if (!catalog.gridStyle) return { status: "no_style" };
  const lookups = catalogLookups(catalog);
  const model = buildGridModel({ hull, ...lookups }, open, {
    issues: shown.issues,
    conduits: shown.result.conduits,
    regaliaSets: shown.result.regaliaSets,
  });
  return { status: "ready", model, style: catalog.gridStyle };
}

/**
 * The fit page. `rev` is the raw `?rev=` value: absent shows the fit as it is now; a present value must be a
 * revision number this fit has, or the page is not found (the same answer as for a fit the viewer can't see).
 * A revision is read only after the fit itself passed getFit's visibility, so it follows the fit's own.
 */
export async function loadFitPage(deps: SiteDeps, id: string, viewer: Viewer, rev?: unknown): Promise<FitPageData> {
  const engine = await pageEngine(deps);
  const db = databaseOf(deps);
  if (!db) return { status: "unavailable", engine };
  const fit = await guarded("fit read", () => getFit(db, id, { viewer, buildSha: engine.currentSha }));
  if (fit === null) {
    // A miss and a failure both come back null from guarded; tell them apart with a cheap probe.
    const reachable = await guarded("probe", () => db.query("SELECT 1"));
    return reachable ? { status: "not_found", engine } : { status: "unavailable", engine };
  }
  const comments = fit.status === "published" || viewer.isAdmin ? ((await guarded("comments", () => listComments(db, id, { viewer }))) ?? []) : [];
  const fork = (await guarded("fork credit", () => getForkInfo(db, id, viewer))) ?? { credit: null, copies: 0 };
  const listed = await guarded("revisions", () => listRevisions(db, id));
  const revisions = listed ?? [];
  const current = shownEvaluation(fit, engine.currentSha);

  let shownFit = fit;
  let shown = current;
  let revision: Extract<FitPageData, { status: "ok" }>["revision"] = null;
  if (rev !== undefined) {
    const number = parseRevisionParam(rev);
    const wanted: Revision | null = number === null ? null : await guarded("revision", () => getRevision(db, id, number));
    if (wanted === null || number === null) return { status: "not_found", engine };
    const latest = revisions[0]?.revision ?? wanted.revision;
    // The stored verdict is of the fit's present content: it describes any revision whose content equals it.
    // Without the revision list (it failed) nothing vouches for the page, so no stats are shown.
    const statsShown = listed !== null && wanted.matchesCurrent;
    shownFit = { ...fit, title: wanted.title, description: wanted.description, tags: wanted.tags, hullItem: wanted.hullItem, fit: wanted.fit };
    shown = statsShown ? current : NO_STATS;
    revision = { number: wanted.revision, of: latest, statsShown, note: wanted.note, createdAt: wanted.createdAt };
  }
  return {
    status: "ok",
    engine,
    fit: shownFit,
    hull: engine.catalog?.hulls.find((hull) => hull.def === shownFit.hullItem) ?? null,
    shown,
    grid: gridFor(shownFit, engine.catalog, shown),
    comments,
    fork,
    revisions,
    revision,
    broken: brokenOnBuild(shownFit, shown, engine.catalog),
    progression: readProgression(shownFit.fit, engine.catalog?.affinity.layout ?? null),
  };
}

// ---------------------------------------------------------------------------------------------------
// Compare

export type CompareSide =
  /** No fit asked for on this side. */
  | { status: "empty" }
  /** The fit doesn't exist or the viewer may not see it (the same answer for both). */
  | { status: "missing"; id: string }
  | {
      status: "found";
      id: string;
      title: string;
      authorUserId: string;
      authorName: string;
      fitStatus: FitSummary["status"];
      hullName: string;
      standing: Standing;
      rating: number | null;
      /** True when the stats are an older build's last valid ones, or the fit has none. */
      statsNote: string | null;
      modules: ReturnType<typeof countModules>;
      /** The fit's stored progression, for the compare rows. */
      progression: OpenProgression | null;
    };

export type CompareData =
  | Unavailable
  | { status: "ok"; engine: PageEngine; a: CompareSide; b: CompareSide; sections: CompareSection[]; modules: ModuleDiff; affinity: AffinityCompareRow[] };

/**
 * Two fits side by side. Each side is read through getFit with the viewer, so a fit the viewer can't see is
 * "missing" exactly like one that doesn't exist. Stats are the stored verdicts' hull spec sections, as the
 * fit page shows them (the current build's, or the last valid one for an outdated fit); nothing is evaluated.
 */
export async function loadCompare(deps: SiteDeps, ids: { a?: string; b?: string }, viewer: Viewer): Promise<CompareData> {
  const engine = await pageEngine(deps);
  const db = databaseOf(deps);
  if (!db) return { status: "unavailable", engine };
  const names = new Map((engine.catalog?.items ?? []).map((item) => [item.def, item.name]));
  const nameOf = (def: string) => names.get(def) ?? UNKNOWN_ITEM_NAME;

  const read = async (id: string | undefined) => {
    if (!id) return { side: { status: "empty" } as CompareSide, sections: null, failed: false };
    const fit = await guarded("compare read", () => getFit(db, id, { viewer, buildSha: engine.currentSha }));
    if (fit === null) {
      const reachable = await guarded("probe", () => db.query("SELECT 1"));
      return { side: { status: "missing", id } as CompareSide, sections: null, failed: !reachable };
    }
    const shown = shownEvaluation(fit, engine.currentSha);
    const hull = engine.catalog?.hulls.find((each) => each.def === fit.hullItem);
    const statsNote =
      shown.reference === null
        ? "THIS FIT HAS NEVER PASSED THE ENGINE, SO IT HAS NO STATS."
        : shown.result.sections === null
          ? "STATS APPEAR AFTER THE NEXT CHECK."
          : shown.referenceIsOld
            ? `STATS ARE FROM ITS LAST VALID BUILD.`
            : null;
    const side: CompareSide = {
      status: "found",
      id: fit.id,
      title: fit.title,
      authorUserId: fit.authorUserId,
      authorName: fit.authorName,
      fitStatus: fit.status,
      hullName: hull?.name ?? "UNKNOWN HULL",
      standing: shown.standing,
      rating: shown.reference?.rating ?? null,
      statsNote,
      modules: countModules(isOpenFit(fit.fit) ? fit.fit.modules.map((module) => module.item.def) : [], nameOf),
      progression: readProgression(fit.fit, engine.catalog?.affinity.layout ?? null),
    };
    return { side, sections: shown.result.sections, failed: false };
  };

  const a = await read(ids.a);
  const b = await read(ids.b);
  if (a.failed || b.failed) return { status: "unavailable", engine };
  return {
    status: "ok",
    engine,
    a: a.side,
    b: b.side,
    sections: alignSections(a.sections, b.sections),
    modules: diffModules(a.side.status === "found" ? a.side.modules : [], b.side.status === "found" ? b.side.modules : []),
    // Needs the catalog's affinity tree (names, XP table); without one the rows are left out.
    affinity: engine.catalog && a.side.status === "found" && b.side.status === "found" ? compareAffinity(engine.catalog.affinity, a.side.progression, b.side.progression) : [],
  };
}

// ---------------------------------------------------------------------------------------------------
// Builder

/** Where the builder starts: an empty hull picker, a saved fit to edit, or a copy of someone's fit (or of one of its revisions). */
export type BuilderStart = {
  /** The saved fit being edited; null for a new fit. */
  fitId: string | null;
  fit: OpenFit | null;
  meta: { title: string; description: string; tags: string[] };
  status: FitDetail["status"] | null;
  /** The saved fit's updatedAt: an autosaved draft made on an older save is not restored over it. */
  updatedAt: string | null;
  /** The fit this one was copied from. */
  copiedFrom: { id: string; title: string } | null;
  /** Why a requested copy couldn't be made. */
  note: string | null;
};

export type BuilderData =
  | { status: "ok"; start: BuilderStart }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "unavailable" }
  /** The stored fit lacks what the builder needs to edit it (it can still be read on its page). */
  | { status: "unreadable" };

const NEW_START: BuilderStart = { fitId: null, fit: null, meta: { title: "", description: "", tags: [] }, status: null, updatedAt: null, copiedFrom: null, note: null };
export const COPY_UNAVAILABLE = "THAT FIT CAN'T BE COPIED RIGHT NOW. START FROM A HULL INSTEAD.";

/**
 * What the builder opens with. A new fit needs neither the database nor the engine (the browser loads
 * the catalog); a copy reads a fit the viewer can see and keeps none of its words but its tags; an edit
 * is the author's alone.
 */
export async function loadBuilder(deps: Pick<SiteDeps, "database">, request: { fitId?: string; copyFrom?: string; rev?: unknown }, viewer: Viewer): Promise<BuilderData> {
  if (!request.fitId && !request.copyFrom) return { status: "ok", start: NEW_START };
  const db = databaseOf(deps);
  if (request.fitId) {
    if (!db) return { status: "unavailable" };
    const fit = await guarded("builder read", () => getFit(db, request.fitId!, { viewer }));
    if (fit === null) {
      const reachable = await guarded("probe", () => db.query("SELECT 1"));
      return reachable ? { status: "not_found" } : { status: "unavailable" };
    }
    if (fit.authorUserId !== viewer.userId || fit.status === "hidden") return { status: "forbidden" };
    if (!isEditableFit(fit.fit)) return { status: "unreadable" };
    return {
      status: "ok",
      start: { ...NEW_START, fitId: fit.id, fit: fit.fit, meta: { title: fit.title, description: fit.description, tags: fit.tags }, status: fit.status, updatedAt: fit.updatedAt },
    };
  }
  // `copyFrom` stays the fit's id (the fork credit names the fit); `rev` picks one of its revisions to copy
  // the content and tags from, after getFit has checked the viewer may see the fit at all.
  const source = db ? await guarded("builder copy", () => getFit(db, request.copyFrom!, { viewer })) : null;
  let content: { fit: unknown; tags: string[] } | null = source;
  if (source && request.rev !== undefined) {
    const number = parseRevisionParam(request.rev);
    content = number === null ? null : await guarded("builder copy revision", () => getRevision(db!, source.id, number));
  }
  if (!source || !content || !isEditableFit(content.fit)) return { status: "ok", start: { ...NEW_START, note: COPY_UNAVAILABLE } };
  return {
    status: "ok",
    start: { ...NEW_START, fit: content.fit, meta: { title: "", description: "", tags: content.tags }, copiedFrom: { id: source.id, title: source.title } },
  };
}

// ---------------------------------------------------------------------------------------------------
// Admin

export type ReportsData = Unavailable | { status: "ok"; engine: PageEngine; reports: Report[]; nextAfterId: string | null };

/** The caller has checked the viewer is an admin. */
export async function loadReports(deps: SiteDeps, afterId?: string): Promise<ReportsData> {
  const engine = await pageEngine(deps);
  const db = databaseOf(deps);
  if (!db) return { status: "unavailable", engine };
  const page = await guarded("reports", () => listOpenReports(db, { afterId }));
  return page ? { status: "ok", engine, ...page } : { status: "unavailable", engine };
}

export type PilotsData = { status: "unavailable" } | { status: "ok"; q: string; banned: boolean; pilots: AdminPilot[]; nextCursor: string | null };

/** /admin/pilots: pilots newest first, searched by name or id, optionally banned only. The caller has checked the viewer is an admin. */
export async function loadPilots(deps: Pick<SiteDeps, "database">, params: SearchParamsInput): Promise<PilotsData> {
  const db = databaseOf(deps);
  if (!db) return { status: "unavailable" };
  const read = (name: string) => {
    const value = params instanceof URLSearchParams ? params.get(name) : params[name];
    return typeof value === "string" ? value : undefined;
  };
  const q = (read("q") ?? "").trim();
  const banned = read("banned") === "1";
  const page = await guarded("pilots", () => listPilots(db, { q, banned, cursor: read("cursor") }));
  return page ? { status: "ok", q, banned, ...page } : { status: "unavailable" };
}

/**
 * The moderation a page offers the signed-in pilot: their session's state (auth-core moderationState), except that
 * a banned pilot gets none (no Admin link, no queues, no ban reasons), as every moderation write refuses them too.
 * A database that can't answer leaves the state as it is: the admin pages then show their unavailable state.
 */
export async function viewerModeration(deps: Pick<SiteDeps, "database">, userId: string, state: ModerationState): Promise<ModerationState> {
  if (state === "none") return "none";
  const db = databaseOf(deps);
  if (!db) return state;
  return (await guarded("ban check", () => isBanned(db, userId))) ? "none" : state;
}
