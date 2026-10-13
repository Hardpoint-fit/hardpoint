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

All outputs are git-ignored. Change the Unity files, never the outputs. `globals.css` binds `--font-family` to the loaded font; `game-ui.css` holds the game-UI primitives (chamfered panel, tooltip plate, buttons, tier accents).

## Environment

All optional, read at run time by `src/lib/config.ts` (through the server-only `src/lib/site-config.ts`). Without them the site renders read-only with "not configured" states.

| Variable | Use |
| --- | --- |
| `LOADOUT_ENGINE_URL` | Public engine URL. Browsers call it; also the server's fallback. |
| `LOADOUT_ENGINE_INTERNAL_URL` | Engine URL for the server (Railway private network). |
| `DATABASE_URL` | Fits database (Postgres). `node src/lib/fits/migrate.mjs` applies `src/lib/fits/schema.sql` and runs before the server in the container. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Sign-in. `authEnabled` is true only when both are set. |
| `SITE_ADMIN_USER_IDS` | Comma-separated Clerk user ids that may moderate, besides the Clerk `admin` role. |
| `PORT` | Listen port (default 3000). |

The browser learns its config from the server: the root layout reads the environment per request and passes the public part (`engineUrl`, `clerkPublishableKey`, `authEnabled`) to `PublicConfigProvider`; client code calls `usePublicConfig()`. Nothing is inlined at build time, so one image serves every environment.

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
