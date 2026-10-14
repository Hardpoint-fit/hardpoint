"use client";

// MODIFY GRID's tools: each grid consumable with its icon, what it has left under the game's caps and how
// many cells it can take now, and REVERT. The cells are the engine's answer (grid-mods.ts); picking a
// tool lights them on the grid, and a SKULD use asks which of its outcomes to apply.
import { ItemIcon } from "#/components/item-text";
import { baseIcon } from "#/lib/art/item-icon";
import type { CatalogGridConsumable, GridModResult, GridModsResponse } from "#/lib/engine/types";
import { budgetNote, effectNote, kindOf, resultLabel, targetsOf, type GridModsState } from "./grid-mods";

/** The chosen tool: a grid consumable's def, or REVERT. */
export type GridTool = string | "revert";

export const REVERT: GridTool = "revert";

export type GridModChoice = { cell: number; results: GridModResult[] };

const cellName = (cell: number, cols: number) => `ROW ${Math.floor(cell / cols) + 1}, COLUMN ${(cell % cols) + 1}`;

export function GridModPanel({
  consumables,
  state,
  answer,
  tool,
  modified,
  cols,
  slotAt,
  choice,
  onTool,
  onChoose,
  onCancelChoice,
}: {
  consumables: readonly CatalogGridConsumable[];
  state: GridModsState;
  /** The engine's answer for the fit as it is now; null while it is asked or when it failed. */
  answer: GridModsResponse | null;
  tool: GridTool | null;
  modified: number;
  cols: number;
  slotAt: (cell: number) => string;
  choice: GridModChoice | null;
  onTool: (tool: GridTool | null) => void;
  onChoose: (result: GridModResult) => void;
  onCancelChoice: () => void;
}) {
  const selected = consumables.find((consumable) => consumable.def === tool) ?? null;
  const budget = answer?.budget ?? null;
  return (
    <section className="grid-mods" aria-label="Modify grid">
      <div className="grid-mods__head">
        <span className="eyebrow">MODIFY GRID</span>
        {budget && (
          <span className="note">
            GRID EXTENSIONS {budget.expansions}/{budget.maxExpansions} · CONVERTERS SPENT: {budget.convertersSpent.length > 0 ? budget.convertersSpent.map((type) => type.toUpperCase()).join(", ") : "NONE"}
          </span>
        )}
      </div>
      {answer?.refusal && <p className="note note--error">{answer.refusal.toUpperCase()}</p>}
      {state.status === "error" && <p className="note note--error">CAN&apos;T ASK THE ENGINE WHICH CELLS TAKE A CONSUMABLE: {state.message.toUpperCase()}</p>}
      <div className="grid-mods__tools" role="group" aria-label="Grid consumables">
        {consumables.map((consumable) => {
          const cells = answer ? targetsOf(answer, consumable.def).size : null;
          const on = tool === consumable.def;
          return (
            <button
              key={consumable.def}
              type="button"
              className={`choice grid-mod ${on ? "choice--on" : ""}`}
              aria-pressed={on}
              onClick={() => onTool(on ? null : consumable.def)}
            >
              <ItemIcon src={baseIcon(consumable.art)} size={32} />
              <span className="grid-mod__text">
                <span className="grid-mod__name">{consumable.name}</span>
                <span>
                  {budget ? budgetNote(consumable, budget) : "…"}
                  {cells !== null ? ` · ${cells === 0 ? "NO CELL" : `${cells} CELL${cells === 1 ? "" : "S"}`}` : ""}
                </span>
              </span>
            </button>
          );
        })}
        <button type="button" className={`choice grid-mod ${tool === REVERT ? "choice--on" : ""}`} aria-pressed={tool === REVERT} onClick={() => onTool(tool === REVERT ? null : REVERT)}>
          <span className="grid-mod__text">
            <span className="grid-mod__name">REVERT</span>
            <span>
              {modified} MODIFIED CELL{modified === 1 ? "" : "S"}
            </span>
          </span>
        </button>
      </div>
      {choice && selected ? (
        <div className="grid-mods__choice" role="group" aria-label={`${selected.name} outcome`}>
          <p className="note">
            {selected.name} ON THE {slotAt(choice.cell).toUpperCase()} AT {cellName(choice.cell, cols)}. PICK THE OUTCOME:
          </p>
          <div className="choices">
            {[...choice.results].sort((a, b) => Number(a.cell !== choice.cell) - Number(b.cell !== choice.cell)).map((result) => (
              <button key={`${result.cell}:${result.slotType}`} type="button" className="choice" onClick={() => onChoose(result)}>
                {resultLabel(result, choice.cell, cols)}
              </button>
            ))}
            <button type="button" className="choice" onClick={onCancelChoice}>
              CANCEL
            </button>
          </div>
        </div>
      ) : (
        <p className="note" aria-live="polite">
          {tool === REVERT
            ? modified > 0
              ? "CLICK A MODIFIED CELL TO PUT IT BACK AS THE HULL HAS IT. THE ENGINE FLAGS ANYTHING THAT RELIED ON IT."
              : "NO CELL IS MODIFIED."
            : selected && !answer
              ? state.status === "error"
                ? "NO CELLS TO LIGHT UNTIL THE ENGINE ANSWERS."
                : `ASKING THE ENGINE WHICH CELLS ${selected.name} TAKES…`
              : selected
              ? `${effectNote(selected)}. ${kindOf(selected) === "skuld" ? "CLICK A LIT HARDPOINT, THEN PICK THE OUTCOME." : "CLICK A LIT CELL TO APPLY IT."}`
              : state.status === "loading" && !answer
                ? "ASKING THE ENGINE WHICH CELLS EACH CONSUMABLE TAKES."
                : "PICK A CONSUMABLE TO LIGHT THE CELLS IT CAN BE USED ON, OR REVERT."}
        </p>
      )}
    </section>
  );
}
