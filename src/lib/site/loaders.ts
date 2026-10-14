// What each page reads, as plain functions over their dependencies, so route tests can run them on
// pglite and a stub (or dead) engine. Reads never throw for an outage: a database that is missing or
// failing gives { status: "unavailable" }, and an engine that is down gives pages that render from
// the verdicts already stored, with `engine.state.status === "down"` for the banner.
import type { EngineResult } from "../engine/client";
import type { EngineMonitor, EngineState } from "../engine/engine-state";
import type { Catalog, CatalogHull, OpenFit } from "../engine/types";
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
import { getPilotProfile, type PilotProfile } from "../fits/pilots";
import { getRevision, listRevisions, parseRevisionParam, type Revision, type RevisionSummary } from "../fits/revisions";
import { shownEvaluation, standingOf, type Shown, type Standing } from "../fits/standing";
import { buildGridModel, catalogLookups, type GridModel } from "#/components/grid/model";
import { isEditableFit, isOpenFit } from "../engine/open-fit";
import { baseIcon } from "../art/item-icon";

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
  status: FitSummary["status"];
  standing: Standing;
  /** The engine's rating on the current build, or the last valid one for an outdated fit. */
  rating: number | null;
};

export function toCard(fit: FitSummary, catalog: Catalog | null, currentSha: string | null): FitCard {
  const standing = standingOf(fit, currentSha);
  const rating = standing === "current" ? fit.evaluation!.rating : (fit.lastValidEvaluation?.rating ?? null);
  const hull = catalog?.hulls.find((each) => each.def === fit.hullItem);
  return {
    id: fit.id,
    title: fit.title,
    hullName: hull?.name ?? "UNKNOWN HULL",
    hullIcon: hull ? baseIcon(hull.path) : null,
    authorUserId: fit.authorUserId,
    authorName: fit.authorName,
    tags: fit.tags,
    votes: fit.votes,
    comments: fit.comments,
    status: fit.status,
    standing,
    rating,
  };
}

export type BrowseData =
  | Unavailable
  | { status: "ok"; engine: PageEngine; query: BrowseQuery; cards: FitCard[]; nextCursor: string | null; hulls: HullInfo[] };

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
  };
}

export type AuthorData =
  | Unavailable
  | { status: "not_found"; engine: PageEngine }
  | (Extract<BrowseData, { status: "ok" }> & { pilot: PilotProfile });

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
  const data = await loadBrowse(deps, params, viewer, { author: userId, hull: undefined, hullClass: undefined, role: undefined, tags: [], following: false });
  if (data.status !== "ok") return data;
  const db = databaseOf(deps)!;
  const profile = await guarded("pilot", async () => ({ found: await getPilotProfile(db, userId, viewer) }));
  if (!profile) return { status: "unavailable", engine: data.engine };
  const own = viewer.userId === userId;
  const pilot = profile.found ?? (own && viewer.name ? freshPilot(userId, viewer.name) : null);
  if (!pilot) return { status: "not_found", engine: data.engine };
  return { ...data, pilot };
}

// ---------------------------------------------------------------------------------------------------
// Fit page

export type GridState =
  | { status: "ready"; model: GridModel }
  /** No catalog: the engine has been down since this server started. */
  | { status: "no_catalog" }
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
      /** Newest first; empty for a fit with no history (published before history existed, or still a draft). */
      revisions: RevisionSummary[];
      /**
       * Set when the page shows one revision read-only (`?rev=N`): `fit` then carries that revision's words and
       * content, and `statsShown` says whether `shown` describes it (only the latest revision has a verdict).
       */
      revision: { number: number; of: number; statsShown: boolean; note: string | null; createdAt: string } | null;
    };

/** What `shown` holds for a revision that has no verdict of its own. */
const NO_STATS: Shown = { standing: "unknown", reference: null, referenceIsOld: false, result: { stats: [], conduits: [], regaliaSets: [], sections: null }, issues: [] };

export function gridFor(fit: FitDetail, catalog: Catalog | null, shown: Shown): GridState {
  const open = fit.fit;
  if (!isOpenFit(open)) return { status: "unreadable" };
  if (!catalog) return { status: "no_catalog" };
  const hull = catalog.hulls.find((each) => each.def === open.hull.def);
  if (!hull) return { status: "unknown_hull" };
  const lookups = catalogLookups(catalog);
  const model = buildGridModel({ hull, ...lookups }, open, {
    issues: shown.issues,
    conduits: shown.result.conduits,
    regaliaSets: shown.result.regaliaSets,
  });
  return { status: "ready", model };
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
  const revisions = (await guarded("revisions", () => listRevisions(db, id))) ?? [];
  const current = shownEvaluation(fit, engine.currentSha);

  let shownFit = fit;
  let shown = current;
  let revision: Extract<FitPageData, { status: "ok" }>["revision"] = null;
  if (rev !== undefined) {
    const number = parseRevisionParam(rev);
    const wanted: Revision | null = number === null ? null : await guarded("revision", () => getRevision(db, id, number));
    if (wanted === null || number === null) return { status: "not_found", engine };
    const latest = revisions[0]?.revision ?? wanted.revision;
    // The stored verdict is of the fit's present content: it describes this revision only if it is the latest and still current.
    const statsShown = wanted.revision === latest && wanted.matchesCurrent;
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
    revisions,
    revision,
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
export async function loadBuilder(deps: Pick<SiteDeps, "database">, request: { fitId?: string; copyFrom?: string; rev?: string }, viewer: Viewer): Promise<BuilderData> {
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
