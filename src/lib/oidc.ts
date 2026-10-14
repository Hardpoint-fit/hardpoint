// "Sign in with Citadel": an OpenID Connect authorization-code flow (PKCE S256, state, nonce) against
// the game's production Clerk instance, with the confidential client registered there as "Citadel Fits".
// Pure (no server-only or Next import) so node --test can drive it against a local fake provider.
//
// oauth4webapi does the protocol checks (state, RFC 9207 `iss`, token response, ID token iss, aud,
// exp, iat, nonce, azp); jose verifies the ID token's signature against the provider's JWKS, which
// oauth4webapi leaves out for a token fetched straight from the token endpoint.

import * as oauth from "oauth4webapi";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { displayName, hasAdminRole } from "./auth-core.ts";
import type { Session, SignInTransaction } from "./session.ts";

export const SCOPES = "openid profile public_metadata";
export const CALLBACK_PATH = "/auth/callback";

export type OidcClientConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The canonical origin; the redirect URI is `${siteUrl}/auth/callback`. */
  siteUrl: string;
};

export function redirectUri(siteUrl: string): string {
  return `${siteUrl}${CALLBACK_PATH}`;
}

/** Why a callback was refused. Every case shows the same "try again" page; the kind is only logged. */
export class SignInError extends Error {
  readonly kind: "expired" | "denied" | "invalid" | "outage";
  constructor(kind: SignInError["kind"], message: string) {
    super(message);
    this.name = "SignInError";
    this.kind = kind;
  }
}

/** Plain http is accepted only for a provider on this machine (the tests' fake); Clerk is always https. */
function isLoopback(issuer: URL): boolean {
  return issuer.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(issuer.hostname);
}

function requestOptions(issuer: URL) {
  return isLoopback(issuer) ? { [oauth.allowInsecureRequests]: true } : {};
}

type Provider = { as: oauth.AuthorizationServer; jwks: ReturnType<typeof createRemoteJWKSet> };
const providers = new Map<string, Promise<Provider>>();

/** The provider's metadata, fetched once per process; a failed fetch is forgotten so the next sign-in retries. */
function provider(issuer: string): Promise<Provider> {
  let pending = providers.get(issuer);
  if (!pending) {
    const url = new URL(issuer);
    pending = (async () => {
      const as = await oauth.processDiscoveryResponse(url, await oauth.discoveryRequest(url, { algorithm: "oidc", ...requestOptions(url) }));
      if (!as.jwks_uri) throw new Error("the provider publishes no jwks_uri");
      return { as, jwks: createRemoteJWKSet(new URL(as.jwks_uri)) };
    })();
    pending.catch(() => providers.delete(issuer));
    providers.set(issuer, pending);
  }
  return pending;
}

/** For tests: forget every provider's cached metadata and keys. */
export function forgetProviders(): void {
  providers.clear();
}

/**
 * Where to go after signing in: a path on this site, or "/". Absolute URLs, scheme-relative `//host`,
 * backslashes (browsers read `/\host` as `//host`), control characters and the auth routes themselves
 * are all refused.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const base = "https://return-to.invalid";
    const parsed = new URL(value, base);
    if (parsed.origin !== base) return "/";
    if (parsed.pathname === "/auth" || parsed.pathname.startsWith("/auth/")) return "/";
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    // Normalising can make a scheme-relative path ("/.//evil" -> "//evil"); check the result too.
    return path.startsWith("//") || path.startsWith("/\\") ? "/" : path;
  } catch {
    return "/";
  }
}

/** Starts a sign-in: the provider URL to send the browser to, and the transaction to keep in a cookie. */
export async function beginSignIn(config: OidcClientConfig, returnTo: string): Promise<{ url: URL; transaction: SignInTransaction }> {
  const { as } = await provider(config.issuer);
  if (!as.authorization_endpoint) throw new Error("the provider publishes no authorization_endpoint");
  const transaction: SignInTransaction = {
    state: oauth.generateRandomState(),
    nonce: oauth.generateRandomNonce(),
    codeVerifier: oauth.generateRandomCodeVerifier(),
    returnTo: safeReturnTo(returnTo),
  };
  const url = new URL(as.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri(config.siteUrl),
    scope: SCOPES,
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: await oauth.calculatePKCECodeChallenge(transaction.codeVerifier),
    code_challenge_method: "S256",
  }).toString();
  return { url, transaction };
}

/** A provider that can't be reached or answers 5xx is an outage; a refused or malformed answer (bad code, PKCE mismatch, bad claims) is not. */
function isOutage(error: unknown): boolean {
  if (error instanceof oauth.ResponseBodyError) return error.status >= 500;
  if (error instanceof oauth.OperationProcessingError) return error.cause instanceof Response && error.cause.status >= 500;
  return error instanceof TypeError && error.message === "fetch failed";
}

