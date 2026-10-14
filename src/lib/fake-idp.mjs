// A local OpenID Connect provider shaped like Clerk's, for the sign-in tests and the smoke run. It
// serves discovery, JWKS, token and userinfo on 127.0.0.1; `authorize()` stands in for the browser's
// visit to the consent page. Knobs on the returned object bend one thing at a time (a wrong issuer,
// an expired token, another signing key) so each check can be shown to refuse.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

export async function startFakeIdp({ clientId = "fits_client", clientSecret = "fake-secret-for-tests", user } = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "fake-1", alg: "RS256", use: "sig" };
  const codes = new Map();
  const accessTokens = new Map();

  const idp = {
    issuer: "",
    clientId,
    clientSecret,
    user: user ?? {
      sub: "user_2fakePilot",
      user_id: "user_2fakePilot",
      preferred_username: "ahab",
      username: "ahab",
      given_name: "Ada",
      family_name: "Lovelace",
      public_metadata: {},
      unsafe_metadata: {},
    },
    /** Claims to override in the next ID tokens (e.g. { iss: "https://evil" }, { exp: 1 }). */
    idTokenClaims: {},
    /** Sign ID tokens with a key the JWKS doesn't publish. */
    signWithOtherKey: false,
    /** Answer every token request with this status (e.g. 503), or null. */
    tokenStatus: null,
    tokenRequests: 0,

    /** What the provider would do once the pilot consents: the redirect back to the client. */
    authorize(authorizationUrl, { deny = false, state } = {}) {
      const url = new URL(authorizationUrl);
      const p = url.searchParams;
      if (p.get("client_id") !== clientId) throw new Error("fake idp: unknown client");
      if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) throw new Error("fake idp: PKCE S256 required");
      const back = new URL(p.get("redirect_uri"));
      back.searchParams.set("state", state ?? p.get("state"));
      back.searchParams.set("iss", idp.issuer);
      if (deny) {
        back.searchParams.set("error", "access_denied");
        return back;
      }
      const code = b64url(randomBytes(16));
      codes.set(code, { nonce: p.get("nonce"), challenge: p.get("code_challenge"), redirectUri: p.get("redirect_uri"), scope: p.get("scope") });
      back.searchParams.set("code", code);
      return back;
    },
  };

  async function idToken(nonce) {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: idp.issuer, aud: clientId, sub: idp.user.sub, iat: now, exp: now + 3600, nonce, given_name: idp.user.given_name, ...idp.idTokenClaims };
    return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "fake-1", typ: "JWT" }).sign(idp.signWithOtherKey ? other.privateKey : privateKey);
  }

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, idp.issuer);
    let body = "";
    for await (const chunk of req) body += chunk;
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/oauth/authorize`,
        token_endpoint: `${idp.issuer}/oauth/token`,
        userinfo_endpoint: `${idp.issuer}/oauth/userinfo`,
        jwks_uri: `${idp.issuer}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === "/.well-known/jwks.json") return json(res, 200, { keys: [jwk] });
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      idp.tokenRequests++;
      if (idp.tokenStatus) return json(res, idp.tokenStatus, { error: "server_error" });
      const basic = (req.headers.authorization ?? "").replace(/^Basic /, "");
      const [id, secret] = Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent);
      if (id !== clientId || secret !== clientSecret) return json(res, 401, { error: "invalid_client" });
      const form = new URLSearchParams(body);
      const grant = codes.get(form.get("code"));
      codes.delete(form.get("code"));
      if (form.get("grant_type") !== "authorization_code" || !grant) return json(res, 400, { error: "invalid_grant" });
      if (form.get("redirect_uri") !== grant.redirectUri) return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri" });
      const verifier = form.get("code_verifier") ?? "";
      if (b64url(createHash("sha256").update(verifier).digest()) !== grant.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE" });
      const accessToken = b64url(randomBytes(24));
      accessTokens.set(accessToken, true);
      return json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, scope: grant.scope, id_token: await idToken(grant.nonce) });
    }
    if (url.pathname === "/oauth/userinfo") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!accessTokens.has(token)) return json(res, 401, { error: "invalid_token" });
      return json(res, 200, { object: "oauth_user_info", ...idp.user });
    }
    json(res, 404, { error: "not_found" });
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  idp.issuer = `http://127.0.0.1:${server.address().port}`;
  idp.close = () => new Promise((done) => server.close(done));
  return idp;
}
