# Citadel theorycrafting site

A standalone Next.js 16 app (App Router, Tailwind 3, TypeScript) where players build, publish and compare ship fits. It is independent of `client-site` and has its own `pnpm-workspace.yaml` and lockfile. Design: `docs/superpowers/specs/2026-10-13-theorycrafting-design.md`.

## Commands

```
pnpm install
pnpm dev        # http://localhost:3000
pnpm test       # node --test, with scripts/node-hooks.mjs so tests load .tsx, JSON and the #/ alias
pnpm build      # needs no environment
pnpm typecheck
SMOKE_DATABASE_URL=postgres://... pnpm smoke   # after pnpm build; truncates that database
```

`pnpm build`, `pnpm dev` and `pnpm test` first run `scripts/prepare-game-assets.mjs`, which reads files from the Unity tree and so needs the whole repo checkout, not only this folder.

`pnpm smoke` seeds the fixture fits (`src/lib/site/seed.mjs`) into a throwaway Postgres, serves the engine fixtures from `src/lib/engine/stub-engine.mjs`, and starts the standalone server with the engine up, with it down, and with no database, fetching every route. Add `--serve` (`node --import ./scripts/node-hooks.mjs scripts/smoke.mjs --serve`) to leave the seeded site running for a look. For a database: `docker run --rm -e POSTGRES_PASSWORD=smoke -p 127.0.0.1:55437:5432 postgres:17-alpine`.

## Routes

| Route | What |
| --- | --- |
| `/` | Browse. Filters and sort live in the URL (`hull`, `class`, `role`, `tag`, `current=1`, `sort`, `cursor`). |
| `/fits/[id]` | A fit: the read-only grid, stats with their breakdowns, description, tags, votes, the fit string, comments. `opengraph-image` is its share card. |
| `/u/[userId]` | An author's published fits (and their drafts, to them). |
| `/admin/reports` | Open reports with hide and resolve. A 404 for anyone but a moderator. |

Pages read through `src/lib/site/loaders.ts` and write through the server actions in `src/app/actions.ts` (work in `src/lib/site/actions-core.ts`). With the engine down they render the stored verdicts under a banner; without a database they show an unavailable state. The grid is `src/components/grid/` (see its `geometry.ts` and `model.ts`).

## Game tokens, font, grid art and stat wording

The Unity files own all of these; the site holds no copy of their values.

