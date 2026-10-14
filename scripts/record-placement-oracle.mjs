// Records the game data API's verdicts for single drops into src/lib/engine/__fixtures__/placement-oracle.json,
// so placement.test.mjs can check that the builder refuses exactly the drops the engine would. Each case
// is one item (with its ports) at one rotation over a block of anchors on a base fit, either dropped from
// the palette (appended) or a fitted module moved there (`moving`); `verdicts` holds one letter per
// anchor, row by row: "." the engine took the fit, otherwise the placement issue it named (see LETTERS).
// The bases are empty hulls (the recorded catalog's two and the extra hulls this file carries from the
// API's /v1/hulls), fit.json (which has a slot override) and fits with ported modules to move.
//
//   node --import ./scripts/node-hooks.mjs scripts/record-placement-oracle.mjs http://localhost:18081
//
// Run it against a local API (the rate limiter exempts it) on the build the fixtures come from
// (scripts/record-fixtures.mjs records them first).
import { readFileSync, writeFileSync } from "node:fs";
import { FIXTURES } from "../src/lib/engine/stub-engine.mjs";
import { applySlotOverrides } from "../src/components/grid/geometry.ts";
import { defaultRoll } from "../src/components/builder/roll-edits.ts";
import { indexCatalog, moduleSubject } from "../src/components/builder/rules.ts";
import { newFit } from "../src/components/builder/state.ts";

const LETTERS = { OutOfBounds: "B", DisabledCell: "D", SlotNotFittable: "S", Overlap: "O", MissingHardpoint: "H", TooManyBatteries: "T" };
const PLAIN = ["ARMOR HARDENER", "AUTO VENTING", "REPAIR PROJECTOR", "LIGHTFRAME THRUSTERS", "INERTIA COUPLER", "HEATSINK MAGAZINE", "TRACER ROUNDS", "PROPULSION CONDUIT"];
/** Hulls from the API's catalog beyond the recorded two: four propulsion hardpoints, four subsystems, five batteries. */
const EXTRA_HULLS = ["JACKAL", "ACOLYTE", "VEKTR"];
const DRUX = "1283267483210613362";
const SYN = "1305220033100729446";
/**
 * Hardpoint items with port rolls: ciphered ports fill a cell beyond the shape (which can land on or off a
 * hardpoint, or off the grid), empty ports fill none.
 */
const PORTED = [
  { name: "ARMOR HARDENER", ports: [{ row: 1, col: 2, direction: "Right", cipher: DRUX }, { row: 3, col: 2, direction: "Left", cipher: null }, { row: 3, col: 2, direction: "Down", cipher: SYN }] },
  { name: "AUTO VENTING", ports: [{ row: 2, col: 2, direction: "Left", cipher: SYN }, { row: 3, col: 2, direction: "Right", cipher: null }] },
  { name: "REPAIR PROJECTOR", ports: [{ row: 2, col: 2, direction: "Up", cipher: DRUX }, { row: 2, col: 2, direction: "Right", cipher: null }] },
  { name: "INERTIA COUPLER", ports: [{ row: 2, col: 2, direction: "Left", cipher: SYN }] },
  { name: "LIGHTFRAME THRUSTERS", ports: [{ row: 3, col: 2, direction: "Down", cipher: DRUX }, { row: 2, col: 2, direction: "Up", cipher: null }] },
];

