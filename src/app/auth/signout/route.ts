import { handleSignOut } from "#/lib/auth-routes";
import { getConfig } from "#/lib/site-config";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleSignOut(request, getConfig());
}
