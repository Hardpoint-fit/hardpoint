// The site's whole environment, read in one place. Pure (no server-only import) so node --test can
// load it; the app reads it through site-config.ts, which is server-only.

export type SiteConfig = {
  /** Engine URL browsers call. Absent: the builder says it cannot evaluate. */
  engineUrl: string | null;
  /** Engine URL the server calls (Railway private network). Falls back to the public one. */
  engineInternalUrl: string | null;
  /** Postgres connection string. Absent: fit pages render their "unavailable" state. */
  databaseUrl: string | null;
  /** "Sign in with Citadel": the game's Clerk instance as the OpenID Connect provider. */
  oauthIssuer: string;
  oauthClientId: string | null;
  oauthClientSecret: string | null;
  /** SESSION_SECRET decoded from base64; null when unset or shorter than 32 bytes. */
  sessionSecret: Uint8Array | null;
  /** The canonical origin: sign-in always completes here, and www.<host> redirects to it. */
  siteUrl: string;
  /** True only when the client id, client secret and session secret are all set; writes are refused with 503 otherwise. */
  authEnabled: boolean;
  /** Clerk user ids (OIDC `sub`) allowed to moderate besides the public-metadata `admin` role. */
  adminUserIds: readonly string[];
};

export const DEFAULT_OAUTH_ISSUER = "https://clerk.alpha.thecitadel.com";
export const DEFAULT_SITE_URL = "https://hardpoint.fit";
export const SESSION_SECRET_MIN_BYTES = 32;

/** What the browser may know. Rendered into the page at request time, so one image serves every environment. */
export type PublicConfig = {
  engineUrl: string | null;
  authEnabled: boolean;
};

type Env = Readonly<Record<string, string | undefined>>;

function text(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function url(env: Env, name: string): string | null {
  // Strip trailing slashes so callers append "/path" without doubling them.
  return text(env, name)?.replace(/\/+$/, "") ?? null;
}

/** An http(s) URL reduced to its origin, or null when it isn't one. */
function origin(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function secret(env: Env, name: string): Uint8Array | null {
  const value = text(env, name);
  if (!value || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length >= SESSION_SECRET_MIN_BYTES ? new Uint8Array(bytes) : null;
}

export function parseConfig(env: Env): SiteConfig {
  const engineUrl = url(env, "LOADOUT_ENGINE_URL");
  const oauthClientId = text(env, "CITADEL_OAUTH_CLIENT_ID");
  const oauthClientSecret = text(env, "CITADEL_OAUTH_CLIENT_SECRET");
  const sessionSecret = secret(env, "SESSION_SECRET");
  return {
    engineUrl,
    engineInternalUrl: url(env, "LOADOUT_ENGINE_INTERNAL_URL") ?? engineUrl,
    databaseUrl: text(env, "DATABASE_URL"),
    // The issuer is compared exactly with the ID token's `iss`, so it keeps no trailing slash.
    oauthIssuer: url(env, "CITADEL_OAUTH_ISSUER") ?? DEFAULT_OAUTH_ISSUER,
    oauthClientId,
    oauthClientSecret,
    sessionSecret,
    siteUrl: origin(text(env, "SITE_URL")) ?? DEFAULT_SITE_URL,
    authEnabled: oauthClientId !== null && oauthClientSecret !== null && sessionSecret !== null,
    adminUserIds: (text(env, "SITE_ADMIN_USER_IDS") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

export function toPublicConfig(config: SiteConfig): PublicConfig {
  return {
    engineUrl: config.engineUrl,
    authEnabled: config.authEnabled,
  };
}
