// A typed client for the loadout engine. It runs on the server (given the internal URL) and in the
// browser (given the public URL from the public config) and never throws: every outcome is an
// EngineResult. It knows nothing about fits or the database; fits/service.ts and the pages build on it.

import type { Catalog, EvaluationResponse, ErrorBody, FactsBody, FitBody, FitStringBody, HealthResponse, OpenFit, OpenItem } from "./types.ts";

export type EngineErrorKind =
  /** Unreachable, not configured, a 5xx, or an answer that isn't the engine's. Worth retrying later. */
  | "unavailable"
  | "timeout"
  /** The engine refused the input (400). `message` is the engine's, safe to show. */
  | "rejected"
  | "rateLimited"
  | "tooLarge"
  /** The caller aborted the request (a newer edit superseded it). */
  | "cancelled";

export type EngineError = {
  kind: EngineErrorKind;
  message: string;
  /** rateLimited only: how long the engine asked to wait (Retry-After), when it said. */
  retryAfterMs?: number;
};

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

export type CatalogResponse = { status: "ok"; catalog: Catalog; etag: string | null } | { status: "notModified" };

export type EngineTimeouts = { healthMs: number; catalogMs: number; evaluateMs: number; fitStringMs: number };

export const DEFAULT_TIMEOUTS: EngineTimeouts = { healthMs: 3_000, catalogMs: 15_000, evaluateMs: 5_000, fitStringMs: 5_000 };

export type EngineClientOptions = {
  /** No trailing slash. Null when the site has no engine configured: every call is then "unavailable". */
  baseUrl: string | null;
  timeouts?: Partial<EngineTimeouts>;
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
};

export type EngineClient = {
  health(): Promise<EngineResult<HealthResponse>>;
  /** Pass the etag of a catalog you hold to get `notModified` when it is still current. */
  catalog(options?: { ifNoneMatch?: string | null }): Promise<EngineResult<CatalogResponse>>;
  /** `signal` cancels the request; it then resolves with a "cancelled" error. */
  evaluate(fit: OpenFit, options?: { signal?: AbortSignal }): Promise<EngineResult<EvaluationResponse>>;
  importFitString(fitString: string): Promise<EngineResult<FitBody>>;
  exportFitString(fit: OpenFit): Promise<EngineResult<FitStringBody>>;
  /** The item tooltip's facts for one rolled item. `signal` cancels it, as for evaluate. */
  itemFacts(item: OpenItem, options?: { signal?: AbortSignal }): Promise<EngineResult<FactsBody>>;
};

const fail = (kind: EngineErrorKind, message: string): { ok: false; error: EngineError } => ({ ok: false, error: { kind, message } });

type Raw<T> = { ok: false; error: EngineError } | { ok: true; notModified: true } | { ok: true; notModified: false; value: T; etag: string | null };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Just enough of a check to tell the engine from a proxy's error page or a wrong URL; types.test.mjs
// holds the full shapes.
const isHealth = (v: unknown): v is HealthResponse => isObject(v) && typeof v.buildSha === "string";
const isCatalog = (v: unknown): v is Catalog =>
  isObject(v) && typeof v.buildSha === "string" && Array.isArray(v.hulls) && Array.isArray(v.items) && isObject(v.affinity);
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

export function createEngineClient(options: EngineClientOptions): EngineClient {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    timeoutMs: number,
    guard: (value: unknown) => value is T,
    extra: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Raw<T>> {
    if (options.baseUrl === null) return fail("unavailable", "The loadout engine isn't configured.");
    try {
      const doFetch = options.fetch ?? fetch;
      const response = await doFetch(`${options.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
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
      if (response.status === 400) {
        const body: unknown = await response.json().catch(() => null);
        const message = isObject(body) && typeof (body as Partial<ErrorBody>).error === "string" ? (body as ErrorBody).error : "The engine rejected the request.";
        return fail("rejected", message);
      }
      if (!response.ok) return fail("unavailable", `The loadout engine answered ${response.status}.`);

      const body: unknown = await response.json().catch(() => null);
      if (!guard(body)) return fail("unavailable", "The loadout engine sent an answer the site doesn't understand.");
      return { ok: true, notModified: false, value: body, etag: response.headers.get("etag") };
    } catch (error) {
      if (extra.signal?.aborted) return fail("cancelled", "The request was cancelled.");
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        return fail("timeout", "The loadout engine took too long to answer.");
      }
      return fail("unavailable", "The loadout engine can't be reached.");
    }
  }

  // A 304 only arises from a request that sent If-None-Match, which only catalog() does.
  const plain = <T>(result: Raw<T>): EngineResult<T> =>
    !result.ok
      ? result
      : result.notModified
        ? fail("unavailable", "The loadout engine sent an unexpected answer.")
        : { ok: true, value: result.value };

  return {
    async health() {
      return plain(await call("GET", "/healthz", timeouts.healthMs, isHealth));
    },
    async catalog(opts = {}) {
      const result = await call("GET", "/v1/catalog", timeouts.catalogMs, isCatalog, {
        headers: opts.ifNoneMatch ? { "if-none-match": opts.ifNoneMatch } : undefined,
      });
      if (!result.ok) return result;
      if (result.notModified) return { ok: true, value: { status: "notModified" } };
      return { ok: true, value: { status: "ok", catalog: result.value, etag: result.etag } };
    },
    async evaluate(fit, opts = {}) {
      return plain(await call("POST", "/v1/evaluate", timeouts.evaluateMs, isEvaluation, { body: { fit }, signal: opts.signal }));
    },
    async importFitString(fitString) {
      return plain(await call("POST", "/v1/fits/import", timeouts.fitStringMs, isFitBody, { body: { fitString } }));
    },
    async exportFitString(fit) {
      return plain(await call("POST", "/v1/fits/export", timeouts.fitStringMs, isFitStringBody, { body: { fit } }));
    },
    async itemFacts(item, opts = {}) {
      return plain(await call("POST", "/v1/item-facts", timeouts.evaluateMs, isFactsBody, { body: { item }, signal: opts.signal }));
    },
  };
}
