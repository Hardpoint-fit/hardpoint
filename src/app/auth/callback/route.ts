import { handleCallback } from "#/lib/auth-routes";
import { getDatabase } from "#/lib/fits/db";
import { upsertPilotAtSignIn } from "#/lib/fits/pilots";
import { getConfig } from "#/lib/site-config";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleCallback(request, getConfig(), async (pilot) => {
    const database = getDatabase();
    // Without a database there is nothing to record; the site runs read-only.
    if (database.status !== "ready") return;
    await upsertPilotAtSignIn(database.db, { userId: pilot.userId, name: pilot.name, avatarUrl: pilot.picture });
  });
}