const engine = process.argv[2] ?? "http://localhost:18081";
const fixtures = new URL("../src/lib/engine/__fixtures__/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));
const recorded = FIXTURES.catalog;
const live = await (await fetch(`${engine}/v1/hulls`)).json();
if (live.build !== recorded.buildSha) throw new Error(`the API runs ${live.build}, the fixture catalog is ${recorded.buildSha}`);
const hulls = EXTRA_HULLS.map((name) => live.hulls.find((hull) => hull.name === name));
const catalog = { ...recorded, hulls: [...recorded.hulls, ...hulls] };
const cat = indexCatalog(catalog);
const itemNamed = (name) => catalog.items.find((item) => item.name === name);

let requests = 0;
async function evaluate(fit) {
  for (;;) {
    requests++;
    const response = await fetch(`${engine}/v1/fits/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fit }) });
    if (response.status === 429) {
      await new Promise((done) => setTimeout(done, 1000 * Number(response.headers.get("retry-after") ?? 1)));
      continue;
    }
    if (!response.ok) throw new Error(`evaluate: ${response.status}`);
    return response.json();
  }
}

/** One letter for a fit: "." valid, else its placement issue. Any other issue means a bad recording. */
async function letter(fit, where) {
  const response = await evaluate(fit);
  const other = response.issues.find((each) => !(each.kind in LETTERS));
  if (other) throw new Error(`${where}: ${other.kind} ${other.message}`);
  return response.issues.length > 0 ? LETTERS[response.issues[0].kind] : ".";
}

/** The enabled cells' bounds (slot overrides applied) with a one-cell margin, clamped. */
function anchors(fit) {
  const hull = cat.hulls.get(fit.hull.def);
  const slots = applySlotOverrides(hull.slots, fit.slotOverrides);
  const enabled = slots.flatMap((slot, index) => (slot === "None" ? [] : [{ row: Math.floor(index / hull.cols), col: index % hull.cols }]));
  const rows = [Math.max(0, Math.min(...enabled.map((c) => c.row)) - 1), Math.min(hull.rows - 1, Math.max(...enabled.map((c) => c.row)) + 1)];
  const cols = [Math.max(0, Math.min(...enabled.map((c) => c.col)) - 1), Math.min(hull.cols - 1, Math.max(...enabled.map((c) => c.col)) + 1)];
  return { rows, cols };
}

const rollWith = (def, ports = []) => ({ ...defaultRoll(moduleSubject(cat, def)), ports });

/** Runs `count` jobs with a few in flight; results in order. */
async function pool(jobs, width = 6) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]();
    }
  }));
  return results;
}

async function recordCase(base, fit, { def, ports, moving = null, rotation }) {
  const { rows, cols } = anchors(fit);
  const jobs = [];
  for (let row = rows[0]; row <= rows[1]; row++) {
    for (let col = cols[0]; col <= cols[1]; col++) {
      const placed =
        moving === null
          ? { ...fit, modules: [...fit.modules, { item: { def, roll: rollWith(def, ports), patina: 0 }, row, col, rotation }] }
          : { ...fit, modules: fit.modules.map((module, index) => (index === moving ? { ...module, row, col, rotation } : module)) };
      jobs.push(() => letter(placed, `${base} ${def} r${rotation} (${row},${col})`));
    }
  }
  const verdicts = (await pool(jobs)).join("");
  return { base, item: def, name: cat.items.get(def).name, ports, moving, rotation, rows, cols, verdicts };
}

const empty = (name) => newFit(cat, catalog.hulls.find((hull) => hull.name === name).def);

/** A base for moving a ported module: the hull with `name` placed where the engine first takes it. */
async function withPlaced(fit, spec) {
  const def = itemNamed(spec.name).def;
  for (let rotation = 0; rotation < 4; rotation++)
    for (let row = 0; row < 15; row++)
      for (let col = 0; col < 15; col++) {
        const placed = { ...fit, modules: [...fit.modules, { item: { def, roll: rollWith(def, spec.ports), patina: 0 }, row, col, rotation }] };
        if ((await letter(placed, "base")) === ".") return placed;
      }
  throw new Error(`${spec.name} fits nowhere`);
}

const bases = {
  SCARAB: empty("SCARAB"),
  SERAPH: empty("SERAPH"),
  "fit.json": read("fit.json"),
  ...Object.fromEntries(EXTRA_HULLS.map((name) => [name, empty(name)])),
};
const movable = {
  "SCARAB with a ported ARMOR HARDENER": await withPlaced(empty("SCARAB"), PORTED[0]),
  "ACOLYTE with a ported REPAIR PROJECTOR": await withPlaced(empty("ACOLYTE"), PORTED[2]),
  "fit-showcase.json": read("fit-showcase.json"),
};

const cases = [];
for (const [base, fit] of Object.entries(bases)) {
  const plain = base === "SCARAB" || base === "SERAPH" || base === "fit.json" ? PLAIN : ["ARMOR HARDENER", "REPAIR PROJECTOR", "INERTIA COUPLER", "HEATSINK MAGAZINE"];
  const drops = [...plain.map((name) => ({ def: itemNamed(name).def, ports: [] })), ...PORTED.map((spec) => ({ def: itemNamed(spec.name).def, ports: spec.ports }))];
  for (const drop of drops) {
    for (let rotation = 0; rotation < 4; rotation++) cases.push(await recordCase(base, fit, { ...drop, rotation }));
    process.stdout.write(`${base} ${cat.items.get(drop.def).name}${drop.ports.length ? " (ported)" : ""} ${requests}\n`);
  }
}
for (const [base, fit] of Object.entries(movable)) {
  const moving = base === "fit-showcase.json" ? fit.modules.findIndex((module) => module.item.roll.ports.some((port) => port.cipher !== null)) : fit.modules.length - 1;
  const module = fit.modules[moving];
  for (let rotation = 0; rotation < 4; rotation++) cases.push(await recordCase(base, fit, { def: module.item.def, ports: module.item.roll.ports, moving, rotation }));
  process.stdout.write(`${base} moving ${moving} ${requests}\n`);
}

const note =
  `API verdicts (build ${recorded.buildSha.slice(0, 8)}) for single drops: an item (default roll with \`ports\`) dropped on a base fit, or the fit's module \`moving\` moved, ` +
  `at each anchor of the block; verdicts: one letter per anchor row by row, "." accepted, ${Object.entries(LETTERS).map(([kind, l]) => `${l} ${kind}`).join(", ")}. ` +
  "`hulls` are the API's hulls beyond the fixture catalog's; `bases` the fits moved from.";
writeFileSync(new URL("placement-oracle.json", fixtures), JSON.stringify({ note, hulls, bases: movable, cases }) + "\n");
