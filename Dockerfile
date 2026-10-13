# Build from the REPO ROOT, so the Unity token, font and art files are in the context (the art images are
# Git LFS: hydrate them first, `git lfs pull`; the build fails on a pointer file):
#   docker build -f js/projects/theorycrafting/Dockerfile -t citadel-theorycrafting .
# Run: docker run --rm -p 3000:3000 -e PORT=3000 citadel-theorycrafting
# Environment (all optional) is read at run time: see the README.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

FROM base AS deps
WORKDIR /repo/js/projects/theorycrafting
COPY js/projects/theorycrafting/package.json js/projects/theorycrafting/pnpm-lock.yaml js/projects/theorycrafting/pnpm-workspace.yaml ./
# No cache mount: Railway's builder refuses one whose id lacks its per-service prefix.
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /repo
# The Unity files the prepare script derives the tokens, font, grid art and stat wording from
# (scripts/prepare-game-assets.mjs SOURCES), kept at their repo paths: it finds them by walking up.
COPY src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/DesignSystem/tokens/ src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/DesignSystem/tokens/
COPY src/Citadel.Unity/ui-prototype/public/fonts/VCROSDNEUE.ttf src/Citadel.Unity/ui-prototype/public/fonts/VCROSDNEUE.ttf
COPY src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/Panels/Fitting/UI/FittingPanel.fixture.json src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/Panels/Fitting/UI/
COPY src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/InventoryGrid/InventoryGrid.fixture.json src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/InventoryGrid/
COPY src/Citadel.Unity/Assets/UI/Elements/Resources/Icon/hardpoint-*.svg src/Citadel.Unity/Assets/UI/Elements/Resources/Icon/
COPY src/Citadel.Unity/Assets/Scripts/Runtime/Common/Stats/StatTypeText.cs src/Citadel.Unity/Assets/Scripts/Runtime/Common/Stats/
COPY src/Citadel.Unity/Assets/Scripts/Simulation/LootGeneration/StatTypeRules.cs src/Citadel.Unity/Assets/Scripts/Simulation/LootGeneration/
COPY src/Citadel.Unity/Assets/Scripts/Simulation/Modules/Modules.qtn src/Citadel.Unity/Assets/Scripts/Simulation/Modules/
COPY src/Citadel.Unity/Assets/Scripts/Simulation/Effects.qtn src/Citadel.Unity/Assets/Scripts/Simulation/AffinityThresholdResolver.cs src/Citadel.Unity/Assets/Scripts/Simulation/
# Item art (scripts/game-art.mjs): the prefabs and assets that name icons, the images and their .meta files.
# Dockerfile.dockerignore keeps this to those file types; prepare fails on an image that is an LFS pointer.
COPY tools/ship-restore/lib/game-assets.js tools/ship-restore/lib/rarity-names.js tools/ship-restore/lib/
COPY src/Citadel.Unity/Assets/Scripts/Simulation/Items/Items.qtn src/Citadel.Unity/Assets/Scripts/Simulation/Items/
COPY src/Citadel.Unity/Assets/Content/SessionDestinations/Shared/Quantum/Modules/ src/Citadel.Unity/Assets/Content/SessionDestinations/Shared/Quantum/Modules/
COPY src/Citadel.Unity/Assets/Content/SessionDestinations/Shared/Quantum/Ships/ src/Citadel.Unity/Assets/Content/SessionDestinations/Shared/Quantum/Ships/
COPY src/Citadel.Unity/Assets/Config/Quantum/Definitions/Artifacts/ src/Citadel.Unity/Assets/Config/Quantum/Definitions/Artifacts/
COPY src/Citadel.Unity/Assets/Config/Quantum/Definitions/Recipes/ src/Citadel.Unity/Assets/Config/Quantum/Definitions/Recipes/
COPY src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/World/EntityOverlayHudConfig.asset src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/World/
COPY src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/Modules/Icons/ src/Citadel.Unity/Assets/Scripts/Runtime/ArenaUI/Modules/Icons/
COPY src/Citadel.Unity/Assets/UI/Elements/Icons/Module/ src/Citadel.Unity/Assets/UI/Elements/Icons/Module/
COPY src/Citadel.Unity/Assets/Art/ShipIndicator/ src/Citadel.Unity/Assets/Art/ShipIndicator/
WORKDIR /repo/js/projects/theorycrafting
COPY --from=deps /repo/js/projects/theorycrafting/node_modules ./node_modules
COPY js/projects/theorycrafting/ ./
RUN pnpm build

FROM node:24-alpine AS run
# HOSTNAME=:: listens on IPv6 and IPv4 both: Railway's private network is IPv6.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=:: PORT=3000
WORKDIR /app
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
COPY --from=build --chown=app:app /repo/js/projects/theorycrafting/.next/standalone ./
COPY --from=build --chown=app:app /repo/js/projects/theorycrafting/.next/static ./.next/static
# The item art prepare-game-assets wrote; the standalone output does not include public/.
COPY --from=build --chown=app:app /repo/js/projects/theorycrafting/public ./public
# The schema and its apply script run before the server. migrate.mjs needs `pg`, which the standalone
# trace includes because the pages import src/lib/fits/db.ts (checked by building and running this image).
COPY --from=build --chown=app:app /repo/js/projects/theorycrafting/src/lib/fits/migrate.mjs /repo/js/projects/theorycrafting/src/lib/fits/schema.sql ./src/lib/fits/
# The re-evaluation job (src/jobs/reevaluate.ts) runs from this same image as a cron service. Node strips
# the types itself, so there is no compile step: just the job's own files, which import nothing from Next
# and use `pg` from the standalone node_modules. Start command: `node src/jobs/reevaluate.ts`.
COPY --from=build --chown=app:app /repo/js/projects/theorycrafting/src/jobs/reevaluate.ts ./src/jobs/
COPY --from=build --chown=app:app /repo/js/projects/theorycrafting/src/lib/engine/client.ts /repo/js/projects/theorycrafting/src/lib/engine/types.ts ./src/lib/engine/
COPY --from=build --chown=app:app /repo/js/projects/theorycrafting/src/lib/fits/pool-db.ts /repo/js/projects/theorycrafting/src/lib/fits/queries.ts /repo/js/projects/theorycrafting/src/lib/fits/filters.ts /repo/js/projects/theorycrafting/src/lib/fits/limits.ts /repo/js/projects/theorycrafting/src/lib/fits/service.ts ./src/lib/fits/
# Fails the build if the job's import closure isn't all here (importing runs nothing: main() only runs
# as the entry point). src/jobs/reevaluate-closure.test.mjs checks the same list from source.
RUN node -e "import('./src/jobs/reevaluate.ts').then(() => console.log('job imports resolve'), (e) => { console.error(e); process.exit(1); })"
USER app
EXPOSE 3000
# Apply the schema first (a no-op when current, and without DATABASE_URL); a failed migration stops the start.
CMD ["sh", "-c", "node src/lib/fits/migrate.mjs && node server.js"]
