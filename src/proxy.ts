import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { parseConfig } from "#/lib/config";

// Clerk runs only when both keys are set. The keys are read per request from the run-time
// environment (passing process.env whole, so nothing is inlined at build time), which lets one
// image serve every environment. Reads stay public: this middleware identifies, it never redirects.
const withClerk = clerkMiddleware(
  () => {},
  () => {
    // Only the publishable key is passed: Clerk reads CLERK_SECRET_KEY from the run-time environment
    // itself, and a secretKey option would demand CLERK_ENCRYPTION_KEY as well.
    return { publishableKey: parseConfig(process.env).clerkPublishableKey ?? undefined };
  },
);

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  return parseConfig(process.env).authEnabled ? withClerk(request, event) : NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next.js internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
