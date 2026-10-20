import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { SiteHeader } from "#/components/site-header";
import { TipPlacement } from "#/components/tip-placement";
import { PublicConfigProvider } from "#/lib/public-config";
import { getConfig, getPublicConfig } from "#/lib/site-config";
import "./game-tokens.generated.css";
import "./globals.css";
import "./game-ui.css";

// Synced from the Unity tree by scripts/sync-unity.mjs.
const vcr = localFont({
  src: "./fonts/VCROSDNEUE.ttf",
  weight: "400",
  display: "swap",
  variable: "--font-vcr",
});

// metadataBase makes share-card and icon URLs absolute on the public origin; Next would otherwise use the
// address the server listens on, which link previews can't reach.
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(getConfig().siteUrl),
    title: "hardpoint.fit",
    description: "Build, share and compare Citadel ship fits.",
    // Listed by hand: an explicit icon list replaces the one Next would build from apple-icon.ts.
    icons: { icon: { url: "/logo.svg", type: "image/svg+xml" }, apple: "/apple-icon" },
  };
}

// The public config comes from the run-time environment, so no page is prerendered at build time.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  const config = getPublicConfig();
  return (
    <html lang="en" className={vcr.variable}>
      <body>
        <PublicConfigProvider config={config}>
          <SiteHeader />
          {children}
          <TipPlacement />
        </PublicConfigProvider>
      </body>
    </html>
  );
}
