// Fit cards and the browse filters. The filters are a plain GET form, so the URL holds the whole
// browse state and the page works without JavaScript.
import Link from "next/link";
import { toBrowseSearch, type BrowseQuery, type SortKey } from "#/lib/fits/filters";
import type { FitCard, HullInfo } from "#/lib/site/loaders";
import { StandingBadge, count } from "#/components/ui";
import { ItemIcon } from "#/components/item-text";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "top-week", label: "TOP THIS WEEK" },
  { key: "top-all", label: "TOP ALL TIME" },
  { key: "new", label: "NEW" },
  { key: "discussed", label: "MOST DISCUSSED" },
];

export function FitCardView({ card }: { card: FitCard }) {
  return (
    <li className="fit-card">
      <Link className="fit-card__link" href={`/fits/${card.id}`}>
        <span className="fit-card__head">
          <ItemIcon src={card.hullIcon} size={40} />
          <span className="fit-card__head-text">
            <span className="fit-card__hull">{card.hullName}</span>
            <span className="fit-card__title">{card.title}</span>
          </span>
        </span>
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
          {card.status !== "published" && <span className={`badge badge--${card.status}`}>{card.status.toUpperCase()}</span>}
          <StandingBadge standing={card.standing} quiet />
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

export function FitCards({ cards, empty }: { cards: FitCard[]; empty: string }) {
  if (cards.length === 0) return <div className="empty-state">{empty}</div>;
  return (
    <ul className="fit-cards">
      {cards.map((card) => (
        <FitCardView key={card.id} card={card} />
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
  action = "/",
  signedIn = false,
}: {
  query: BrowseQuery;
  hulls: HullInfo[];
  action?: string;
  signedIn?: boolean;
}) {
  const classes = unique(hulls.map((hull) => hull.hullClass));
  const roles = unique(hulls.map((hull) => hull.role).filter((role) => role !== "None"));
  return (
    <form className="filters" method="get" action={action} aria-label="Filters">
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
