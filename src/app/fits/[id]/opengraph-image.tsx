import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import art from "#/components/grid/fitting-art.generated.json";
import { boundsOf, footprintOutline, iconBox, insetLoop, type Cell, type Point } from "#/components/grid/geometry";
import { cellSizeFor, SITE_GRID } from "#/components/grid/scale";
import { moduleCells, type GridModel } from "#/components/grid/model";
import { art2x } from "#/lib/art/art-manifest";
import { logoDataUri } from "#/lib/brand/logo";
import { itemIcon } from "#/lib/art/item-icon";
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

/** The card's grid panel: 440px each way inside the 470px column. */
const GRID_SPACE = { width: 440, height: 440 };

/** A loop of corners as an SVG path. */
const pathOf = (loops: readonly Point[][]) => loops.map((loop) => `M${loop.map((p) => `${p.x} ${p.y}`).join("L")}Z`).join("");

/**
 * The fit's grid as the site draws it, small: the hull's enabled slot boxes, then each module as one
 * shape, its whole footprint filled in its tier colour with a single outline around its outer edges
 * (footprintOutline, from the same outer edges as the site's tiles), each Tek Cipher cell filled as the
 * site fills it, and the module's art on top where the game puts it (iconBox). One inline SVG draws the shapes.
 */
function MiniGrid({ model, icons }: { model: GridModel; icons: ReadonlyMap<string, string> }) {
  const cells = model.modules.flatMap(moduleCells);
  const enabled = model.slots.flatMap((slot, index) => (slot === "None" ? [] : [{ row: Math.floor(index / model.cols), col: index % model.cols }]));
  const box = boundsOf([...enabled, ...cells]);
  if (!box) return null;
  const cell = cellSizeFor(GRID_SPACE, box, { min: 0, max: SITE_GRID.max });
  // The game's art space (48px cells, 3px slot inset) scaled to this card's cell.
  const scale = cell / art.cellSize;
  const inset = art.slotInset * scale;
  const line = Math.max(2, Math.round(scale * 2));
  const shift = (cellsOf: readonly Cell[]) => cellsOf.map(({ row, col }) => ({ row: row - box.minRow, col: col - box.minCol }));
  const width = box.cols * cell;
  const height = box.rows * cell;
  return (
    <div style={{ display: "flex", position: "relative", width, height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: "absolute", left: 0, top: 0 }}>
        {shift(enabled).map(({ row, col }) => (
          <rect key={`s${row},${col}`} x={col * cell + inset} y={row * cell + inset} width={cell - 2 * inset} height={cell - 2 * inset} fill="rgba(83, 96, 96, 0.12)" stroke="rgba(107, 122, 122, 0.72)" strokeWidth={1} />
        ))}
        {model.modules.map((module) => {
          const tier = TIERS[module.tier]!;
          const fill = module.known ? tier.bg : art.colors.HazardTapeRed;
          const edge = module.issues.length || !module.known ? art.colors.InvalidRed : tier.base;
          const shape = pathOf(footprintOutline(shift(module.cells)).map((loop) => insetLoop(loop, cell, inset)));
          const ciphers = pathOf(shift(module.expansions).flatMap((one) => footprintOutline([one]).map((loop) => insetLoop(loop, cell, inset))));
          return (
            <g key={`m${module.index}`}>
              <path d={shape} fill={fill} fillRule="evenodd" stroke={edge} strokeWidth={line} strokeLinejoin="miter" />
              {ciphers && <path d={ciphers} fill={fill} />}
            </g>
          );
        })}
      </svg>
      {model.modules.map((module) => {
        const icon = module.icon ? icons.get(module.icon) : undefined;
        const place = iconBox(module.cells, art.cellSize, art.slotInset);
        const bounds = boundsOf(module.cells);
        if (!icon || !place || !bounds) return null;
        const size = Math.round(place.size * scale);
        return (
          <img
            key={`i${module.index}`}
            src={icon}
            width={size}
            height={size}
            alt=""
            style={{ position: "absolute", left: (bounds.minCol - box.minCol) * cell + place.left * scale, top: (bounds.minRow - box.minRow) * cell + place.top * scale, objectFit: "contain" }}
          />
        );
      })}
    </div>
  );
}

/**
 * Game art as a PNG data URI for the card (the share card's renderer takes PNG, not WebP), or null when
 * there is none or it can't be read: the card then goes without that image.
 */
async function artPng(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const { default: sharp } = await import("sharp");
    const png = await sharp(join(process.cwd(), "public", art2x(url))).png().toBuffer();
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
  const icon = await artPng(data.hull ? itemIcon({ path: data.hull.path, category: "Ship" }, isOpenFit(fit.fit) ? fit.fit.hull.roll : { rarity: "Normal", isIdentified: true }) : null);
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
