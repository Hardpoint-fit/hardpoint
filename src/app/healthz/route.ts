export const dynamic = "force-dynamic";

// Liveness only: no database or engine calls, so a dependency outage never restarts the site.
export function GET() {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
