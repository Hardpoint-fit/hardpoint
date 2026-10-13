import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { PublicConfigProvider } from "#/lib/public-config";
import { getPublicConfig } from "#/lib/site-config";
import "./game-tokens.generated.css";
import "./globals.css";

// Copied from the Unity tree by scripts/prepare-game-assets.mjs.
const vcr = localFont({
  src: "./fonts/VCROSDNEUE.ttf",
  weight: "400",
  display: "swap",
  variable: "--font-vcr",
});

export const metadata: Metadata = {
  title: "Citadel Theorycrafting",
  description: "Build, share and compare Citadel ship fits.",
};

// The public config comes from the run-time environment, so no page is prerendered at build time.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={vcr.variable}>
      <body>
        <PublicConfigProvider config={getPublicConfig()}>{children}</PublicConfigProvider>
      </body>
    </html>
  );
}
