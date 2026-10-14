// Fit cards and the browse filters. The filters are a plain GET form, so the URL holds the whole
// browse state and the page works without JavaScript.
import Link from "next/link";
import { MAX_SEARCH_LENGTH, toBrowseSearch, type BrowseQuery, type SortKey } from "#/lib/fits/filters";
import type { FitCard, HullInfo } from "#/lib/site/loaders";
import { StandingBadge, count } from "#/components/ui";
import { ItemIcon } from "#/components/item-text";
import { BookmarkButton } from "#/components/fit/controls";
import { ModuleFilter } from "#/components/fit/module-filter";
import type { ModuleInfo } from "#/lib/site/module-search";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "top-week", label: "TOP THIS WEEK" },
  { key: "top-all", label: "TOP ALL TIME" },
  { key: "new", label: "NEW" },
  { key: "discussed", label: "MOST DISCUSSED" },
];

/** How many module kinds a card shows before it sums up the rest. */
const CARD_MODULES = 10;

/** The fit's modules as their icons, each kind once with its count (the game's lowercase "x"). */
function CardModules({ modules }: { modules: FitCard["modules"] }) {
  if (modules.length === 0) return null;
  const shown = modules.slice(0, CARD_MODULES);
  const rest = modules.slice(CARD_MODULES).reduce((sum, module) => sum + module.count, 0);
  return (
    <span className="fit-card__modules" role="img" aria-label={`Modules: ${modules.map((module) => (module.count > 1 ? `${module.name} x${module.count}` : module.name)).join(", ")}`}>
      {shown.map((module) => (
        <span key={module.def} className="fit-card__module" title={module.name}>
          <ItemIcon src={module.icon} size={40} />
          {module.count > 1 && <span className="fit-card__module-count">x{module.count}</span>}
        </span>
      ))}
      {rest > 0 && <span className="fit-card__module-more">+{rest}</span>}
    </span>
  );
}

/** `canBookmark`: the viewer is signed in, so a published card carries the bookmark toggle. */
export function FitCardView({ card, canBookmark = false }: { card: FitCard; canBookmark?: boolean }) {
  return (
    <li className="fit-card">
      <Link className="fit-card__link" href={`/fits/${card.id}`}>
        <span className="fit-card__head">
          <ItemIcon src={card.hullIcon} size={72} className="fit-card__hull-icon" />
          <span className="fit-card__head-text">
            <span className="fit-card__hull">{card.hullName}</span>
            <span className="fit-card__title">{card.title}</span>
          </span>
        </span>
        <CardModules modules={card.modules} />
      </Link>
      <span className="fit-card__meta">
        <Link className="link" href={`/u/${encodeURIComponent(card.authorUserId)}`}>
          {card.authorName}
        </Link>
      </span>
      <span className="fit-card__foot">
        <span className="fit-card__counts">
          <span className="rating">{count(card.votes, "UPVOTE")}</span>
          <span>{count(card.comments, "COMMENT")}</span>
          {card.rating !== null && card.standing !== "outdated" && <span className="rating">RATING {card.rating}</span>}
        </span>
        <span className="flex flex-wrap gap-1">
          {card.affinity && (
            <span className="chip" title="Affinity type and ship level">
              {card.affinity}
            </span>
          )}
          {card.status !== "published" && <span className={`badge badge--${card.status}`}>{card.status.toUpperCase()}</span>}
          <StandingBadge standing={card.standing} quiet />
          {canBookmark && card.status === "published" && <BookmarkButton fitId={card.id} bookmarked={card.bookmarked} />}
        </span>
      </span>
      {card.tags.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {card.tags.map((tag) => (
            <Link key={tag} className="chip" href={`/?tag=${encodeURIComponent(tag)}`}>
              {tag.toUpperCase()}
            </Link>
          ))}
        </span>
      )}
    </li>
  );
}

