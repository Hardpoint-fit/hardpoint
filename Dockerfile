# Build from this repo's root: docker build -t hardpoint .
# Run: docker run --rm -p 3000:3000 -e PORT=3000 hardpoint
# Environment (all optional) is read at run time: see the README.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

FROM base AS deps
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# No cache mount: Railway's builder refuses one whose id lacks its per-service prefix.
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /build
COPY --from=deps /build/node_modules ./node_modules
COPY . ./
RUN pnpm build

FROM node:24-alpine AS run
# HOSTNAME=:: listens on IPv6 and IPv4 both: Railway's private network is IPv6.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=:: PORT=3000
WORKDIR /app
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
COPY --from=build --chown=app:app /build/.next/standalone ./
COPY --from=build --chown=app:app /build/.next/static ./.next/static
# The standalone output does not include public/.
COPY --from=build --chown=app:app /build/public ./public
# The schema and its apply script run before the server. migrate.mjs needs `pg`, which the standalone
# trace includes because the pages import src/lib/fits/db.ts (checked by building and running this image).
COPY --from=build --chown=app:app /build/src/lib/fits/migrate.mjs /build/src/lib/fits/schema.sql ./src/lib/fits/
# The re-evaluation job (src/jobs/reevaluate.ts) runs from this same image as a cron service. Node strips
# the types itself, so there is no compile step: just the job's own files, which import nothing from Next
# and use `pg` from the standalone node_modules. Start command: `node src/jobs/reevaluate.ts`.
COPY --from=build --chown=app:app /build/src/jobs/reevaluate.ts ./src/jobs/
COPY --from=build --chown=app:app /build/src/lib/engine/client.ts /build/src/lib/engine/catalog-resources.ts /build/src/lib/engine/types.ts ./src/lib/engine/
COPY --from=build --chown=app:app /build/src/lib/fits/pool-db.ts /build/src/lib/fits/queries.ts /build/src/lib/fits/filters.ts /build/src/lib/fits/limits.ts /build/src/lib/fits/service.ts /build/src/lib/fits/notifications.ts ./src/lib/fits/
# Fails the build if the job's import closure isn't all here (importing runs nothing: main() only runs
# as the entry point). src/jobs/reevaluate-closure.test.mjs checks the same list from source.
RUN node -e "import('./src/jobs/reevaluate.ts').then(() => console.log('job imports resolve'), (e) => { console.error(e); process.exit(1); })"
USER app
EXPOSE 3000
# Apply the schema first (a no-op when current, and without DATABASE_URL); a failed migration stops the start.
CMD ["sh", "-c", "node src/lib/fits/migrate.mjs && node server.js"]
