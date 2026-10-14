import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import art from "#/components/grid/fitting-art.generated.json";
import { boundsOf, iconArea } from "#/components/grid/geometry";
import { moduleCells, type GridModel } from "#/components/grid/model";
import { logoDataUri } from "#/lib/brand/logo";
import { art2x, itemIcon } from "#/lib/art/item-icon";
import { getConfig } from "#/lib/site-config";
import { isOpenFit } from "#/lib/engine/open-fit";
import { loadFitPage } from "#/lib/site/loaders";
import { siteDeps } from "#/lib/site/server";

// A fit's share card: what link previews on Discord, X and elsewhere show for its page.
export const alt = "A Citadel ship fit";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Copied from the Unity tree by scripts/prepare-game-assets.mjs; next.config.ts traces it into this route.
const FONT = join(process.cwd(), "src/app/fonts/VCROSDNEUE.ttf");
const T = art.tokens;
const TIERS = art.tiers as Record<string, { bg: string; border: string; base: string }>;

function MiniGrid({ model, icons }: { model: GridModel; icons: ReadonlyMap<string, string> }) {
  const cells = model.modules.flatMap(moduleCells);
  const enabled = model.slots.flatMap((slot, index) => (slot === "None" ? [] : [{ row: Math.floor(index / model.cols), col: index % model.cols }]));
  const box = boundsOf([...enabled, ...cells]);
  if (!box) return null;
  const cell = Math.floor(Math.min(440 / box.rows, 440 / box.cols));
  const at = (row: number, col: number) => ({ left: (col - box.minCol) * cell, top: (row - box.minRow) * cell });
  return (
    <div style={{ display: "flex", position: "relative", width: box.cols * cell, height: box.rows * cell }}>
      {enabled.map(({ row, col }) => (
        <div
          key={`s${row},${col}`}
          style={{ position: "absolute", ...at(row, col), width: cell - 4, height: cell - 4, margin: 2, border: "1px solid rgba(107, 122, 122, 0.72)", background: "rgba(83, 96, 96, 0.12)" }}
        />
      ))}
      {model.modules.flatMap((module) => {
        const tier = TIERS[module.tier]!;
        const unknown = !module.known;
        return moduleCells(module).map(({ row, col }) => (
          <div
            key={`m${module.index}-${row},${col}`}
            style={{
              position: "absolute",
              ...at(row, col),
              width: cell - 2,
              height: cell - 2,
              margin: 1,
              background: unknown ? art.colors.HazardTapeRed : tier.bg,
              border: `2px solid ${module.issues.length ? art.colors.InvalidRed : tier.base}`,
            }}
          />
        ));
      })}
      {model.modules.map((module) => {
        const icon = module.icon ? icons.get(module.icon) : undefined;
        const area = iconArea(moduleCells(module));
        if (!icon || !area) return null;
        // As in the builder: a square on the icon area's short side, less an inset, centred on it.
        const size = Math.min(area.rows, area.cols) * cell - Math.round(cell * 0.3);
        const { left, top } = at(area.minRow, area.minCol);
        return (
          <img
            key={`i${module.index}`}
            src={icon}
            width={size}
            height={size}
            alt=""
            style={{ position: "absolute", left: left + (area.cols * cell - size) / 2, top: top + (area.rows * cell - size) / 2, objectFit: "contain" }}
          />
        );
      })}
    </div>
  );
}

/**
 * Game art as a PNG data URI for the card (the share card's renderer takes PNG, not WebP), or null when
 * there is none or it can't be read: the card then goes without that image. `url` is the catalog's absolute
 * public art URL; the server fetches the same file from the API's internal address.
 */
