// Every item in the build that can go on the grid, searchable and filtered by slot, module type and
// category. Pressing an item takes it in hand: drag it onto the grid, or (keyboard) press Enter to
// place it with the arrow keys.
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { CatalogItem } from "#/lib/engine/types";
import { boundsOf } from "#/components/grid/geometry";
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
              onPointerDown={(event) => {
                if (event.button === 0) onPointerPick(item.def, event);
              }}
              onKeyDown={onKey(item.def)}
              aria-label={`${item.name}, ${enumWords(item.slotType)} ${enumWords(item.moduleType)}`}
            >
              <span className="palette-item__shape">
                <ShapeGlyph item={item} />
              </span>
              <span className="palette-item__text">
                <span className="palette-item__name">{item.name}</span>
                <span className="palette-item__meta">
                  {enumWords(item.slotType)}
                  {item.moduleType !== "None" && item.moduleType !== item.slotType ? ` · ${enumWords(item.moduleType)}` : ""}
                  {item.category !== "Module" ? ` · ${enumWords(item.category)}` : ""}
                </span>
              </span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="note">NO ITEMS MATCH.</li>}
      </ul>
    </Panel>
  );
}
