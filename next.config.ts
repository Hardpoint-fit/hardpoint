import type { NextConfig } from "next";

const appRoot = import.meta.dirname;

const nextConfig: NextConfig = {
  output: "standalone",
  // The app is its own pnpm workspace; pin the root so the standalone server lands at
  // .next/standalone/server.js whatever lockfiles sit above this folder.
  outputFileTracingRoot: appRoot,
  turbopack: { root: appRoot },
  poweredByHeader: false,
};

export default nextConfig;
