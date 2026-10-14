// Every item in the build that can go on the grid, searchable and filtered by slot, module type and
// category, each with its game icon. Hovering or focusing one shows its tooltip: description and the
// stat lines of its plainest roll. Pressing an item takes it in hand: drag it onto the grid, or
// (keyboard) press Enter to place it with the arrow keys.
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { CatalogItem } from "#/lib/engine/types";
import { baseIcon } from "#/lib/art/item-icon";
import { boundsOf } from "#/components/grid/geometry";
import { FactRows, ItemDescription, ItemIcon } from "#/components/item-text";
import { Panel } from "#/components/ui";
import { enumWords } from "./labels";
import type { BuilderCatalog } from "./rules";

const ALL = "";

/** The item's footprint in its 5x5 shape grid, cropped: a small drawing of its cells. */
export function ShapeGlyph({ item, size = 7 }: { item: CatalogItem; size?: number }) {
  const bounds = boundsOf(item.shape.cells);
  if (!bounds) return null;
  return (
    <svg className="shape-glyph" width={bounds.cols * size} height={bounds.rows * size} aria-hidden="true">
      {item.shape.cells.map((cell) => (
        <rect key={`${cell.row},${cell.col}`} x={(cell.col - bounds.minCol) * size + 0.5} y={(cell.row - bounds.minRow) * size + 0.5} width={size - 1} height={size - 1} />
      ))}
    </svg>
  );
}

/** An item's tooltip as the palette shows it: the plainest roll, so the catalog's facts are this roll's. */
export function ItemTip({ item }: { item: CatalogItem }) {
  return (
    <div className="plate">
      <div className="plate__head">
        <ItemIcon src={baseIcon(item.path)} size={32} />
        <div className="plate__head-text">
          <div className="plate__name">{item.name}</div>
          <div className="plate__sub">
            <span className="tone-neutral">{enumWords(item.slotType)}</span>
            {item.moduleType !== "None" && item.moduleType !== item.slotType && <span className="tone-neutral">{enumWords(item.moduleType)}</span>}
          </div>
        </div>
      </div>
      <ItemDescription text={item.description} />
      <FactRows facts={item.facts} />
    </div>
  );
}

/**
 * The hovered item's tooltip beside the list, in a portal on the body and fixed to the viewport, so
 * neither the list's scroll nor the sticky column's stacking can clip or cover it.
 */
function PaletteTip({ item, anchor }: { item: CatalogItem; anchor: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: anchor.right + 8, top: anchor.top });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    const width = box?.width ?? 0;
    const height = box?.height ?? 0;
    // Beside the list; on a narrow screen, where there is no room beside it, below the item.
    const beside = anchor.right + 8 + width <= window.innerWidth - 8;
    setAt({
      left: beside ? anchor.right + 8 : Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(beside ? anchor.top : anchor.bottom + 4, window.innerHeight - height - 8)),
    });
  }, [anchor, item]);
  return createPortal(
    <div ref={ref} className="palette-tip" style={at} role="tooltip">
      <ItemTip item={item} />
    </div>,
    document.body,
  );
}

function distinct(items: readonly CatalogItem[], read: (item: CatalogItem) => string): string[] {
  return [...new Set(items.map(read))].sort();
}

export function Palette({
  cat,
  heldDef,
  holding,
  onPointerPick,
  onKeyboardPick,
}: {
  cat: BuilderCatalog;
  heldDef: string | null;
  /** Something is in hand: Enter then places it (the workspace's keys), rather than taking another. */
  holding: boolean;
  onPointerPick: (def: string, event: PointerEvent<HTMLElement>) => void;
  onKeyboardPick: (def: string) => void;
}) {
  const items = cat.catalog.items;
  const [query, setQuery] = useState("");
  const [slotType, setSlotType] = useState(ALL);
  const [moduleType, setModuleType] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [tip, setTip] = useState<{ def: string; anchor: DOMRect } | null>(null);
  const show = (def: string) => (event: { currentTarget: HTMLElement }) => setTip({ def, anchor: event.currentTarget.getBoundingClientRect() });
  const hide = () => setTip(null);
  const slotTypes = useMemo(() => distinct(items, (item) => item.slotType), [items]);
  const moduleTypes = useMemo(() => distinct(items, (item) => item.moduleType), [items]);
  const categories = useMemo(() => distinct(items, (item) => item.category), [items]);

  const shown = useMemo(() => {
    const words = query.trim().toUpperCase().split(/\s+/).filter(Boolean);
    return items
      .filter(
        (item) =>
          (slotType === ALL || item.slotType === slotType) &&
          (moduleType === ALL || item.moduleType === moduleType) &&
          (category === ALL || item.category === category) &&
          words.every((word) => item.name.includes(word) || enumWords(item.moduleType).includes(word) || enumWords(item.slotType).includes(word)),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.def.localeCompare(b.def));
  }, [items, query, slotType, moduleType, category]);

  const filter = (label: string, value: string, set: (value: string) => void, options: string[]) => (
    <label className="field">
      {label}
      <select className="select" value={value} onChange={(event) => set(event.target.value)}>
        <option value={ALL}>ALL</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option === "None" ? "NONE" : enumWords(option)}
          </option>
        ))}
      </select>
    </label>
  );

  const onKey = (def: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (holding || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onKeyboardPick(def);
  };

  return (
    <Panel title="ITEMS" aside={String(shown.length)} className="palette" contentClassName="palette__content">
      <div className="palette__filters">
        <label className="field">
          SEARCH
          <input className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="NAME OR TYPE" />
        </label>
        <div className="palette__selects">
          {filter("SLOT", slotType, setSlotType, slotTypes)}
          {filter("TYPE", moduleType, setModuleType, moduleTypes)}
          {filter("CATEGORY", category, setCategory, categories)}
        </div>
      </div>
      <p className="note">DRAG ONTO THE GRID, OR PRESS ENTER AND PLACE WITH THE ARROW KEYS.</p>
      <ul className="palette__list" aria-label="Items">
        {shown.map((item) => (
          <li key={item.def}>
            <button
              type="button"
              className={`palette-item ${heldDef === item.def ? "palette-item--held" : ""}`}
              data-palette-item=""
              onPointerDown={(event) => {
                hide();
                if (event.button === 0) onPointerPick(item.def, event);
              }}
              onPointerEnter={show(item.def)}
              onPointerLeave={hide}
              onFocus={show(item.def)}
              onBlur={hide}
              onKeyDown={onKey(item.def)}
              aria-label={`${item.name}, ${enumWords(item.slotType)} ${enumWords(item.moduleType)}`}
            >
              <span className="palette-item__icon">
                <ItemIcon src={baseIcon(item.path)} size={36} />
              </span>
              <span className="palette-item__text">
                <span className="palette-item__name">{item.name}</span>
                <span className="palette-item__meta">
                  {enumWords(item.slotType)}
                  {item.moduleType !== "None" && item.moduleType !== item.slotType ? ` · ${enumWords(item.moduleType)}` : ""}
                  {item.category !== "Module" ? ` · ${enumWords(item.category)}` : ""}
                </span>
              </span>
              <span className="palette-item__shape">
                <ShapeGlyph item={item} size={5} />
              </span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="note">NO ITEMS MATCH.</li>}
      </ul>
      {tip && !holding && cat.items.get(tip.def) && <PaletteTip item={cat.items.get(tip.def)!} anchor={tip.anchor} />}
    </Panel>
  );
}