async function artPng(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const internal = getConfig().apiInternalUrl;
    if (!internal) throw new Error("the game data API isn't configured");
    const response = await fetch(`${internal}${new URL(art2x(url)).pathname}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`the API answered ${response.status}`);
    const { default: sharp } = await import("sharp");
    const png = await sharp(Buffer.from(await response.arrayBuffer())).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch (error) {
    // The card goes out without the art; say why, so a missing sharp build or image shows in the logs.
    console.warn(`share card: art ${url} could not be converted: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

type Params = Promise<{ id: string }>;

export default async function FitCard({ params }: { params: Params }) {
  const { id } = await params;
  const [font, data, logo] = await Promise.all([readFile(FONT), loadFitPage(siteDeps(), id, { userId: null, isAdmin: false }), logoDataUri(128)]);
  const fonts = [{ name: "VCR", data: font, weight: 400 as const }];
  const frame = { display: "flex", width: "100%", height: "100%", background: "#0c0e0f", fontFamily: "VCR", color: T["text-primary"] } as const;

  if (data.status !== "ok") {
    return new ImageResponse(
      <div style={{ ...frame, alignItems: "center", justifyContent: "center", gap: 40, fontSize: 72, letterSpacing: 12 }}>
        <img src={logo} width={128} height={128} alt="" />
        HARDPOINT.FIT
      </div>,
      { ...size, fonts },
    );
  }
  const { fit, shown, grid } = data;
  const hull = data.hull?.name ?? "UNKNOWN HULL";
  const icon = await artPng(data.hull ? itemIcon({ art: data.hull.art, category: "Ship" }, isOpenFit(fit.fit) ? fit.fit.hull.roll : { rarity: "Normal", isIdentified: true }) : null);
  const moduleArt = grid.status === "ready" ? [...new Set(grid.model.modules.flatMap((module) => (module.icon ? [module.icon] : [])))] : [];
  const icons = new Map((await Promise.all(moduleArt.map(async (url) => [url, await artPng(url)] as const))).flatMap(([url, png]) => (png ? [[url, png] as const] : [])));
  const rating = shown.reference?.rating ?? null;
  const standing = shown.standing === "outdated" ? { text: "OUTDATED", color: T["state-negative"] } : shown.standing === "current" ? { text: "WORKS ON CURRENT BUILD", color: T["state-positive"] } : null;
  return new ImageResponse(
    <div style={{ ...frame, padding: 56, gap: 56 }}>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            {icon && <img src={icon} width={88} height={88} style={{ objectFit: "contain" }} alt="" />}
            <div style={{ display: "flex", fontSize: 26, letterSpacing: 8, color: T["accent-orange"] }}>{`${hull} FIT`}</div>
          </div>
          <div style={{ display: "flex", fontSize: 60, letterSpacing: 4, lineHeight: 1.1, textTransform: "uppercase" }}>{fit.title}</div>
          <div style={{ display: "flex", fontSize: 26, letterSpacing: 4, color: T["text-primary-muted"] }}>{`BY ${fit.authorName.toUpperCase()}`}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 28, letterSpacing: 4 }}>
          <div style={{ display: "flex", gap: 36 }}>
            <span style={{ color: T["state-quantity"] }}>{`${fit.votes} ${fit.votes === 1 ? "UPVOTE" : "UPVOTES"}`}</span>
            {rating !== null && <span style={{ color: T["state-quantity"] }}>{`RATING ${rating}`}</span>}
          </div>
          {standing && <div style={{ display: "flex", color: standing.color, fontSize: 22 }}>{standing.text}</div>}
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 20, letterSpacing: 8, color: T["text-secondary"] }}>
            <img src={logo} width={36} height={36} alt="" />
            HARDPOINT.FIT
          </div>
        </div>
      </div>
      <div style={{ display: "flex", width: 470, alignItems: "center", justifyContent: "center", background: T["panel-bg"], border: `1px solid ${T["accent-muted"]}` }}>
        {grid.status === "ready" ? <MiniGrid model={grid.model} icons={icons} /> : <div style={{ display: "flex", fontSize: 24, color: T["text-secondary"] }}>{hull}</div>}
      </div>
    </div>,
    { ...size, fonts },
  );
}
