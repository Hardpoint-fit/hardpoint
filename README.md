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

`pnpm build`, `pnpm dev` and `pnpm test` first run `scripts/prepare-design-tokens.mjs`, which reads the design tokens and font from the Unity tree and so needs the whole repo checkout, not only this folder.

`pnpm smoke` seeds the fixture fits (`src/lib/site/seed.mjs`) into a throwaway Postgres, serves the game data API fixtures from `src/lib/engine/stub-engine.mjs`, and starts the standalone server with the API up, with it down, and with no database, fetching every route. The "up" run names a public API address nothing listens on and reaches the stub on the internal one, so it also proves art URLs use the first and the share card's art fetch the second. Add `--serve` (`node --import ./scripts/node-hooks.mjs scripts/smoke.mjs --serve`) to leave the seeded site running for a look. For a database: `docker run --rm -e POSTGRES_PASSWORD=smoke -p 127.0.0.1:55437:5432 postgres:17-alpine`.

## Routes

| Route | What |
| --- | --- |
| `/` | Browse. Filters and sort live in the URL (`hull`, `class`, `role`, `tag`, `current=1`, `sort`, `cursor`). |
| `/fits/[id]` | A fit: the read-only grid, stats with their breakdowns, description, tags, votes, the fit string, comments. `opengraph-image` is its share card. |
| `/u/[userId]` | An author's published fits (and their drafts, to them). |
| `/admin/reports` | Open reports with hide and resolve. A 404 for anyone but a moderator; a moderator whose role has expired gets a RE-VERIFY TO MODERATE link and no data. |
| `/admin/pilots` | Pilots, searched by name or user id: ban state, BAN (a reason, a confirm step, optionally hiding all their fits and comments) and UNBAN. Same access as `/admin/reports`. |

Pages read through `src/lib/site/loaders.ts` and write through the server actions in `src/app/actions.ts` (work in `src/lib/site/actions-core.ts`). With the API down they render the stored verdicts under a banner; without a database they show an unavailable state. The grid is `src/components/grid/` (see its `geometry.ts` and `model.ts`); `scale.ts` owns its cell size, from the game's 48px up to 88px as its panel allows.

## Design tokens and font

The Unity files own these; the site holds no copy of their values. They are visual style, so the site build reads them; everything that is game data comes from the game data API (next section).

