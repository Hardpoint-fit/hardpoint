# Build from the REPO ROOT, so the Unity token and font files are in the context:
#   docker build -f js/projects/theorycrafting/Dockerfile -t citadel-theorycrafting .
# Run: docker run --rm -p 3000:3000 -e PORT=3000 citadel-theorycrafting
# Environment (all optional) is read at run time: see the README.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

FROM base AS deps
WORKDIR /repo/js/projects/theorycrafting
COPY js/projects/theorycrafting/package.json js/projects/theorycrafting/pnpm-lock.yaml js/projects/theorycrafting/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

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
WORKDIR /repo/js/projects/theorycrafting
COPY --from=deps /repo/js/projects/theorycrafting/node_modules ./node_modules
COPY js/projects/theorycrafting/ ./
RUN pnpm build

FROM node:24-alpine AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
COPY --from=build --chown=app:app /repo/js/projects/theorycrafting/.next/standalone ./
COPY --from=build --chown=app:app /repo/js/projects/theorycrafting/.next/static ./.next/static
# The schema and its apply script run before the server. migrate.mjs needs `pg`, which the standalone
# trace includes because the pages import src/lib/fits/db.ts (checked by building and running this image).
COPY --from=build --chown=app:app /repo/js/projects/theorycrafting/src/lib/fits/migrate.mjs /repo/js/projects/theorycrafting/src/lib/fits/schema.sql ./src/lib/fits/
USER app
EXPOSE 3000
# Apply the schema first (a no-op when current, and without DATABASE_URL); a failed migration stops the start.
CMD ["sh", "-c", "node src/lib/fits/migrate.mjs && node server.js"]
