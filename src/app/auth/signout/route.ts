import { handleSignOut } from "#/lib/auth-routes";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleSignOut(request);
}