- `src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/DesignSystem/tokens/tokens.{color,typography,spacing,sizing,components}.uss`: the sheets `ui-prototype/src/main.tsx` imports. The prepare script strips the Unity-only declarations (`-unity-*`, `resource()`) and writes `src/app/game-tokens.generated.css`, and the colour values the share card draws with (next/og can't read CSS variables, so the card, tier and text colours are resolved) to `src/app/card-tokens.generated.json`.
- `src/Citadel.Unity/ui-prototype/public/fonts/VCROSDNEUE.ttf`: copied to `src/app/fonts/` and loaded with `next/font/local`.
- Not derived here, but read with the catalog from the API: item art (`/v1/art/...`, each entity's `art` URLs), stat wording (`/v1/stats`: labels, whole-number, lower-is-better and inverted-sign rules), where an open fit's progression keeps each affinity point and threshold choice (`/v1/affinity`'s `layout`), and how the game draws its fitting grid (`/v1/ui/fitting-grid`, the game's UI style rather than game data: the 48px cell, slot inset, port notches, hardpoint icons and state colours). An older API without the grid style or the affinity layout leaves those parts of the site showing a note instead of the grid or the affinity points.

All outputs are git-ignored. Change the Unity files, never the outputs. `globals.css` binds `--font-family` to the loaded font; `game-ui.css` holds the game-UI primitives (chamfered panel, tooltip plate, buttons, tier accents).

## The game data API and item art

The site is a client of the public API (`tools/game-data-api`, contract in its `openapi/openapi.json`, served at `https://api.thecitadel.com`). `src/lib/engine/` holds the client:

- `catalog-resources.ts` is the one module that knows which resource routes make up the catalog (`/v1/items`, `/v1/hulls`, `/v1/ciphers`, `/v1/artifacts`, `/v1/regalia-sets`, `/v1/affinity`, `/v1/regalia`, `/v1/heretical-specials`, `/v1/harmonic-sets`, `/v1/modifier-pools`, `/v1/qualities`, `/v1/placement-rules`, `/v1/grid-consumables`, `/v1/breach-tiers`) and assembles their bodies into the `Catalog` the builder and pages read.
- `client.ts` fetches them together, each with its own `If-None-Match`, so a revalidation is fourteen 304s; parts of two builds (a deploy landed between the requests) are fetched again once. It also calls `/v1/status`, `/v1/fits/evaluate`, `/v1/fits/import`, `/v1/fits/export`, `/v1/items/facts`, `/v1/grid-mods` and `/v1/roll`, reads the `{ error: { code, message } }` envelope (any 4xx is `rejected` with its message), and keeps a 429 (`rateLimited`, with `Retry-After`) and an unreachable API (`unavailable`: no answer, or a proxy's 502/503/504) apart from an API that answered with another 5xx (`failed`).
- Art: the API gives each item, hull, cipher, artifact and grid consumable an `art` object of `/v1/art/...` URLs (128px WebP; `@2x` before `.webp` is the 256px twin). The client makes them absolute with the **public** URL (`GAME_DATA_API_URL`), so the browser loads them straight from the API; nothing in the site names a host. `src/lib/art/item-icon.ts` applies the game's icon-choice rule over those URLs (identified artifact icon, else the rarity variant, else the base, else a placeholder). The share card is rendered on the server, which fetches its art from `GAME_DATA_API_INTERNAL_URL` instead.
- The tests run on responses recorded from the live API: `node scripts/record-fixtures.mjs <API URL>` rewrites `src/lib/engine/__fixtures__` (cut down to the items the tests use; the fits in it are the inputs), and `scripts/record-placement-oracle.mjs <local API URL>` the placement verdicts. `types.test.mjs` checks every fixture against `types.ts`.

## Environment

All optional, read at run time by `src/lib/config.ts` (through the server-only `src/lib/site-config.ts`). Without them the site renders read-only with "not configured" states.

| Variable | Use |
| --- | --- |
| `GAME_DATA_API_URL` | The game data API's public URL (`https://api.thecitadel.com`). Browsers call it for evaluate, import, export, item facts, grid mods and rolls, and load item art from it: the catalog's `/v1/art/...` URLs are made absolute with it. Also the server's fallback. |
| `GAME_DATA_API_INTERNAL_URL` | The API's URL for the server (Railway private network). Server reads, the cron, and the share card's art fetches use it. |
| `DATABASE_URL` | Fits database (Postgres). `node src/lib/fits/migrate.mjs` applies `src/lib/fits/schema.sql` and runs before the server in the container. |
| `CITADEL_OAUTH_CLIENT_ID`, `CITADEL_OAUTH_CLIENT_SECRET`, `SESSION_SECRET` | "Sign in with Citadel". `authEnabled` is true only when all three are set. `SESSION_SECRET` is base64 of at least 32 random bytes (`openssl rand -base64 48`); it keys the session cookies, so changing it signs everyone out. |
| `CITADEL_OAUTH_ISSUER` | The OpenID provider. Default `https://clerk.alpha.thecitadel.com`, the game's production Clerk instance. |
| `SITE_URL` | The canonical origin. Default `https://hardpoint.fit`. Sign-in completes at `SITE_URL/auth/callback`, and `www.<its host>` 308-redirects to it. Locally: `http://localhost:3000`. |
| `SITE_ADMIN_USER_IDS` | Comma-separated Clerk user ids that may moderate, besides the Clerk `admin` role in public metadata. |
| `PORT` | Listen port (default 3000). |

The browser learns its config from the server: the root layout reads the environment per request and passes the public part (`apiUrl`, `authEnabled`) to `PublicConfigProvider`; client code calls `usePublicConfig()`. Nothing is inlined at build time, so one image serves every environment.

## Sign in with Citadel

The game's production Clerk instance is the OpenID Connect provider and the site is a confidential client of its OAuth app "Citadel Fits"; there is no Clerk SDK. `oauth4webapi` runs the protocol checks and `jose` verifies the ID token's signature against the provider's JWKS and seals the cookies.

- `GET /auth/signin?returnTo=/path` (`src/lib/auth-routes.ts`, `src/lib/oidc.ts`) moves to `SITE_URL` if the request came to another host, then redirects to Clerk with PKCE (S256), `state` and `nonce`, which it keeps in a 10-minute encrypted cookie, `__Host-citadel-signin`. `returnTo` must be a path on this site (`safeReturnTo`); anything else becomes `/`.
- `GET /auth/callback` checks `state` and the `iss` parameter, redeems the code with the client secret and PKCE verifier, verifies the ID token (signature, `iss`, `aud`, `exp`, `nonce`) and reads userinfo for the same `sub`. The session is the `sub` (a Clerk user id, `user_...`, as stored in `author_user_id`), the display name (username, else first and last name, else `PILOT`) and whether public metadata has `role: "admin"`. Unsafe metadata, which the pilot can write, is never read.
- The session is `__Host-citadel-session`: a JWE (`dir`, A256GCM, key derived from `SESSION_SECRET` with HKDF), HttpOnly, Secure, SameSite=Lax, host-only on `SITE_URL`'s host, re-issued by the proxy once it is a day old but never valid past 30 days from sign-in, after which it is cleared. Name and role are read at sign-in only; a change in Clerk shows at the next sign-in, and the admin role counts only within 24 hours of sign-in (`SITE_ADMIN_USER_IDS` is unaffected). The cookie keeps the role read at sign-in (`adm`) for its whole life, so past the 24 hours a moderator sees RE-VERIFY TO MODERATE in place of the moderation controls: `/auth/signin?returnTo=<page>&reverify=1` (`reverify.ts`) signs them in again, which reads the role fresh, and returns them to the page. No server-side store.
- `POST /auth/signout` clears it, and is refused unless `Origin` (or `Sec-Fetch-Site: same-origin`) shows it came from the site.
- `src/lib/auth.ts` reads the session for `currentAuthor`, `requireAuthor`, `isAdmin`, `requireAdmin` and `moderationState` ("active", "reverify" or "none"; rules in `auth-core.ts`): reads never throw; writes refuse 401 signed out and 503 when sign-in isn't configured.
- A banned pilot (`pilot_bans`, `src/lib/fits/bans.ts`) is refused on every write with "Your account is suspended from posting.": actions-core checks it on the one path every write takes. Reads stay open, and site admins can't be banned.

Tests run the whole flow against a local fake provider (`src/lib/fake-idp.mjs`), and `pnpm smoke` signs in through it on the built server.

## Re-evaluation job

When the game data API ships a new build, every published fit needs a fresh verdict. `src/jobs/reevaluate.ts` does that: it reads the build from the API's `/v1/status`, evaluates published (not hidden) fits that have no verdict for it in batches of 50 with at most 4 requests in flight, and stores each one through the same revision guard the site uses, so a fit edited meanwhile keeps its newer content. It is idempotent, logs counts only (never fit contents), waits out an API 429 (`Retry-After`, at most 5 waits), stops quietly if the API is down or erroring (exit 0; the next run continues), stops after 10 minutes, and exits 1 only when the database fails or `DATABASE_URL` / `GAME_DATA_API_INTERNAL_URL` is missing.

It runs from the site's own image, with no build step: Node strips the types, and the image carries the job's few files next to the standalone `node_modules` (`pg`). On Railway add a second service from the same repo and Dockerfile, with:

- Start command: `node src/jobs/reevaluate.ts`
- Cron schedule: `*/15 * * * *`
- Variables: `DATABASE_URL` (same database) and `GAME_DATA_API_INTERNAL_URL` (the API's private-network URL, so it uses the private bucket).

It also asks again for a valid verdict stored before the API sent `sections` or `modifierGroups` (the stored stats lack the key), so a field the API adds reaches every fit page within a few runs. Until then the page shows what it has: a missing `sections` reads "STATS APPEAR AFTER THE NEXT CHECK.", and a missing `modifierGroups` lists MODIFIERS from `stats`, one line per stat and stage, as the site did before. A verdict the job stores from an API that doesn't send `modifierGroups` keeps the key as null, so the job doesn't ask that API again in a loop; such a fit keeps the per-stage list until the next build, so deploy the API before the site. An outdated fit's last valid verdict is never asked again, so it keeps the per-stage list.

Locally: `DATABASE_URL=... GAME_DATA_API_INTERNAL_URL=http://localhost:8080 node src/jobs/reevaluate.ts`. Keep the job's imports to erasable TypeScript with explicit `.ts` paths and nothing from Next.

## Docker

The build context is the **repo root**, because the build reads the Unity tokens, font and the few other files listed above (about 100 KB beside the app; no item art):

```
docker build -f js/projects/theorycrafting/Dockerfile -t citadel-theorycrafting .
docker run --rm -p 3000:3000 citadel-theorycrafting
```

`Dockerfile.dockerignore` (picked up by BuildKit) limits the context to this app and those Unity files, so no repo-root `.dockerignore` is needed. The image runs `node server.js` from Next's standalone output as a non-root user and honours `PORT`. `GET /healthz` is the liveness check; it touches no dependency.

`pnpm start` runs `next start`, which Next warns about under `output: "standalone"`; production uses the container.