- `src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/DesignSystem/tokens/tokens.{color,typography,spacing,sizing,components}.uss`: the sheets `ui-prototype/src/main.tsx` imports. The prepare script strips the Unity-only declarations (`-unity-*`, `resource()`) and writes `src/app/game-tokens.generated.css`.
- `src/Citadel.Unity/ui-prototype/public/fonts/VCROSDNEUE.ttf`: copied to `src/app/fonts/` and loaded with `next/font/local`.
- `FittingPanel.fixture.json`, `InventoryGrid.fixture.json` (exported by Unity for the UI prototype), the `hardpoint-*.svg` icons and the tier tokens: written to `src/components/grid/fitting-art.generated.json` (port notch rectangles at the game's 48px cell, hardpoint glyphs, grid state colours, tier values for the share card).
- `StatTypeText.cs`, `StatTypeRules.cs`, `Modules.qtn`: written to `src/lib/fits/stat-text.generated.json` (each stat's label, whole-number, lower-is-better and inverted-sign rules). A stat without copy fails the build.
- `Modules.qtn` (`ModuleType`), `Effects.qtn` (the affinity bounds) and `AffinityThresholdResolver.cs` (`SelectionUnset`): written to `src/lib/engine/progression-layout.generated.json`, where an open fit's affinity progression keeps each point and threshold choice. The builder edits progressions through it.
- Item prefabs, `ArtifactItemDefinition` and recipe assets, `EntityOverlayHudConfig.asset`, `Items.qtn` and the icon PNGs (Git LFS, so `git lfs pull` first; a pointer file fails the build): read by `tools/ship-restore/lib/game-assets.js` (shared with the killboard) and written by `scripts/game-art.mjs` to `public/art/<guid>.<hash>.webp` (128px) and `<guid>.<hash>@2x.webp` (256px), with `src/lib/art/art-manifest.generated.json` mapping each item to its base and rarity images. `<hash>` is of the images' bytes, so `/art` is served `immutable` for a year. The site finds art by the engine catalog's `path` (items, hulls, ciphers with `findModuleArt`, artifacts with `findArtifactArt`): keys are the `iconKeys` normalization (lower-case, a-z0-9 only, `EntityPrototype` and ` Hull` stripped), documented in `src/lib/art/art-key.ts`. Unchanged images are skipped on later runs (`.cache/game-art.json`).

All outputs are git-ignored. Change the Unity files, never the outputs. `globals.css` binds `--font-family` to the loaded font; `game-ui.css` holds the game-UI primitives (chamfered panel, tooltip plate, buttons, tier accents).

## Environment

All optional, read at run time by `src/lib/config.ts` (through the server-only `src/lib/site-config.ts`). Without them the site renders read-only with "not configured" states.

| Variable | Use |
| --- | --- |
| `LOADOUT_ENGINE_URL` | Public engine URL. Browsers call it; also the server's fallback. |
| `LOADOUT_ENGINE_INTERNAL_URL` | Engine URL for the server (Railway private network). |
| `DATABASE_URL` | Fits database (Postgres). `node src/lib/fits/migrate.mjs` applies `src/lib/fits/schema.sql` and runs before the server in the container. |
| `CITADEL_OAUTH_CLIENT_ID`, `CITADEL_OAUTH_CLIENT_SECRET`, `SESSION_SECRET` | "Sign in with Citadel". `authEnabled` is true only when all three are set. `SESSION_SECRET` is base64 of at least 32 random bytes (`openssl rand -base64 48`); it keys the session cookies, so changing it signs everyone out. |
| `CITADEL_OAUTH_ISSUER` | The OpenID provider. Default `https://clerk.alpha.thecitadel.com`, the game's production Clerk instance. |
| `SITE_URL` | The canonical origin. Default `https://hardpoint.fit`. Sign-in completes at `SITE_URL/auth/callback`, and `www.<its host>` 308-redirects to it. Locally: `http://localhost:3000`. |
| `SITE_ADMIN_USER_IDS` | Comma-separated Clerk user ids that may moderate, besides the Clerk `admin` role in public metadata. |
| `PORT` | Listen port (default 3000). |

The browser learns its config from the server: the root layout reads the environment per request and passes the public part (`engineUrl`, `authEnabled`) to `PublicConfigProvider`; client code calls `usePublicConfig()`. Nothing is inlined at build time, so one image serves every environment.

## Sign in with Citadel

The game's production Clerk instance is the OpenID Connect provider and the site is a confidential client of its OAuth app "Citadel Fits"; there is no Clerk SDK. `oauth4webapi` runs the protocol checks and `jose` verifies the ID token's signature against the provider's JWKS and seals the cookies.

- `GET /auth/signin?returnTo=/path` (`src/lib/auth-routes.ts`, `src/lib/oidc.ts`) moves to `SITE_URL` if the request came to another host, then redirects to Clerk with PKCE (S256), `state` and `nonce`, which it keeps in a 10-minute encrypted cookie, `__Host-citadel-signin`. `returnTo` must be a path on this site (`safeReturnTo`); anything else becomes `/`.
- `GET /auth/callback` checks `state` and the `iss` parameter, redeems the code with the client secret and PKCE verifier, verifies the ID token (signature, `iss`, `aud`, `exp`, `nonce`) and reads userinfo for the same `sub`. The session is the `sub` (a Clerk user id, `user_...`, as stored in `author_user_id`), the display name (username, else first and last name, else `PILOT`) and whether public metadata has `role: "admin"`. Unsafe metadata, which the pilot can write, is never read.
- The session is `__Host-citadel-session`: a JWE (`dir`, A256GCM, key derived from `SESSION_SECRET` with HKDF), HttpOnly, Secure, SameSite=Lax, host-only on `SITE_URL`'s host, 30 days, re-issued by the proxy once it is a day old. Name and role are read at sign-in only; a change in Clerk shows at the next sign-in. No server-side store.
- `POST /auth/signout` clears it, and is refused unless `Origin` (or `Sec-Fetch-Site: same-origin`) shows it came from the site.
- `src/lib/auth.ts` reads the session for `currentAuthor`, `requireAuthor`, `isAdmin` and `requireAdmin` (rules in `auth-core.ts`): reads never throw; writes refuse 401 signed out and 503 when sign-in isn't configured.

Tests run the whole flow against a local fake provider (`src/lib/fake-idp.mjs`), and `pnpm smoke` signs in through it on the built server.

## Re-evaluation job

When the engine ships a new build, every published fit needs a fresh verdict. `src/jobs/reevaluate.ts` does that: it reads the build from the engine's `/healthz`, evaluates published (not hidden) fits that have no verdict for it in batches of 50 with at most 4 requests in flight, and stores each one through the same revision guard the site uses, so a fit edited meanwhile keeps its newer content. It is idempotent, logs counts only (never fit contents), waits out an engine 429 (`Retry-After`, at most 5 waits), stops quietly if the engine is down or erroring (exit 0; the next run continues), stops after 10 minutes, and exits 1 only when the database fails or `DATABASE_URL` / `LOADOUT_ENGINE_INTERNAL_URL` is missing.

It runs from the site's own image, with no build step: Node strips the types, and the image carries the job's few files next to the standalone `node_modules` (`pg`). On Railway add a second service from the same repo and Dockerfile, with:

- Start command: `node src/jobs/reevaluate.ts`
- Cron schedule: `*/15 * * * *`
- Variables: `DATABASE_URL` (same database) and `LOADOUT_ENGINE_INTERNAL_URL` (the engine's private-network URL, so it uses the private bucket).

Locally: `DATABASE_URL=... LOADOUT_ENGINE_INTERNAL_URL=http://localhost:8080 node src/jobs/reevaluate.ts`. Keep the job's imports to erasable TypeScript with explicit `.ts` paths and nothing from Next.

## Docker

The build context is the **repo root**, because the build reads the Unity tokens and font:

```
docker build -f js/projects/theorycrafting/Dockerfile -t citadel-theorycrafting .
docker run --rm -p 3000:3000 citadel-theorycrafting
```

`Dockerfile.dockerignore` (picked up by BuildKit) limits the context to this app and those Unity files, so no repo-root `.dockerignore` is needed. The image runs `node server.js` from Next's standalone output as a non-root user and honours `PORT`. `GET /healthz` is the liveness check; it touches no dependency.

`pnpm start` runs `next start`, which Next warns about under `output: "standalone"`; production uses the container.
