// What the compare page needs that is pure: reading a pasted fit link, lining up two fits' hull spec
// sections row by row, and listing which modules each fit has that the other lacks. The engine's
// sections and the catalog's names are the only sources; nothing here is stored.
import type { SpecRow, SpecSection } from "../engine/types.ts";

const FIT_ID = /^[0-9A-Za-z]{10}$/;

/** A fit id from a bare id or any text holding a `/fits/<id>` link; null when there is none. */
export function parseFitRef(text: string): string | null {
  const trimmed = text.trim();
  if (FIT_ID.test(trimmed)) return trimmed;
  const found = /\/fits\/([0-9A-Za-z]{10})(?![0-9A-Za-z])/.exec(trimmed);
  return found?.[1] ?? null;
}

/** The path the compare page lives at, for these two fits (`b` omitted: only the first is chosen). */
export function compareHref(a: string, b?: string): string {
  const params = new URLSearchParams({ a });
  if (b) params.set("b", b);
  return `/compare?${params}`;
}

/** What a row shows: the stat now (a comparison row's second value) with its unit. */
export function rowText(row: SpecRow): string {
  const value = row.secondary ?? row.primary;
  return value.unit ? `${value.text} ${value.unit}` : value.text;
}

export type CompareRow = { id: string; label: string; a: SpecRow | null; b: SpecRow | null; differs: boolean };
export type CompareSection = { id: string; label: string; rows: CompareRow[] };

/**
 * Lines up two fits' sections by section id and row id: A's order first, then what only B has. A row one
 * side lacks reads as missing and counts as a difference, unless the other side has no sections at all
 * (never evaluated with specs), where marking every row would say nothing.
 */
export function alignSections(a: readonly SpecSection[] | null, b: readonly SpecSection[] | null): CompareSection[] {
  const left = a ?? [];
  const right = b ?? [];
  const both = left.length > 0 && right.length > 0;
  const ids = [...new Set([...left.map((section) => section.id), ...right.map((section) => section.id)])];
  return ids.map((id) => {
    const sa = left.find((section) => section.id === id) ?? null;
    const sb = right.find((section) => section.id === id) ?? null;
    const rowIds = [...new Set([...(sa?.rows ?? []).map((row) => row.id), ...(sb?.rows ?? []).map((row) => row.id)])];
    return {
      id,
      label: sa?.label ?? sb!.label,
      rows: rowIds.map((rowId) => {
        const ra = sa?.rows.find((row) => row.id === rowId) ?? null;
        const rb = sb?.rows.find((row) => row.id === rowId) ?? null;
        const differs = ra && rb ? rowText(ra) !== rowText(rb) : both && (ra !== null || rb !== null);
        return { id: rowId, label: (ra ?? rb)!.label, a: ra, b: rb, differs };
      }),
    };
  });
}

export type ModuleCount = { def: string; name: string; count: number };
export type ModuleRow = { def: string; name: string; a: number; b: number };
export type ModuleDiff = { onlyA: ModuleRow[]; onlyB: ModuleRow[]; both: ModuleRow[] };

/** Distinct modules with how many of each, by name then def. */
export function countModules(defs: readonly string[], nameOf: (def: string) => string): ModuleCount[] {
  const counts = new Map<string, number>();
  for (const def of defs) counts.set(def, (counts.get(def) ?? 0) + 1);
  return [...counts].map(([def, count]) => ({ def, name: nameOf(def), count })).sort(byName);
}

const byName = (x: { name: string; def: string }, y: { name: string; def: string }) => x.name.localeCompare(y.name) || x.def.localeCompare(y.def);

export function diffModules(a: readonly ModuleCount[], b: readonly ModuleCount[]): ModuleDiff {
  const inA = new Map(a.map((module) => [module.def, module]));
  const inB = new Map(b.map((module) => [module.def, module]));
  const rows = [...new Set([...inA.keys(), ...inB.keys()])]
    .map((def): ModuleRow => ({ def, name: (inA.get(def) ?? inB.get(def))!.name, a: inA.get(def)?.count ?? 0, b: inB.get(def)?.count ?? 0 }))
    .sort(byName);
  return { onlyA: rows.filter((row) => row.b === 0), onlyB: rows.filter((row) => row.a === 0), both: rows.filter((row) => row.a > 0 && row.b > 0) };
}
