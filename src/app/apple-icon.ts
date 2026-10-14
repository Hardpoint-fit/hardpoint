import { logoPng } from "#/lib/brand/logo";

// The home-screen icon: iOS shows no transparency, so the logo sits on the site's background.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default async function AppleIcon() {
  const png = await logoPng(180, { padding: 22, background: "#0c0e0f" });
  return new Response(new Uint8Array(png), { headers: { "Content-Type": contentType } });
}