export function FitCards({ cards, empty, canBookmark = false }: { cards: FitCard[]; empty: string; canBookmark?: boolean }) {
  if (cards.length === 0) return <div className="empty-state">{empty}</div>;
  return (
    <ul className="fit-cards">
      {cards.map((card) => (
        <FitCardView key={card.id} card={card} canBookmark={canBookmark} />
      ))}
    </ul>
  );
}

const unique = (values: string[]) => [...new Set(values)].sort();
const words = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();

/** `signedIn` shows "From pilots I follow", which means nothing to a signed-out reader. */
export function BrowseFilters({
  query,
  hulls,
  selectedModules = [],
  action = "/",
  signedIn = false,
}: {
  query: BrowseQuery;
  hulls: HullInfo[];
  /** The names of `query.modules`, for their chips. */
  selectedModules?: ModuleInfo[];
  action?: string;
  signedIn?: boolean;
}) {
  const classes = unique(hulls.map((hull) => hull.hullClass));
  const roles = unique(hulls.map((hull) => hull.role).filter((role) => role !== "None"));
  return (
    <form className="filters" method="get" action={action} aria-label="Filters">
      <label className="field filters__search">
        SEARCH
        <input className="input" type="search" name="q" defaultValue={query.q ?? ""} placeholder="TITLE, DESCRIPTION OR PILOT" maxLength={MAX_SEARCH_LENGTH} />
      </label>
      <ModuleFilter selected={selectedModules} />
      <label className="field">
        HULL
        <select className="select" name="hull" defaultValue={query.hull ?? ""}>
          <option value="">ANY</option>
          {[...hulls]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((hull) => (
              <option key={hull.def} value={hull.def}>
                {hull.name}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        CLASS
        <select className="select" name="class" defaultValue={query.hullClass ?? ""}>
          <option value="">ANY</option>
          {classes.map((value) => (
            <option key={value} value={value}>
              {words(value)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        ROLE
        <select className="select" name="role" defaultValue={query.role ?? ""}>
          <option value="">ANY</option>
          {roles.map((value) => (
            <option key={value} value={value}>
              {words(value)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        TAG
        <input className="input" name="tag" defaultValue={query.tags.join(",")} placeholder="BRAWL, TURRET" maxLength={200} />
      </label>
      <label className="field">
        SORT
        <select className="select" name="sort" defaultValue={query.sort}>
          {SORTS.map((sort) => (
            <option key={sort.key} value={sort.key}>
              {sort.label}
            </option>
          ))}
        </select>
      </label>
      {query.author && <input type="hidden" name="author" value={query.author} />}
      <label className="check filters__check">
        <input type="checkbox" name="current" value="1" defaultChecked={query.currentBuild} />
        WORKS ON CURRENT BUILD
      </label>
      {signedIn && (
        <label className="check filters__check">
          <input type="checkbox" name="following" value="1" defaultChecked={query.following} />
          FROM PILOTS I FOLLOW
        </label>
      )}
      <span className="filters__buttons">
        <button type="submit" className="btn">
          APPLY
        </button>
        <Link className="btn btn--quiet" href={action}>
          RESET
        </Link>
      </span>
    </form>
  );
}

/** The link to the next page of the same browse state. */
export function MoreLink({ query, cursor, path = "/" }: { query: BrowseQuery; cursor: string | null; path?: string }) {
  if (!cursor) return null;
  const search = new URLSearchParams(toBrowseSearch(query));
  search.set("cursor", cursor);
  return (
    <div className="flex justify-center">
      <Link className="btn btn--quiet" href={`${path}?${search.toString()}`}>
        MORE FITS
      </Link>
    </div>
  );
}

/** The link to the next page of the bookmarks list (its cursor is its own, not a browse state). */
export function MoreBookmarks({ cursor }: { cursor: string | null }) {
  if (!cursor) return null;
  return (
    <div className="flex justify-center">
      <Link className="btn btn--quiet" href={`/bookmarks?${new URLSearchParams({ cursor })}`}>
        MORE FITS
      </Link>
    </div>
  );
}
