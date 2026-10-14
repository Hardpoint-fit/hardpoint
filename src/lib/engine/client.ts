// A typed client for the game data API (api.thecitadel.com). It runs on the server (given the internal URL)
// and in the browser (given the public URL from the public config) and never throws: every outcome is an
// EngineResult. It knows nothing about fits or the database; fits/service.ts and the pages build on it.

import {
  absentPartBody,
  assembleCatalog,
  CATALOG_PARTS,
  CATALOG_ROUTES,
  commonBuild,
  isOptionalPart,
  isPartBody,
  type CatalogBodies,
  type CatalogPart,
} from "./catalog-resources.ts";
import type {
  Catalog,
  ErrorBody,
  EvaluationResponse,
  FactsBody,
  FitBody,
  FitStringBody,
  GridModsResponse,
  OpenFit,
  OpenItem,
  RollRequest,
  RollResponse,
  StatusResponse,
} from "./types.ts";

export type EngineErrorKind =
  /** Unreachable, not configured, a 502/503/504, or an answer that isn't the API's. Worth retrying later. */
  | "unavailable"
  /** The API answered with another 5xx: it is up but the check itself failed. `message` is safe to show. */
  | "failed"
  | "timeout"
  /** The API refused the input (a 4xx). `message` is the API's, safe to show. */
  | "rejected"
  | "rateLimited"
  | "tooLarge"
  /** The caller aborted the request (a newer edit superseded it). */
  | "cancelled";

export type EngineError = {
  kind: EngineErrorKind;
  message: string;
  /** rateLimited only: how long the API asked to wait (Retry-After), when it said. */
  retryAfterMs?: number;
};

/** What users are told when the API can't be reached at all (network error, not configured, a proxy's 502/503/504, unreadable answer). */
export const ENGINE_UNREACHABLE_MESSAGE = "The engine can't be reached right now.";
/** What users are told when the API answered with an error of its own (a 5xx other than 502/503/504). */
export const ENGINE_FAILED_MESSAGE = "The fit check failed on the engine. Your draft is saved; try again, and report the fit if it keeps failing.";

/** The wait a Retry-After is held to: never a tight loop (0 or a past date), never minutes of nothing. */
export const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_MS = 60_000;

/**
 * Retry-After as seconds or an HTTP date, in milliseconds from `now`, clamped to
 * [RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS]; undefined when absent or unreadable.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const at = /^\d+$/.test(trimmed) ? now + Number(trimmed) * 1000 : Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, at - now));
}
export type EngineResult<T> = { ok: true; value: T } | { ok: false; error: EngineError };

/** What came back for each part of the catalog, with the validator to revalidate it by. */
export type CatalogParts = { [P in CatalogPart]: { body: CatalogBodies[P]; etag: string | null } };

/** A catalog the caller holds, to revalidate: each part is asked for again with its own If-None-Match. */
export type HeldCatalog = { parts: CatalogParts };

export type CatalogResponse =
  | {
      status: "ok";
      catalog: Catalog;
      /** One tag for the whole catalog, derived from its parts' tags; null when a part came without one. */
      etag: string | null;
      parts: CatalogParts;
    }
  | { status: "notModified" };

export type EngineTimeouts = { statusMs: number; catalogMs: number; evaluateMs: number; fitStringMs: number };

export const DEFAULT_TIMEOUTS: EngineTimeouts = { statusMs: 3_000, catalogMs: 15_000, evaluateMs: 5_000, fitStringMs: 5_000 };

export type EngineClientOptions = {
  /** No trailing slash. Null when the site has no API configured: every call is then "unavailable". */
  baseUrl: string | null;
  /**
   * The PUBLIC API origin (no trailing slash) the catalog's art URLs are made absolute with, because the
   * browser loads art from it; `baseUrl` may be an internal address. Defaults to `baseUrl`.
   */
  artBaseUrl?: string | null;
  timeouts?: Partial<EngineTimeouts>;
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
};

export type EngineClient = {
  /** Which build is live (GET /v1/status). */
  status(): Promise<EngineResult<StatusResponse>>;
  /**
   * The catalog, read from the API's resource routes and assembled. Pass the one you hold to get
   * `notModified` when every part is still current.
   */
  catalog(options?: { held?: HeldCatalog | null }): Promise<EngineResult<CatalogResponse>>;
  /** `signal` cancels the request; it then resolves with a "cancelled" error. */
  evaluate(fit: OpenFit, options?: { signal?: AbortSignal }): Promise<EngineResult<EvaluationResponse>>;
  importFitString(fitString: string): Promise<EngineResult<FitBody>>;
  exportFitString(fit: OpenFit): Promise<EngineResult<FitStringBody>>;
  /** The item tooltip's facts for one rolled item. `signal` cancels it, as for evaluate. */
  itemFacts(item: OpenItem, options?: { signal?: AbortSignal }): Promise<EngineResult<FactsBody>>;
  /** What each grid consumable can do to the fit's grid, by the game's rules. `signal` cancels it, as for evaluate. */
  gridMods(fit: OpenFit, options?: { signal?: AbortSignal }): Promise<EngineResult<GridModsResponse>>;
  /** The item's modifiers rolled by the game's roller, all of them or `line` alone. `signal` cancels it, as for evaluate. */
  roll(request: RollRequest, options?: { signal?: AbortSignal }): Promise<EngineResult<RollResponse>>;
};

