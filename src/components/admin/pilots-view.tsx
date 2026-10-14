// /admin/pilots: a search form and one row per pilot with their ban state and the BAN / UNBAN control. A plain
// render of loadPilots, so view tests can render it without Next.
import Link from "next/link";
import { BanControls } from "#/components/fit/controls";
import { PilotAvatar } from "#/components/pilot/pilot-avatar";
import { Panel, UnavailableState, formatDate } from "#/components/ui";
import { MAX_SEARCH_LENGTH } from "#/lib/fits/filters";
import type { PilotsData } from "#/lib/site/loaders";

function moreHref(data: Extract<PilotsData, { status: "ok" }>): string {
  const params = new URLSearchParams();
  if (data.q) params.set("q", data.q);
  if (data.banned) params.set("banned", "1");
  params.set("cursor", data.nextCursor!);
  return `/admin/pilots?${params}`;
}

export function PilotsView({ data, viewerId, siteAdmins }: { data: PilotsData; viewerId: string; siteAdmins: readonly string[] }) {
  if (data.status === "unavailable") return <UnavailableState what="PILOTS" />;
  return (
    <>
      <form className="filters" action="/admin/pilots" method="get" role="search">
        <label className="field">
          NAME OR USER ID
          <input className="input" type="search" name="q" defaultValue={data.q} maxLength={MAX_SEARCH_LENGTH} />
        </label>
        <label className="check filters__check">
          <input type="checkbox" name="banned" value="1" defaultChecked={data.banned} />
          BANNED ONLY
        </label>
        <span className="filters__buttons">
          <button type="submit" className="btn">
            SEARCH
          </button>
          <Link className="btn btn--quiet" href="/admin/pilots">
            RESET
          </Link>
        </span>
      </form>
      <Panel title="PILOTS" aside={String(data.pilots.length)}>
        {data.pilots.length === 0 ? (
          <div className="empty-state">NO PILOTS MATCH.</div>
        ) : (
          <ul className="reports">
            {data.pilots.map((pilot) => {
              const protectedReason = pilot.userId === viewerId ? "YOU" : siteAdmins.includes(pilot.userId) ? "SITE ADMIN" : null;
              return (
                <li key={pilot.userId} className="report">
                  <div className="report__head">
                    <PilotAvatar name={pilot.name} url={pilot.avatarUrl} size={24} />
                    <Link className="link report__preview" href={`/u/${encodeURIComponent(pilot.userId)}`}>
                      {pilot.name}
                    </Link>
                    {pilot.ban && <span className="badge badge--invalid">BANNED</span>}
                    {protectedReason && <span className="badge badge--pending">{protectedReason}</span>}
                  </div>
                  <span className="note">
                    {pilot.userId} · JOINED {formatDate(pilot.joinedAt)} · {pilot.publishedFits} PUBLISHED · {pilot.comments} COMMENTS
                  </span>
                  {pilot.ban && (
                    <p className="report__reason">
                      BANNED {formatDate(pilot.ban.createdAt)} BY {pilot.ban.bannedByName ?? pilot.ban.bannedBy}: {pilot.ban.reason}
                    </p>
                  )}
                  {/* Neither you nor a site admin can be banned; the server refuses it too. */}
                  {(protectedReason === null || pilot.ban) && <BanControls userId={pilot.userId} name={pilot.name} banned={pilot.ban !== null} />}
                </li>
              );
            })}
          </ul>
        )}
        {data.nextCursor && (
          <Link className="btn btn--quiet self-center" href={moreHref(data)}>
            MORE PILOTS
          </Link>
        )}
      </Panel>
    </>
  );
}
