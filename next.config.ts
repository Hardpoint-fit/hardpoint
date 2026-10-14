import type { NextConfig } from "next";

const appRoot = import.meta.dirname;

const nextConfig: NextConfig = {
  output: "standalone",
  // The app is its own pnpm workspace; pin the root so the standalone server lands at
  // .next/standalone/server.js whatever lockfiles sit above this folder.
  outputFileTracingRoot: appRoot,
  turbopack: { root: appRoot },
  poweredByHeader: false,
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into this folder.
  agentRules: false,
  // The share card reads the game font from disk; the standalone output needs it next to the route.
  outputFileTracingIncludes: { "/fits/[id]/opengraph-image": ["./src/app/fonts/VCROSDNEUE.ttf"] },
  // Item art file names carry a hash of their bytes (tools/game-data-api/art/game-art.mjs), so a name never changes
  // content and browsers keep each image for a year.
  async headers() {
    return [{ source: "/art/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] }];
  },
};

export default nextConfig;