/**
 * What sign-in learns about the pilot beyond the session. `picture` is Clerk's image URL (the `profile`
 * scope's standard claim) as sent, unchecked; whoever stores it accepts only https (pilots.ts).
 */
export type SignInProfile = { picture: string | null };

/** Clerk user ids look like `user_2abc...`; fits, comments and votes are stored under them. */
const CLERK_USER_ID = /^user_[A-Za-z0-9]+$/;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const optionalText = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Finishes a sign-in from the provider's redirect back to /auth/callback. Returns the session to set,
 * or throws SignInError. `transaction` is what the sign-in cookie held (null when it was missing or
 * expired); it is single-use, and the caller clears the cookie whatever happens.
 */
export async function completeSignIn(
  config: OidcClientConfig,
  callbackUrl: URL,
  transaction: SignInTransaction | null,
  at = Math.floor(Date.now() / 1000),
): Promise<{ session: Session; returnTo: string; profile: SignInProfile }> {
  if (!transaction) throw new SignInError("expired", "no sign-in in progress (cookie missing or expired)");
  let provided: Provider;
  try {
    provided = await provider(config.issuer);
  } catch (error) {
    throw new SignInError("outage", `discovery failed: ${(error as Error).message}`);
  }
  const { as, jwks } = provided;
  const client: oauth.Client = { client_id: config.clientId, id_token_signed_response_alg: "RS256" };
  const options = requestOptions(new URL(config.issuer));

  let params: URLSearchParams;
  try {
    // Checks state and, as Clerk advertises RFC 9207, the `iss` parameter; an `error` response throws too.
    params = oauth.validateAuthResponse(as, client, callbackUrl, transaction.state);
  } catch (error) {
    const denied = error instanceof oauth.AuthorizationResponseError && error.error === "access_denied";
    throw new SignInError(denied ? "denied" : "invalid", `authorization response refused: ${(error as Error).message}`);
  }

  let tokens: oauth.TokenEndpointResponse;
  try {
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.ClientSecretBasic(config.clientSecret),
      params,
      redirectUri(config.siteUrl),
      transaction.codeVerifier,
      options,
    );
    tokens = await oauth.processAuthorizationCodeResponse(as, client, response, { expectedNonce: transaction.nonce, requireIdToken: true });
  } catch (error) {
    throw new SignInError(isOutage(error) ? "outage" : "invalid", `token exchange refused: ${(error as Error).message}`);
  }

  let sub: string;
  let idPicture: string | null;
  try {
    const { payload } = await jwtVerify(tokens.id_token!, jwks, {
      issuer: as.issuer,
      audience: config.clientId,
      algorithms: ["RS256"],
      // As oauth4webapi allows for the same claims.
      clockTolerance: 30,
      requiredClaims: ["sub", "exp", "iat", "nonce"],
    });
    if (payload.nonce !== transaction.nonce) throw new Error("nonce mismatch");
    sub = payload.sub!;
    idPicture = optionalText(payload.picture);
  } catch (error) {
    throw new SignInError("invalid", `ID token refused: ${(error as Error).message}`);
  }
  if (!CLERK_USER_ID.test(sub)) throw new SignInError("invalid", "the ID token's sub is not a Clerk user id");

  let claims: Record<string, unknown>;
  try {
    // Name and metadata come from userinfo, which must describe the same subject as the ID token.
    const response = await oauth.userInfoRequest(as, client, tokens.access_token, options);
    claims = { ...(await oauth.processUserInfoResponse(as, client, sub, response)) };
  } catch (error) {
    throw new SignInError(isOutage(error) ? "outage" : "invalid", `userinfo refused: ${(error as Error).message}`);
  }
  if (claims.user_id !== undefined && claims.user_id !== sub) throw new SignInError("invalid", "userinfo user_id differs from sub");

  return {
    session: {
      userId: sub,
      name: displayName({
        // Clerk returns both; `username` is the deprecated spelling of `preferred_username`.
        username: optionalText(claims.preferred_username) ?? optionalText(claims.username),
        firstName: optionalText(claims.given_name),
        lastName: optionalText(claims.family_name),
      }),
      // The public_metadata scope returns public AND unsafe metadata; only public metadata is
      // writable by Clerk's backend alone, so only it can grant the admin role.
      isAdminRole: hasAdminRole({ publicMetadata: record(claims.public_metadata) }),
      issuedAt: at,
    },
    returnTo: safeReturnTo(transaction.returnTo),
    // Userinfo describes the same subject as the ID token (checked above); either may carry the picture.
    profile: { picture: optionalText(claims.picture) ?? idPicture },
  };
}
