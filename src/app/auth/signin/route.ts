import { handleSignIn } from "#/lib/auth-routes";
import { getConfig } from "#/lib/site-config";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleSignIn(request, getConfig());
}