const fail = (kind: EngineErrorKind, message: string): { ok: false; error: EngineError } => ({ ok: false, error: { kind, message } });

type Raw<T> =
  | { ok: false; error: EngineError; status?: number }
  | { ok: true; notModified: true }
  | { ok: true; notModified: false; value: T; etag: string | null };

/**
 * The tag a missing optional part is held under. Never sent to the API: the part is asked for again
 * without If-None-Match, and another 404 leaves it as held.
 */
export const ABSENT_PART_ETAG = "absent";

/** Optional parts already reported missing, so each is logged once per process rather than per load. */
const reportedAbsent = new Set<CatalogPart>();

function reportAbsent(part: CatalogPart) {
  if (reportedAbsent.has(part)) return;
  reportedAbsent.add(part);
  console.warn(`engine: ${CATALOG_ROUTES[part].path} answered 404 (an older API); the catalog holds no ${part} and the builder hides what needs them.`);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Just enough of a check to tell the API from a proxy's error page or a wrong URL; types.test.mjs
// holds the full shapes.
const isStatus = (v: unknown): v is StatusResponse => isObject(v) && typeof v.build === "string";
const isEvaluation = (v: unknown): v is EvaluationResponse =>
  isObject(v) &&
  typeof v.buildSha === "string" &&
  typeof v.valid === "boolean" &&
  typeof v.rating === "number" &&
  Array.isArray(v.issues) &&
  Array.isArray(v.stats);
const isFactsBody = (v: unknown): v is FactsBody => isObject(v) && Array.isArray(v.facts);
const isFitBody = (v: unknown): v is FitBody => isObject(v) && isObject(v.fit);
const isFitStringBody = (v: unknown): v is FitStringBody => isObject(v) && typeof v.fitString === "string";
const isGridMods = (v: unknown): v is GridModsResponse =>
  isObject(v) && typeof v.buildSha === "string" && isObject(v.budget) && Array.isArray(v.consumables);
const isRoll = (v: unknown): v is RollResponse =>
  isObject(v) &&
  typeof v.seed === "number" &&
  typeof v.breachTier === "number" &&
  isObject(v.item) &&
  isObject(v.item.roll) &&
  Array.isArray(v.item.roll.modifiers);

/** The `{ error: { code, message } }` envelope every API error carries, or null for any other body. */
function envelopeOf(body: unknown): ErrorBody["error"] | null {
  if (!isObject(body) || !isObject(body.error)) return null;
  const { code, message } = body.error;
  return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

/**
 * One tag for the catalog: a hash of its parts' tags and of the origin its art URLs were made absolute
 * with, so a changed GAME_DATA_API_URL gives browsers a new tag and they drop their copy. Null when a
 * part has no tag.
 */
async function catalogEtag(parts: CatalogParts, artBase: string | null): Promise<string | null> {
  const tags = CATALOG_PARTS.map((part) => parts[part].etag);
  if (tags.some((tag) => tag === null)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode([...tags, `art:${artBase ?? ""}`].join("\n")));
  return `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
}

/** Names this app and where to reach it, as the API asks of a client. */
const USER_AGENT = "hardpoint.fit (https://hardpoint.fit)";

export function createEngineClient(options: EngineClientOptions): EngineClient {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const artBase = options.artBaseUrl === undefined ? options.baseUrl : options.artBaseUrl;

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    timeoutMs: number,
    guard: (value: unknown) => value is T,
    extra: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Raw<T>> {
    if (options.baseUrl === null) return fail("unavailable", "The engine isn't configured.");
    try {
      const doFetch = options.fetch ?? fetch;
      const response = await doFetch(`${options.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          // The API asks its clients to say who they are (a missing one earns a Warning header). Browsers
          // choose their own User-Agent, and setting one would add a CORS preflight, so only the server does.
          ...(typeof window === "undefined" ? { "user-agent": USER_AGENT } : {}),
          ...(extra.body !== undefined ? { "content-type": "application/json" } : {}),
          ...extra.headers,
        },
        body: extra.body === undefined ? undefined : JSON.stringify(extra.body),
        cache: "no-store",
        signal: extra.signal ? AbortSignal.any([extra.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });

      if (response.status === 304) return { ok: true, notModified: true };
      if (response.status === 413) return fail("tooLarge", "That fit is too large for the engine.");
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        return { ok: false, error: { kind: "rateLimited", message: "Too many requests. Wait a moment and try again.", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } };
      }
      if (response.status >= 400 && response.status < 500) {
        const envelope = envelopeOf(await response.json().catch(() => null));
        return { ...fail("rejected", envelope?.message ?? "The engine rejected the request."), status: response.status };
      }
      // 502/503/504 are the proxy (or the API saying "busy") while the API is down or restarting.
      if (response.status === 502 || response.status === 503 || response.status === 504) return fail("unavailable", ENGINE_UNREACHABLE_MESSAGE);
      if (response.status >= 500) return fail("failed", ENGINE_FAILED_MESSAGE);
      if (!response.ok) return fail("unavailable", ENGINE_UNREACHABLE_MESSAGE);

      const body: unknown = await response.json().catch(() => null);
      if (!guard(body)) return fail("unavailable", "The engine sent an answer the site doesn't understand.");
      return { ok: true, notModified: false, value: body, etag: response.headers.get("etag") };
    } catch (error) {
      if (extra.signal?.aborted) return fail("cancelled", "The request was cancelled.");
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        return fail("timeout", "The engine took too long to answer.");
      }
      return fail("unavailable", ENGINE_UNREACHABLE_MESSAGE);
    }
  }

  // A 304 only arises from a request that sent If-None-Match, which only catalog() does.
  const plain = <T>(result: Raw<T>): EngineResult<T> =>
    !result.ok
      ? { ok: false, error: result.error }
      : result.notModified
        ? fail("unavailable", "The engine sent an unexpected answer.")
        : { ok: true, value: result.value };

  /** One try at the catalog: every part, asked for together. `changed` when the parts are of different builds. */
  async function fetchCatalog(held: HeldCatalog | null): Promise<EngineResult<CatalogResponse> | "changed"> {
    const results = await Promise.all(
      CATALOG_PARTS.map((part) => {
        const heldTag = held?.parts[part].etag;
        const validator = heldTag === ABSENT_PART_ETAG ? null : heldTag;
        return call("GET", CATALOG_ROUTES[part].path, timeouts.catalogMs, (value): value is CatalogBodies[typeof part] => isPartBody(part, value), {
          headers: validator ? { "if-none-match": validator } : undefined,
        });
      }),
    );
    const parts: Record<string, { body: unknown; etag: string | null }> = {};
    const absent: CatalogPart[] = [];
    let anyChanged = false;
    for (const [index, part] of CATALOG_PARTS.entries()) {
      const result = results[index]!;
      if (!result.ok) {
        if (!(result.status === 404 && isOptionalPart(part))) return { ok: false, error: result.error };
        // An older API without this route: the part reads as empty (its body is filled in below, once the
        // catalog's build is known). Unchanged when the held catalog already had it missing.
        reportAbsent(part);
        absent.push(part);
        if (held?.parts[part].etag !== ABSENT_PART_ETAG) anyChanged = true;
        continue;
      }
      if (result.notModified) {
        // A 304 answers a request that sent the held tag, so the part is held.
        if (!held) return fail("unavailable", "The engine sent an unexpected answer.");
        parts[part] = held.parts[part];
      } else {
        anyChanged = true;
        parts[part] = { body: result.value, etag: result.etag };
      }
    }
    if (!anyChanged) return { ok: true, value: { status: "notModified" } };

    // A required part is always present, so its build is the catalog's.
    const build = (parts.items!.body as CatalogBodies["items"]).build;
    for (const part of absent) {
      if (isOptionalPart(part)) parts[part] = { body: absentPartBody(part, build), etag: ABSENT_PART_ETAG };
    }

    const assembled = parts as CatalogParts;
    const bodies = Object.fromEntries(CATALOG_PARTS.map((part) => [part, assembled[part].body])) as CatalogBodies;
    // The parts were fetched one request each; a build that went live in between leaves them mixed.
    if (commonBuild(bodies) === null) return "changed";
    return { ok: true, value: { status: "ok", catalog: assembleCatalog(bodies, artBase), etag: await catalogEtag(assembled, artBase), parts: assembled } };
  }

  return {
    async status() {
      return plain(await call("GET", "/v1/status", timeouts.statusMs, isStatus));
    },
    async catalog(opts = {}) {
      // A deploy can land between the parts' requests: ask again from scratch once before giving up.
      const first = await fetchCatalog(opts.held ?? null);
      if (first !== "changed") return first;
      const second = await fetchCatalog(null);
      return second === "changed" ? fail("unavailable", "The engine changed builds while the catalog was loading.") : second;
    },
    async evaluate(fit, opts = {}) {
      return plain(await call("POST", "/v1/fits/evaluate", timeouts.evaluateMs, isEvaluation, { body: { fit }, signal: opts.signal }));
    },
    async importFitString(fitString) {
      return plain(await call("POST", "/v1/fits/import", timeouts.fitStringMs, isFitBody, { body: { fitString } }));
    },
    async exportFitString(fit) {
      return plain(await call("POST", "/v1/fits/export", timeouts.fitStringMs, isFitStringBody, { body: { fit } }));
    },
    async itemFacts(item, opts = {}) {
      return plain(await call("POST", "/v1/items/facts", timeouts.evaluateMs, isFactsBody, { body: { item }, signal: opts.signal }));
    },
    async gridMods(fit, opts = {}) {
      return plain(await call("POST", "/v1/grid-mods", timeouts.evaluateMs, isGridMods, { body: { fit }, signal: opts.signal }));
    },
    async roll(request, opts = {}) {
      return plain(await call("POST", "/v1/roll", timeouts.evaluateMs, isRoll, { body: request, signal: opts.signal }));
    },
  };
}
