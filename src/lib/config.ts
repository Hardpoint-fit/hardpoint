// The site's whole environment, read in one place. Pure (no server-only import) so node --test can
// load it; the app reads it through site-config.ts, which is server-only.

export type SiteConfig = {
  /** Engine URL browsers call. Absent: the builder says it cannot evaluate. */
  engineUrl: string | null;
  /** Engine URL the server calls (Railway private network). Falls back to the public one. */
  engineInternalUrl: string | null;
  /** Postgres connection string. Absent: fit pages render their "unavailable" state. */
  databaseUrl: string | null;
  clerkPublishableKey: string | null;
  clerkSecretKey: string | null;
  /** True only when both Clerk keys are set; writes are refused with 503 otherwise. */
  authEnabled: boolean;
  /** Clerk user ids allowed to moderate besides the Clerk `admin` role. */
  adminUserIds: readonly string[];
};

/** What the browser may know. Rendered into the page at request time, so one image serves every environment. */
export type PublicConfig = {
  engineUrl: string | null;
  clerkPublishableKey: string | null;
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

export function parseConfig(env: Env): SiteConfig {
  const engineUrl = url(env, "LOADOUT_ENGINE_URL");
  const clerkPublishableKey = text(env, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  const clerkSecretKey = text(env, "CLERK_SECRET_KEY");
  return {
    engineUrl,
    engineInternalUrl: url(env, "LOADOUT_ENGINE_INTERNAL_URL") ?? engineUrl,
    databaseUrl: text(env, "DATABASE_URL"),
    clerkPublishableKey,
    clerkSecretKey,
    authEnabled: clerkPublishableKey !== null && clerkSecretKey !== null,
    adminUserIds: (text(env, "SITE_ADMIN_USER_IDS") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

export function toPublicConfig(config: SiteConfig): PublicConfig {
  return {
    engineUrl: config.engineUrl,
    clerkPublishableKey: config.clerkPublishableKey,
    authEnabled: config.authEnabled,
  };
}
