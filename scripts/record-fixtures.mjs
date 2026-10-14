// Records src/lib/engine/__fixtures__ from a live game data API, so the tests and the stub run on real
// responses. The resource fixtures are the API's routes cut down to the entries the tests use (the whole
// catalog is 800 KB); the verdict fixtures are the API's answers to the fits kept beside them.
//
//   node scripts/record-fixtures.mjs https://api.thecitadel.com
//
// Inputs kept by hand (not recorded): fit.json, fit-showcase.json, fit-removed-item.json,
// item-facts-request.json (roll-request.json and roll-line-request.json are built here from fit.json and
// the roll it gets). Everything else in __fixtures__ except placement-oracle.json (see
// record-placement-oracle.mjs, which needs the fixtures this writes) is written here. The API must serve
// one build for the whole run.
import { readFileSync, writeFileSync } from "node:fs";

const api = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!api) throw new Error("Usage: node scripts/record-fixtures.mjs <API base URL>");
const dir = new URL("../src/lib/engine/__fixtures__/", import.meta.url);
const input = (name) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
const write = (name, value) => writeFileSync(new URL(name, dir), JSON.stringify(value, null, 1) + "\n");

// What the tests use, by name (items, hulls) or by def. Items and hulls are named because defs of a
// rebuilt game differ less than names do; the rest were picked by def.
const ITEM_NAMES = [
  "COOLANT RESERVOIR", "SURVEY SCANNER", "REPAIR PROJECTOR", "AUTO VENTING", "ARMOR HARDENER", "LIGHTFRAME THRUSTERS", "INCENDIARY SALVO",
  "SLIP COATING", "TRACER ROUNDS", "BARRIER RACK", "PROPULSION CONDUIT", "INERTIA COUPLER", "HEATSINK MAGAZINE",
];
const HULL_NAMES = ["SCARAB", "SERAPH"];
const DEFS = {
  ciphers: ["1283267483210613362", "1305220033100729446"],
  artifacts: ["275107089619583858", "278460097613111756", "358841703442488635", "522214128622278413"],
  regaliaSets: ["271759098196484334", "271842034956224520"],
  regalia: ["270456803905027437", "272157818179065936"],
  hereticalSpecials: ["268945908987856069", "271857800551874815"],
  harmonicSets: ["328586449861078631", "355563483137070958"],
};
const POOL_TYPES = ["Utility", "Shield"];

