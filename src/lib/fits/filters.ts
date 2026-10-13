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
 */
export type Cursor = { sort: SortKey; score: number; at: string; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(text: string, sort: SortKey): Cursor | undefined {
  if (!text || text.length > 300) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const { sort: cursorSort, score, at, id } = value as Record<string, unknown>;
    if (cursorSort !== sort) return undefined;
    if (typeof score !== "number" || !Number.isInteger(score)) return undefined;
    if (typeof at !== "string" || at.length > 40 || typeof id !== "string" || id.length > 40) return undefined;
    return { sort, score, at, id };
  } catch {
    return undefined;
  }
}
