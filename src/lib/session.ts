// The site's own sign-in state, kept in encrypted cookies (no server-side store). Pure (no server-only
// or Next import) so node --test can load it; auth.ts, the auth routes and the proxy use it.
//
// Both cookies are JWEs (`dir` + A256GCM: AES-GCM authenticates as well as encrypts, so a cookie can't
// be read or altered without SESSION_SECRET). Each purpose has its own key, derived from SESSION_SECRET
// with HKDF, so a sign-in transaction can never be replayed as a session or the reverse. Rotating
// SESSION_SECRET signs everyone out.

import { EncryptJWT, jwtDecrypt } from "jose";

/** `__Host-`: Secure, Path=/ and no Domain, so the cookie belongs to the canonical host alone. */
export const SESSION_COOKIE = "__Host-citadel-session";
export const SIGN_IN_COOKIE = "__Host-citadel-signin";

export const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
/** Absolute limit from sign-in: past it the session is over, however recently the cookie was renewed. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** The admin role read at sign-in is trusted this long; after it, moderation needs a fresh sign-in. */
export const ADMIN_ROLE_MAX_AGE_SECONDS = 24 * 60 * 60;
/** A cookie older than this is re-issued on the next request (rolling expiry, never past SESSION_MAX_AGE_SECONDS from sign-in). */
export const SESSION_REFRESH_AFTER_SECONDS = 24 * 60 * 60;
export const SIGN_IN_LIFETIME_SECONDS = 10 * 60;

/** What the site knows about a signed-in pilot. Name and admin role are read from Clerk at sign-in only. */
export type Session = {
  /** The OIDC `sub`: the Clerk user id (`user_...`), the id fits, comments and votes are stored under. */
  userId: string;
  name: string;
  /**
   * Clerk public metadata `role === "admin"` when the pilot signed in (the `adm` claim). Kept unchanged across
   * refreshes for the session's whole life; whether the role still counts is `adminRole`, derived from it and the
   * sign-in's age, never sealed.
   */
  wasAdminAtSignIn: boolean;
  /** When the pilot signed in (seconds since the epoch). Kept across refreshes. */
  issuedAt: number;
};

/**
 * The admin role a session carries now. "active": signed in with the role less than ADMIN_ROLE_MAX_AGE_SECONDS
 * ago, so it may moderate. "expired": signed in with the role longer ago than that; a fresh sign-in (re-verify)
 * reads the role again. "none": signed in without it.
 */
export type AdminRole = "active" | "expired" | "none";

export function adminRoleOf(session: Pick<Session, "wasAdminAtSignIn" | "issuedAt">, at = now()): AdminRole {
  if (!session.wasAdminAtSignIn) return "none";
  return at - session.issuedAt < ADMIN_ROLE_MAX_AGE_SECONDS ? "active" : "expired";
}

/** One sign-in in flight: what the callback must see again, and where to go afterwards. */
export type SignInTransaction = { state: string; nonce: string; codeVerifier: string; returnTo: string };

type Purpose = "session" | "signin";
const keys = new Map<string, Promise<Uint8Array>>();

async function deriveKey(secret: Uint8Array, purpose: Purpose): Promise<Uint8Array> {
  const cacheKey = `${purpose}:${Buffer.from(secret).toString("base64")}`;
  let key = keys.get(cacheKey);
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(`citadel-fits ${purpose} v1`) },
        material,
        256,
      );
      return new Uint8Array(bits);
    })();
    keys.set(cacheKey, key);
  }
  return key;
}

const now = () => Math.floor(Date.now() / 1000);

async function seal(secret: Uint8Array, purpose: Purpose, claims: Record<string, unknown>, lifetime: number, at = now()): Promise<string> {
  return new EncryptJWT(claims)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: purpose })
    .setIssuedAt(at)
    .setExpirationTime(at + lifetime)
    .encrypt(await deriveKey(secret, purpose));
}

/** The payload, or null for anything missing, tampered with, expired or sealed for another purpose. */
async function unseal(secret: Uint8Array, purpose: Purpose, value: string | undefined | null): Promise<Record<string, unknown> | null> {
  if (!value) return null;
  try {
    const { payload, protectedHeader } = await jwtDecrypt(value, await deriveKey(secret, purpose), {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
      typ: purpose,
    });
    return protectedHeader.typ === purpose ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Seconds a session cookie issued at `at` may live: 30 days, cut short at 30 days from sign-in. */
export function sessionCookieLifetime(issuedAt: number, at = now()): number {
  return Math.max(0, Math.min(SESSION_LIFETIME_SECONDS, issuedAt + SESSION_MAX_AGE_SECONDS - at));
}

export async function sealSession(secret: Uint8Array, session: Session, at = now()): Promise<string> {
  return seal(
    secret,
    "session",
    // `adm` is the role read at sign-in, never the derived "admin now": a refresh re-seals it unchanged.
    { sub: session.userId, name: session.name, adm: session.wasAdminAtSignIn, sia: session.issuedAt },
    sessionCookieLifetime(session.issuedAt, at),
    at,
  );
}

export type OpenedSession = {
  session: Session;
  /** When this cookie was (re)issued. */
  refreshedAt: number;
  /** The admin role as of `at`: it counts only within a day of sign-in. */
  adminRole: AdminRole;
};

/** The session in a cookie, or null when it is missing, invalid, or its sign-in is 30 days old or more. */
export async function openSession(secret: Uint8Array, value: string | undefined | null, at = now()): Promise<OpenedSession | null> {
  const payload = await unseal(secret, "session", value);
  if (!payload) return null;
  const { sub, name, adm, sia, iat } = payload;
  if (typeof sub !== "string" || !sub || typeof name !== "string" || typeof adm !== "boolean" || typeof sia !== "number" || typeof iat !== "number") return null;
  const age = at - sia;
  if (age >= SESSION_MAX_AGE_SECONDS || age < -60) return null;
  const session: Session = { userId: sub, name, wasAdminAtSignIn: adm, issuedAt: sia };
  return { session, refreshedAt: iat, adminRole: adminRoleOf(session, at) };
}

export async function sealSignIn(secret: Uint8Array, transaction: SignInTransaction): Promise<string> {
  return seal(secret, "signin", { ...transaction }, SIGN_IN_LIFETIME_SECONDS);
}

export async function openSignIn(secret: Uint8Array, value: string | undefined | null): Promise<SignInTransaction | null> {
  const payload = await unseal(secret, "signin", value);
  if (!payload) return null;
  const { state, nonce, codeVerifier, returnTo } = payload;
  if (typeof state !== "string" || typeof nonce !== "string" || typeof codeVerifier !== "string" || typeof returnTo !== "string") return null;
  return { state, nonce, codeVerifier, returnTo };
}

/** A Set-Cookie value with the attributes every site cookie carries: HttpOnly, Secure, SameSite=Lax, Path=/, host-only. */
export function cookieHeader(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookieHeader(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

/** One cookie's value from a Cookie request header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}
