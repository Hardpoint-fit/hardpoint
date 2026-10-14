"use client";

// The browse filter's module picker: type a name, pick a suggestion from the server's catalog (/api/modules),
// and it becomes a chip. Each chip carries a hidden `module` field, so the surrounding GET form holds the
// whole state and the page's URL stays the one owner of it. Chips from the URL render without JavaScript.
import { useEffect, useId, useState } from "react";
import { MAX_MODULES } from "#/lib/fits/filters";
import type { ModuleInfo } from "#/lib/site/module-search";

export function ModuleFilter({ selected }: { selected: ModuleInfo[] }) {
  const [chips, setChips] = useState(selected);
  const [text, setText] = useState("");
  const [options, setOptions] = useState<ModuleInfo[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();
  const full = chips.length >= MAX_MODULES;

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === "" || full) {
      setOptions([]);
      return;
    }
    // The cleanup aborts the request and stops it from applying, so a late response never reopens the list.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/modules?q=${encodeURIComponent(trimmed)}`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = (await response.json()) as { modules: ModuleInfo[] };
        if (controller.signal.aborted) return;
        setOptions(body.modules.filter((module) => !chips.some((chip) => chip.def === module.def)));
        setActive(0);
      } catch {
        // No suggestions this time (or aborted); the chips already chosen still work.
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, full, chips]);

  const pick = (module: ModuleInfo) => {
    setChips((current) => (current.some((chip) => chip.def === module.def) ? current : [...current, module]));
    setText("");
    setOptions([]);
  };

  return (
    <div className="field module-filter">
      <label htmlFor={`${listId}-input`}>MODULES</label>
      {chips.length > 0 && (
        <ul className="module-filter__chips" aria-label="Chosen modules">
          {chips.map((chip) => (
            <li key={chip.def} className="chip module-filter__chip">
              <input type="hidden" name="module" value={chip.def} />
              {chip.name.toUpperCase()}
              <button
                type="button"
                className="module-filter__remove"
                aria-label={`Remove ${chip.name}`}
                onClick={() => setChips((current) => current.filter((each) => each.def !== chip.def))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={`${listId}-input`}
        className="input"
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls={options.length > 0 ? listId : undefined}
        aria-activedescendant={options.length > 0 ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        value={text}
        disabled={full}
        placeholder={full ? `UP TO ${MAX_MODULES} MODULES` : "ADD A MODULE"}
        maxLength={80}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (options.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, options.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            pick(options[active]!);
          } else if (event.key === "Escape") {
            setOptions([]);
          }
        }}
      />
      <span className="sr-only" role="status" aria-live="polite">
        {options.length > 0 ? `${options.length} ${options.length === 1 ? "suggestion" : "suggestions"}` : ""}
      </span>
      {options.length > 0 && (
        <ul id={listId} className="module-filter__options" role="listbox">
          {options.map((module, index) => (
            <li
              key={module.def}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "module-filter__option module-filter__option--active" : "module-filter__option"}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(module);
              }}
            >
              {module.name.toUpperCase()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
