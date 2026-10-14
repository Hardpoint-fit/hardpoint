import { NextResponse, type NextRequest } from "next/server";
import { canonicalRedirect, refreshedSessionCookie } from "#/lib/auth-routes";
import { parseConfig } from "#/lib/config";

/** Whether every %-escape in a path decodes. Next's router throws (a 500) on one that doesn't. */
export function pathDecodes(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return true;
  } catch {
    return false;
  }
}

// The config is read per request from the run-time environment, so one image serves every environment.
// Reads stay public: this proxy never sends anyone to sign in.
export default async function proxy(request: NextRequest) {
  const config = parseConfig(process.env);
  // www.hardpoint.fit is an alias: one canonical host keeps one session cookie and one OAuth redirect URI.
  const canonical = canonicalRedirect(request, config);
  if (canonical) return NextResponse.redirect(canonical, 308);
  if (STATIC.test(request.nextUrl.pathname)) return NextResponse.next();
  // No page has a name that doesn't decode: show the not-found page rather than let routing fail.
  if (!pathDecodes(request.nextUrl.pathname)) return NextResponse.rewrite(new URL("/not-found", request.url), { status: 404 });
  const response = NextResponse.next();
  const refreshed = await refreshedSessionCookie(request, config);
  if (refreshed) response.headers.append("Set-Cookie", refreshed);
  return response;
}

// Every path runs the proxy, so www redirects everywhere; Next internals and static files skip the rest.
const STATIC = /^\/_next\/|\.(?:html?|css|js|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|webmanifest)$/;

export const config = { matcher: "/:path*" };
