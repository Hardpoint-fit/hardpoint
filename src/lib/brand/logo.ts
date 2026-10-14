import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The site's logo, drawn once in public/logo.svg; every raster of it is rendered from that file.
const LOGO = join(process.cwd(), "public/logo.svg");

/** The logo as a square PNG of `size` pixels, `padding` of it blank on each side, over `background` when given. */
export async function logoPng(size: number, { padding = 0, background }: { padding?: number; background?: string } = {}): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const inner = size - 2 * padding;
  const mark = await sharp(await readFile(LOGO), { density: Math.ceil((inner / 56) * 72 * 2) }).resize(inner, inner).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: background ?? { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: mark, left: padding, top: padding }])
    .png()
    .toBuffer();
}

/** The logo as a PNG data URI, for the share cards (their renderer takes PNG). */
export async function logoDataUri(size: number): Promise<string> {
  return `data:image/png;base64,${(await logoPng(size)).toString("base64")}`;
}
