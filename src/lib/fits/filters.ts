// Browse filters and sort as they appear in the URL, and the opaque paging cursor. Pure: no database,
// no server-only import, so node --test and client components can both load it.

export const SORT_KEYS = ["top-week", "top-all", "new", "discussed"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const DEFAULT_SORT: SortKey = "top-week";
export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 24;

export type BrowseQuery = {
  /** Hull item definition GUID (decimal string). */
  hull?: string;
  /** Hull class name from the engine catalog. */
  hullClass?: string;
  /** Hull role name from the engine catalog. */
  role?: string;
  /** A fit must carry all of these (lowercase). */
  tags: string[];
  /** Clerk user id. */
  author?: string;
  /** Only fits with a valid evaluation on the current build. */
  currentBuild: boolean;
  sort: SortKey;
};

export type SearchParamsInput =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;
const GUID = /^\d{1,20}$/;
const NAME = /^[A-Za-z0-9_]{1,40}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,100}$/;

function all(input: SearchParamsInput, name: string): string[] {
  if (input instanceof URLSearchParams) return input.getAll(name);
  const value = input[name];
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : [...value];
}

function first(input: SearchParamsInput, name: string): string | undefined {
  return all(input, name)[0];
}

/** Lowercases and validates one tag; null when it isn't a tag. */
export function normalizeTag(raw: string): string | null {
  const tag = raw.trim().toLowerCase();
  return TAG.test(tag) ? tag : null;
}

export function normalizeTags(raw: readonly string[]): string[] {
  const tags: string[] = [];
  for (const piece of raw.flatMap((value) => value.split(","))) {
    const tag = normalizeTag(piece);
    if (tag !== null && !tags.includes(tag)) tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

function matching(value: string | undefined, pattern: RegExp): string | undefined {
  return value !== undefined && pattern.test(value) ? value : undefined;
}

export function parseBrowseParams(input: SearchParamsInput): BrowseQuery {
  const sort = first(input, "sort");
  const query: BrowseQuery = {
    sort: SORT_KEYS.find((key) => key === sort) ?? DEFAULT_SORT,
    tags: normalizeTags(all(input, "tag")),
    currentBuild: first(input, "current") === "1",
  };
  const hull = matching(first(input, "hull"), GUID);
  const hullClass = matching(first(input, "class"), NAME);
  const role = matching(first(input, "role"), NAME);
  const author = matching(first(input, "author"), USER_ID);
  if (hull !== undefined) query.hull = hull;
  if (hullClass !== undefined) query.hullClass = hullClass;
  if (role !== undefined) query.role = role;
  if (author !== undefined) query.author = author;
  return query;
}

/** The query string (no leading "?") for a browse state; defaults are omitted. */
export function toBrowseSearch(query: BrowseQuery): string {
  const params = new URLSearchParams();
  if (query.hull) params.set("hull", query.hull);
  if (query.hullClass) params.set("class", query.hullClass);
  if (query.role) params.set("role", query.role);
  for (const tag of query.tags) params.append("tag", tag);
  if (query.author) params.set("author", query.author);
  if (query.currentBuild) params.set("current", "1");
  if (query.sort !== DEFAULT_SORT) params.set("sort", query.sort);
  return params.toString();
}

/**
 * Where a page ended. Every sort orders by (score desc, sortAt desc, id desc); `score` is 0 for "new".
 * `at` is the database's own timestamp text, kept verbatim so microseconds survive the round trip.
 * A "top-week" cursor also carries `now`, the moment its week counts back from, so every page of one
 * browse ranks by the same week.
 */
export type Cursor = { sort: SortKey; score: number; at: string; id: string; now?: string };

const INT4_MAX = 2_147_483_647;
const FIT_ID = /^[0-9A-Za-z]{10}$/;
// timestamptz::text: "2026-10-13 10:00:00.123456+00", the offset as +HH or +HH:MM.
const PG_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?[+-](0\d|1[0-5])(:[0-5]\d)?$/;

/** A real calendar date and time in Postgres' text form, so the database's cast can't fail on it. */
function isPgTimestamp(text: string): boolean {
  const match = PG_TIMESTAMP.exec(text);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

/** An instant as Date.toISOString writes it. */
function isIsoInstant(text: string): boolean {
  const time = Date.parse(text);
  return !Number.isNaN(time) && new Date(time).toISOString() === text;
}

// base64url over UTF-8 with the web platform's own functions, so client code can load this module.
function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("not base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function encodeCursor(cursor: Cursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

/** The cursor, or undefined for one made for another sort or anything that isn't a cursor this site made. */
export function decodeCursor(text: string, sort: SortKey): Cursor | undefined {
  if (!text || text.length > 300) return undefined;
  try {
    const value: unknown = JSON.parse(fromBase64Url(text));
    if (typeof value !== "object" || value === null) return undefined;
    const { sort: cursorSort, score, at, id, now } = value as Record<string, unknown>;
    if (cursorSort !== sort) return undefined;
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > INT4_MAX) return undefined;
    if (typeof at !== "string" || !isPgTimestamp(at)) return undefined;
    if (typeof id !== "string" || !FIT_ID.test(id)) return undefined;
    if (sort !== "top-week") return { sort, score, at, id };
    if (typeof now !== "string" || !isIsoInstant(now)) return undefined;
    return { sort, score, at, id, now };
  } catch {
    return undefined;
  }
}
