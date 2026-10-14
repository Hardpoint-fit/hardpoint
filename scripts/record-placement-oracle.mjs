// Records the engine's verdicts for single palette drops into src/lib/engine/__fixtures__/placement-oracle.json,
// so placement.test.mjs can check that the builder refuses exactly the drops the engine would. Each case
// is one item at one rotation over a block of anchors on a base fit; `verdicts` holds one letter per
// anchor, row by row: "." the engine took the fit, otherwise the issue it named (see LETTERS).
//
//   node --import ./scripts/node-hooks.mjs scripts/record-placement-oracle.mjs http://localhost:18081
//
// Run it against a local engine on the build the recorded catalog fixture comes from.
import { readFileSync, writeFileSync } from "node:fs";
import { moduleSubject, indexCatalog } from "../src/components/builder/rules.ts";
import { defaultRoll } from "../src/components/builder/roll-edits.ts";
import { newFit } from "../src/components/builder/state.ts";

const LETTERS = { OutOfBounds: "B", DisabledCell: "D", SlotNotFittable: "S", Overlap: "O", MissingHardpoint: "H", TooManyBatteries: "T" };
const ITEMS = ["ARMOR HARDENER", "AUTO VENTING", "OMNI REPAIRER TURRET", "LIGHTFRAME THRUSTERS", "INERTIA COUPLER", "HEATSINK MAGAZINE", "TRACER ROUNDS", "PROPULSION CONDUIT"];

const engine = process.argv[2] ?? "http://localhost:18081";
const fixtures = new URL("../src/lib/engine/__fixtures__/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));
const catalog = read("catalog.json");
const cat = indexCatalog(catalog);
const live = await (await fetch(`${engine}/v1/catalog`)).json();
if (live.buildSha !== catalog.buildSha) throw new Error(`engine runs ${live.buildSha}, the fixture catalog is ${catalog.buildSha}`);

async function evaluate(fit) {
  for (;;) {
    const response = await fetch(`${engine}/v1/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fit }) });
    if (response.status === 429) {
      await new Promise((done) => setTimeout(done, 1000 * Number(response.headers.get("retry-after") ?? 1)));
      continue;
    }
    if (!response.ok) throw new Error(`evaluate: ${response.status}`);
    return response.json();
  }
}

/** The enabled cells' bounds with a one-cell margin, clamped: every anchor a drop could reach. */
function anchors(fit) {
  const hull = cat.hulls.get(fit.hull.def);
  const enabled = hull.slots.flatMap((slot, index) => (slot === "None" ? [] : [{ row: Math.floor(index / hull.cols), col: index % hull.cols }]));
  const rows = [Math.max(0, Math.min(...enabled.map((c) => c.row)) - 1), Math.min(hull.rows - 1, Math.max(...enabled.map((c) => c.row)) + 1)];
  const cols = [Math.max(0, Math.min(...enabled.map((c) => c.col)) - 1), Math.min(hull.cols - 1, Math.max(...enabled.map((c) => c.col)) + 1)];
  return { rows, cols };
}

const bases = [
  { base: "SCARAB", fit: newFit(cat, catalog.hulls.find((hull) => hull.name === "SCARAB").def) },
  { base: "SERAPH", fit: newFit(cat, catalog.hulls.find((hull) => hull.name === "SERAPH").def) },
  { base: "fit.json", fit: read("fit.json") },
];

const cases = [];
for (const { base, fit } of bases) {
  const { rows, cols } = anchors(fit);
  for (const name of ITEMS) {
    const item = catalog.items.find((each) => each.name === name);
    const roll = defaultRoll(moduleSubject(cat, item.def));
    for (let rotation = 0; rotation < 4; rotation++) {
      let verdicts = "";
      for (let row = rows[0]; row <= rows[1]; row++) {
        for (let col = cols[0]; col <= cols[1]; col++) {
          const index = fit.modules.length;
          const response = await evaluate({ ...fit, modules: [...fit.modules, { item: { def: item.def, roll, patina: 0 }, row, col, rotation }] });
          const issue = response.issues.find((each) => each.moduleIndex === index && each.kind in LETTERS);
          const other = response.issues.find((each) => !(each.kind in LETTERS));
          if (other) throw new Error(`${base} ${name} r${rotation} (${row},${col}): ${other.kind} ${other.message}`);
          verdicts += issue ? LETTERS[issue.kind] : ".";
        }
      }
      cases.push({ base, item: item.def, name, rotation, rows, cols, verdicts });
    }
    process.stdout.write(`${base} ${name}\n`);
  }
}

const note = `Engine verdicts (build ${catalog.buildSha.slice(0, 8)}) for one default-roll palette item dropped on each base fit; ` + `verdicts: one letter per anchor row by row, "." accepted, ${Object.entries(LETTERS).map(([kind, letter]) => `${letter} ${kind}`).join(", ")}.`;
writeFileSync(new URL("placement-oracle.json", fixtures), JSON.stringify({ note, cases }, null, 1) + "\n");
