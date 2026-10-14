// Module names for the browse filter, read from the catalog the server already holds. The catalog is the
// only owner of an item's name; nothing here is stored. Every catalog item is a module a fit can carry
// (the builder's palette offers all of them), so any def in the catalog is a valid thing to search for.
import type { Catalog } from "../engine/types";

export type ModuleInfo = { def: string; name: string };

export const MODULE_SUGGESTIONS = 12;

/** The names of these defs, in the order given; a def the catalog doesn't know keeps a generic label so its chip can still be removed. */
export function moduleInfos(catalog: Catalog | null, defs: readonly string[]): ModuleInfo[] {
  const names = new Map((catalog?.items ?? []).map((item) => [item.def, item.name]));
  return defs.map((def) => ({ def, name: names.get(def) ?? "UNKNOWN MODULE" }));
}

/** Items whose name contains every word of `text` (case-insensitive), names starting with the first word first. */
export function searchModules(catalog: Catalog | null, text: string, limit = MODULE_SUGGESTIONS): ModuleInfo[] {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.length === 0) return [];
  const hits: { def: string; name: string; prefix: boolean }[] = [];
  for (const item of catalog?.items ?? []) {
    const name = item.name.toLowerCase();
    if (words.every((word) => name.includes(word))) hits.push({ def: item.def, name: item.name, prefix: name.startsWith(words[0]!) });
  }
  hits.sort((a, b) => Number(b.prefix) - Number(a.prefix) || a.name.localeCompare(b.name) || a.def.localeCompare(b.def));
  return hits.slice(0, limit).map(({ def, name }) => ({ def, name }));
}
