// An item's icon, description and fact rows, drawn as the game's item tooltip draws them
// (ItemTooltip.uss: .mtt__name-icon, .mtt__row--description, .mtt__row--metric). Plain render, no hooks,
// so server pages and client panels share it.
import type { FactRow } from "#/lib/engine/types";
import { art2x } from "#/lib/art/art-manifest";

/**
 * An item's image at `size` px, or the no-art placeholder: the tile's own frame with the font's "?",
 * so an item without art still reads as an item (Review Focus #1).
 */
export function ItemIcon({ src, size, mirrored = false, className }: { src: string | null; size: number; mirrored?: boolean; className?: string }) {
  const classes = ["item-icon", src ? "" : "item-icon--none", mirrored ? "item-icon--mirrored" : "", className].filter(Boolean).join(" ");
  if (!src) {
    return (
      <span className={classes} style={{ width: size, height: size }} aria-hidden="true">
        ?
      </span>
    );
  }
  return <img className={classes} src={src} srcSet={`${src} 1x, ${art2x(src)} 2x`} width={size} height={size} alt="" aria-hidden="true" loading="lazy" decoding="async" />;
}

/** An authored description: plain text, its line breaks kept, never parsed as markup (Review Focus #3). */
export function ItemDescription({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return <p className="item-desc">{text}</p>;
}

const TONES: Record<string, string> = { Positive: "positive", Negative: "negative" };

/** The tooltip's stat lines: label on the left, value and unit on the right, toned as the game tones them. */
export function FactRows({ facts, note }: { facts: readonly FactRow[]; note?: string | null }) {
  if (facts.length === 0 && !note) return null;
  return (
    <div className="facts">
      {note && <div className="facts__note">{note}</div>}
      {facts.map((fact, i) => (
        <div key={`${fact.label}-${i}`} className="facts__row">
          <span className="facts__label">{fact.label}</span>
          <span className="facts__value-group">
            {fact.value !== null && <span className={`facts__value ${TONES[fact.tone] ?? ""}`}>{fact.value}</span>}
            {fact.unit && <span className="facts__unit">{fact.unit}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
