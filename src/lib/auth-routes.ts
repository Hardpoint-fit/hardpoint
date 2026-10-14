// The /auth/* route handlers and the proxy's host and session rules, as plain Request -> Response
// functions over a SiteConfig. Pure (no server-only or Next import) so node --test can call them; the
// route files under src/app/auth/ and src/proxy.ts pass them the run-time config.

import { describeAuthError } from "./auth-core.ts";
import { SIGN_IN_OUTAGE_MESSAGE, SIGN_IN_UNAVAILABLE_MESSAGE } from "./auth-errors.ts";
import type { SiteConfig } from "./config.ts";
import { SignInError, beginSignIn, completeSignIn, safeReturnTo, type OidcClientConfig } from "./oidc.ts";
import {
  SESSION_COOKIE,
  SESSION_LIFETIME_SECONDS,
  SESSION_REFRESH_AFTER_SECONDS,
  sessionCookieLifetime,
  SIGN_IN_COOKIE,
  SIGN_IN_LIFETIME_SECONDS,
  clearCookieHeader,
  cookieHeader,
  openSession,
  openSignIn,
  readCookie,
  sealSession,
  sealSignIn,
} from "./session.ts";

export const SIGN_IN_FAILED_MESSAGE = "Sign-in didn't complete";

function oidcConfig(config: SiteConfig): OidcClientConfig | null {
  if (!config.authEnabled || !config.oauthClientId || !config.oauthClientSecret || !config.sessionSecret) return null;
  return { issuer: config.oauthIssuer, clientId: config.oauthClientId, clientSecret: config.oauthClientSecret, siteUrl: config.siteUrl };
}

/** The host the browser asked for. Railway's edge passes the original Host through. */
export function requestHost(request: Request): string {
  return (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A bare page for the auth routes, which render outside the app layout. */
function page(status: number, title: string, detail: string, action?: { href: string; label: string }, headers: [string, string][] = []): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} | hardpoint.fit</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#d8dde3;font:14px/1.5 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}main{max-width:32rem;padding:24px;border:1px solid #2a3038;clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)}h1{font-size:16px;margin:0 0 8px}p{margin:0 0 16px;color:#8a949e}a{color:#d8dde3;margin-right:16px}a:hover{color:#f0a030}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>${action ? `<a href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>` : ""}<a href="/">Back to hardpoint.fit</a></main></body></html>`;
  const response = new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  for (const [name, value] of headers) response.headers.append(name, value);
  return response;
}

