// Typed auth failures and the one place that maps them to a server action result or an HTTP response.
// Pure (no server-only import) so node --test can load it.

export type AuthErrorStatus = 401 | 403 | 503;

export const SIGN_IN_UNAVAILABLE_MESSAGE = "Sign-in isn't configured on this site yet";
export const SIGN_IN_OUTAGE_MESSAGE = "Sign-in is unavailable right now";
export const SIGNED_OUT_MESSAGE = "Sign in to do that.";
export const NOT_ALLOWED_MESSAGE = "You can't do that.";

export type AuthErrorReason = "unauthenticated" | "forbidden" | "auth_unavailable";

const REASONS: Record<AuthErrorStatus, AuthErrorReason> = {
  401: "unauthenticated",
  403: "forbidden",
  503: "auth_unavailable",
};

export class AuthError extends Error {
  readonly status: AuthErrorStatus;
  readonly reason: AuthErrorReason;

  constructor(status: AuthErrorStatus, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.reason = REASONS[status];
  }

  static unauthenticated(): AuthError {
    return new AuthError(401, SIGNED_OUT_MESSAGE);
  }

  static forbidden(): AuthError {
    return new AuthError(403, NOT_ALLOWED_MESSAGE);
  }

  static unavailable(): AuthError {
    return new AuthError(503, SIGN_IN_UNAVAILABLE_MESSAGE);
  }

  /** Sign-in is configured but failed: the session could not be read, or the provider did not answer. */
  static outage(): AuthError {
    return new AuthError(503, SIGN_IN_OUTAGE_MESSAGE);
  }
}

/** What a server action returns when auth refuses it. Shaped like the fit services' refusals. */
export type AuthRefusal = { ok: false; reason: AuthErrorReason; status: AuthErrorStatus; message: string };

export function toAuthRefusal(error: AuthError): AuthRefusal {
  return { ok: false, reason: error.reason, status: error.status, message: error.message };
}

/**
 * Runs `work`; an AuthError becomes a refusal value, anything else propagates.
 * Server actions wrap their body: `return withAuthRefusal(async () => { const author = await requireAuthor(); ... })`.
 */
export async function withAuthRefusal<T>(work: () => Promise<T>): Promise<T | AuthRefusal> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AuthError) return toAuthRefusal(error);
    throw error;
  }
}

/** The HTTP response for an AuthError, or null for any other error so route handlers can rethrow it. */
export function authErrorResponse(error: unknown): Response | null {
  if (!(error instanceof AuthError)) return null;
  return Response.json(
    { error: error.reason, message: error.message },
    { status: error.status, headers: { "Cache-Control": "no-store" } },
  );
}