/** A request with the identifying User-Agent the API asks for, waiting out its 429s. */
async function call(method, path, body) {
  for (;;) {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: { "user-agent": "hardpoint.fit-fixtures (martino)", accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429) {
      await new Promise((done) => setTimeout(done, 1000 * Number(response.headers.get("retry-after") ?? 1)));
      continue;
    }
    return { status: response.status, json: await response.json() };
  }
}
async function get(path) {
  const { status, json } = await call("GET", path);
  if (status !== 200) throw new Error(`GET ${path}: ${status}`);
  return json;
}
async function post(path, body, expected = 200) {
  const { status, json } = await call("POST", path, body);
  if (status !== expected) throw new Error(`POST ${path}: ${status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

// ---- The resource routes, cut down ----------------------------------------------------------------

const status = await get("/v1/status");
const routes = {
  items: ["/v1/items", "items"],
  hulls: ["/v1/hulls", "hulls"],
  ciphers: ["/v1/ciphers", "ciphers"],
  artifacts: ["/v1/artifacts", "artifacts"],
  "regalia-sets": ["/v1/regalia-sets", "regaliaSets"],
  affinity: ["/v1/affinity", "affinity"],
  regalia: ["/v1/regalia", "regalia"],
  "heretical-specials": ["/v1/heretical-specials", "hereticalSpecials"],
  "harmonic-sets": ["/v1/harmonic-sets", "harmonicSets"],
  "modifier-pools": ["/v1/modifier-pools", "modifierPools"],
  qualities: ["/v1/qualities", "qualities"],
  "placement-rules": ["/v1/placement-rules", "placementRules"],
  "grid-consumables": ["/v1/grid-consumables", "gridConsumables"],
  "breach-tiers": ["/v1/breach-tiers", "breachTiers"],
};
const live = {};
for (const [name, [path]] of Object.entries(routes)) live[name] = await get(path);
for (const [name, body] of Object.entries(live)) {
  if (body.build !== status.build) throw new Error(`${name} is build ${body.build}, status says ${status.build}: the API deployed mid-run, run again`);
}

const named = (list, names, what) =>
  names.map((name) => {
    const found = list.filter((entry) => entry.name === name);
    if (found.length !== 1) throw new Error(`${what} ${name}: ${found.length} matches in the live build`);
    return found[0];
  });
const byDef = (list, defs, what) =>
  defs.map((def) => list.find((entry) => entry.def === def) ?? (() => { throw new Error(`${what} ${def} is not in the live build`); })());

// Items, hulls, ciphers and artifacts carried the Unity asset `path` until the API hid it; drop it so a
// recording from an API that still sends it matches one from an API that doesn't.
const withoutPath = (entries) => entries.map(({ path, ...rest }) => rest);

const cut = {
  items: { build: status.build, items: withoutPath(named(live.items.items, ITEM_NAMES, "item")) },
  hulls: { build: status.build, hulls: withoutPath(named(live.hulls.hulls, HULL_NAMES, "hull")) },
  ciphers: { build: status.build, ciphers: withoutPath(byDef(live.ciphers.ciphers, DEFS.ciphers, "cipher")) },
  artifacts: { build: status.build, artifacts: withoutPath(byDef(live.artifacts.artifacts, DEFS.artifacts, "artifact")) },
  "regalia-sets": { build: status.build, regaliaSets: byDef(live["regalia-sets"].regaliaSets, DEFS.regaliaSets, "regalia set") },
  affinity: live.affinity,
  regalia: { build: status.build, regalia: byDef(live.regalia.regalia, DEFS.regalia, "regalia") },
  "heretical-specials": { build: status.build, hereticalSpecials: byDef(live["heretical-specials"].hereticalSpecials, DEFS.hereticalSpecials, "heretical special") },
  "harmonic-sets": { build: status.build, harmonicSets: byDef(live["harmonic-sets"].harmonicSets, DEFS.harmonicSets, "harmonic set") },
  "modifier-pools": { build: status.build, modifierPools: POOL_TYPES.map((type) => live["modifier-pools"].modifierPools.find((pool) => pool.moduleType === type) ?? (() => { throw new Error(`pool ${type}`); })()) },
  qualities: live.qualities,
  "placement-rules": live["placement-rules"],
  "grid-consumables": live["grid-consumables"],
  "breach-tiers": live["breach-tiers"],
};
write("status.json", status);
for (const [name, body] of Object.entries(cut)) write(`${name}.json`, body);

// ---- The tools' answers ---------------------------------------------------------------------------

const fit = input("fit.json");
const evaluate = (f) => post("/v1/fits/evaluate", { fit: f });
write("evaluate-valid.json", await evaluate(fit));
write("evaluate-showcase.json", await evaluate(input("fit-showcase.json")));
write("evaluate-removed-item.json", await evaluate(input("fit-removed-item.json")));
write("evaluate-invalid.json", await evaluate({ ...fit, modules: [...fit.modules, fit.modules[0]] }));

const exported = await post("/v1/fits/export", { fit });
write("export.json", exported);
write("import.json", await post("/v1/fits/import", { fitString: exported.fitString }));
write("error.json", (await call("POST", "/v1/fits/import", { fitString: "nonsense" })).json);
write("item-facts.json", await post("/v1/items/facts", input("item-facts-request.json")));
write("grid-mods.json", await post("/v1/grid-mods", { fit }));

// fit.json's Augmented module rolled at seed 42, then that roll's line 0 rolled again at tier 3, seed 7.
const augmented = fit.modules.find((module) => module.item.roll.rarity === "Augmented");
if (!augmented) throw new Error("fit.json has no Augmented module to roll");
const rollRequest = { item: augmented.item, seed: 42 };
const rolled = await post("/v1/roll", rollRequest);
const rollLineRequest = { item: rolled.item, breachTier: 3, seed: 7, line: 0 };
write("roll-request.json", rollRequest);
write("roll.json", rolled);
write("roll-line-request.json", rollLineRequest);
write("roll-line.json", await post("/v1/roll", rollLineRequest));

// fit-showcase.json with module 5 turned to each rotation (two overlap the cipher's cell).
const showcase = input("fit-showcase.json");
const cases = [];
for (let rotation = 0; rotation < 4; rotation++) {
  const turned = { ...showcase, modules: showcase.modules.map((module, index) => (index === 5 ? { ...module, rotation } : module)) };
  const { valid, issues } = await evaluate(turned);
  cases.push({ moduleIndex: 5, rotation, valid, issues });
}
write("rotation-oracle.json", { note: `API verdicts (build ${status.build.slice(0, 8)}) for fit-showcase.json with module 5 turned to each rotation.`, cases });

console.log(`recorded build ${status.build.slice(0, 10)} from ${api}`);
