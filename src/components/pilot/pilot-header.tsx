// The header of a pilot's page: avatar, name, bio, what they published and who follows them, and the
// FOLLOW / EDIT BIO controls. A plain render of loadAuthor's profile, so view tests can render it.
import Link from "next/link";
import type { PilotProfile } from "#/lib/fits/pilots";
import type { PageViewer } from "#/lib/site/server";
import { Panel, count } from "#/components/ui";
import { PilotAvatar } from "./pilot-avatar";
import { EditBio, FollowButton } from "./pilot-controls";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="pilot-stat">
      <dt>{label}</dt>
      <dd className="rating">{value}</dd>
    </div>
  );
}

export function PilotHeader({ pilot, viewer }: { pilot: PilotProfile; viewer: PageViewer }) {
  const own = viewer.userId === pilot.userId;
  const signedIn = viewer.authEnabled && viewer.userId !== null;
  return (
    <Panel title="PILOT" aside={own ? "YOU" : undefined}>
      <div className="pilot-head">
        <PilotAvatar name={pilot.name} url={pilot.avatarUrl} size={72} />
        <div className="pilot-head__text">
          <h1 className="pilot-head__name">{pilot.name}</h1>
          {pilot.bio ? <p className="pilot-head__bio">{pilot.bio}</p> : own ? <p className="note">NO BIO YET.</p> : null}
        </div>
        <div className="pilot-head__actions">
          {signedIn && !own && <FollowButton userId={pilot.userId} following={pilot.viewerFollows} />}
          {viewer.authEnabled && viewer.userId === null && <span className="note">SIGN IN TO FOLLOW</span>}
          {signedIn && own && <EditBio bio={pilot.bio} />}
        </div>
      </div>
      <dl className="pilot-stats">
        <Stat label="PUBLISHED FITS" value={pilot.publishedFits} />
        <Stat label="UPVOTES RECEIVED" value={pilot.upvotesReceived} />
        <Stat label="FOLLOWERS" value={pilot.followers} />
        <Stat label="FOLLOWING" value={pilot.following} />
      </dl>
      {pilot.topFit && (
        <div className="note">
          TOP FIT{" "}
          <Link className="link" href={`/fits/${pilot.topFit.id}`}>
            {pilot.topFit.title}
          </Link>{" "}
          · <span className="rating">{count(pilot.topFit.votes, "UPVOTE")}</span>
        </div>
      )}
    </Panel>
  );
}