function redirect(location: string, status: 302 | 303 | 307 | 308, cookies: string[] = []): Response {
  const response = new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store" } });
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

const notConfigured = () => page(503, SIGN_IN_UNAVAILABLE_MESSAGE, "Browsing and building work; saving, publishing, commenting and voting need sign-in.");

/** GET /auth/signin?returnTo=/path — sends the browser to Citadel's sign-in, always from the canonical host. */
export async function handleSignIn(request: Request, config: SiteConfig): Promise<Response> {
  const oidc = oidcConfig(config);
  if (!oidc) return notConfigured();
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  // One redirect URI is registered with Clerk; a sign-in begun on www, fits.alpha or the Railway domain restarts on it.
  if (requestHost(request) !== new URL(config.siteUrl).host) {
    return redirect(`${config.siteUrl}/auth/signin?${new URLSearchParams({ returnTo })}`, 307);
  }
  try {
    const { url: authorize, transaction } = await beginSignIn(oidc, returnTo);
    return redirect(authorize.href, 302, [cookieHeader(SIGN_IN_COOKIE, await sealSignIn(config.sessionSecret!, transaction), SIGN_IN_LIFETIME_SECONDS)]);
  } catch (error) {
    console.error("auth sign-in start failed:", describeAuthError(error));
    return page(503, SIGN_IN_OUTAGE_MESSAGE, "Citadel's sign-in didn't answer. Try again in a minute.", { href: `/auth/signin?${new URLSearchParams({ returnTo })}`, label: "Try again" });
  }
}

/** GET /auth/callback — Citadel's sign-in redirects here with a code; on success the session cookie is set. */
export async function handleCallback(request: Request, config: SiteConfig): Promise<Response> {
  const oidc = oidcConfig(config);
  if (!oidc) return notConfigured();
  const secret = config.sessionSecret!;
  const transaction = await openSignIn(secret, readCookie(request.headers.get("cookie"), SIGN_IN_COOKIE));
  // The transaction is single-use: cleared whatever the outcome.
  const clearSignIn = clearCookieHeader(SIGN_IN_COOKIE);
  try {
    const { session, returnTo } = await completeSignIn(oidc, new URL(request.url), transaction);
    return redirect(`${config.siteUrl}${returnTo}`, 303, [clearSignIn, cookieHeader(SESSION_COOKIE, await sealSession(secret, session), SESSION_LIFETIME_SECONDS)]);
  } catch (error) {
    const kind = error instanceof SignInError ? error.kind : "invalid";
    console.error(`auth callback refused (${kind}):`, describeAuthError(error));
    const retry = { href: `/auth/signin?${new URLSearchParams({ returnTo: transaction?.returnTo ?? "/" })}`, label: "Try again" };
    const detail =
      kind === "outage"
        ? "Citadel's sign-in didn't answer. Try again in a minute."
        : kind === "denied"
          ? "Access wasn't granted to hardpoint.fit."
          : "The sign-in expired or couldn't be checked. Start again.";
    return page(kind === "outage" ? 503 : 400, kind === "outage" ? SIGN_IN_OUTAGE_MESSAGE : SIGN_IN_FAILED_MESSAGE, detail, retry, [["Set-Cookie", clearSignIn]]);
  }
}

/** Whether a POST came from this site's own pages: Origin names the request's own host, or Fetch Metadata says same-origin. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") {
    try {
      return new URL(origin).host.toLowerCase() === requestHost(request);
    } catch {
      return false;
    }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/** POST /auth/signout — clears the session. Refused (403) unless it comes from the site's own form. */
export async function handleSignOut(request: Request, config: SiteConfig): Promise<Response> {
  if (!sameOrigin(request)) return page(403, "That sign-out didn't come from this site", "Use the SIGN OUT button in the header.");
  let returnTo = "/";
  try {
    const form = await request.formData();
    returnTo = safeReturnTo(String(form.get("returnTo") ?? "/"));
  } catch {}
  return redirect(`${config.siteUrl}${returnTo}`, 303, [clearCookieHeader(SESSION_COOKIE)]);
}

/** www.<canonical host> -> the canonical origin, same path and query (308 keeps the method). */
export function canonicalRedirect(request: Request, config: SiteConfig): string | null {
  const canonical = new URL(config.siteUrl).host;
  if (requestHost(request) !== `www.${canonical}`) return null;
  const url = new URL(request.url);
  return `${config.siteUrl}${url.pathname}${url.search}`;
}

/**
 * The Set-Cookie the proxy adds for the session, or null when nothing changes. A cookie a day old is
 * re-issued (rolling expiry), keeping its sign-in time, so it never outlives 30 days from sign-in. A
 * cookie that no longer opens (expired, past the 30-day limit, tampered, or from a rotated secret) is cleared.
 */
export async function refreshedSessionCookie(request: Request, config: SiteConfig, at = Math.floor(Date.now() / 1000)): Promise<string | null> {
  if (!config.authEnabled || !config.sessionSecret) return null;
  const value = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!value) return null;
  const opened = await openSession(config.sessionSecret, value, at);
  if (!opened) return clearCookieHeader(SESSION_COOKIE);
  if (at - opened.refreshedAt < SESSION_REFRESH_AFTER_SECONDS) return null;
  const lifetime = sessionCookieLifetime(opened.session.issuedAt, at);
  return cookieHeader(SESSION_COOKIE, await sealSession(config.sessionSecret, opened.session, at), lifetime);
}
