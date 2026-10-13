# Citadel theorycrafting site

A standalone Next.js 16 app (App Router, Tailwind 3, TypeScript) where players build, publish and compare ship fits. It is independent of `client-site` and has its own `pnpm-workspace.yaml` and lockfile. Design: `docs/superpowers/specs/2026-10-13-theorycrafting-design.md`.

## Commands

```
pnpm install
pnpm dev        # http://localhost:3000
pnpm test       # node --test
pnpm build      # needs no environment
pnpm typecheck
```

`pnpm build` and `pnpm dev` first run `scripts/prepare-game-assets.mjs`, which reads files from the Unity tree and so needs the whole repo checkout, not only this folder.

## Game tokens and font

The Unity files own the design tokens and the font; the site holds no copy of their values.

- `src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/DesignSystem/tokens/tokens.{color,typography,spacing,sizing,components}.uss`: the sheets `ui-prototype/src/main.tsx` imports. The prepare script strips the Unity-only declarations (`-unity-*`, `resource()`) and writes `src/app/game-tokens.generated.css`.
- `src/Citadel.Unity/ui-prototype/public/fonts/VCROSDNEUE.ttf`: copied to `src/app/fonts/` and loaded with `next/font/local`.

Both outputs are git-ignored. Change the Unity files, never the outputs. `globals.css` binds `--font-family` to the loaded font and adds the bevel panel shape.

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

## Docker

The build context is the **repo root**, because the build reads the Unity tokens and font:

```
docker build -f js/projects/theorycrafting/Dockerfile -t citadel-theorycrafting .
docker run --rm -p 3000:3000 citadel-theorycrafting
```

`Dockerfile.dockerignore` (picked up by BuildKit) limits the context to this app and those Unity files, so no repo-root `.dockerignore` is needed. The image runs `node server.js` from Next's standalone output as a non-root user and honours `PORT`. `GET /healthz` is the liveness check; it touches no dependency.

`pnpm start` runs `next start`, which Next warns about under `output: "standalone"`; production uses the container.
