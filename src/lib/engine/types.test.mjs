// Checks types.ts against JSON recorded from the real game data API (see __fixtures__): every object must
// have exactly the declared keys (an optional one may be missing), each of the declared kind. Re-record the
// fixtures (scripts/record-fixtures.mjs) when the API's contract changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { FIXTURES } from "./stub-engine.mjs";

const source = ts.createSourceFile("types.ts", readFileSync(new URL("./types.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const aliases = new Map();
for (const statement of source.statements) {
  if (ts.isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement.type);
}

/** Collects mismatches between `value` and a type node as readable paths. */
function check(value, node, path, errors, seen) {
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return typeof value === "string" || errors.push(`${path}: expected string, got ${JSON.stringify(value)}`);
    case ts.SyntaxKind.NumberKeyword:
      return typeof value === "number" || errors.push(`${path}: expected number, got ${JSON.stringify(value)}`);
    case ts.SyntaxKind.BooleanKeyword:
      return typeof value === "boolean" || errors.push(`${path}: expected boolean, got ${JSON.stringify(value)}`);
    case ts.SyntaxKind.LiteralType:
      return value === null || errors.push(`${path}: expected null, got ${JSON.stringify(value)}`);
    case ts.SyntaxKind.ParenthesizedType:
      return check(value, node.type, path, errors, seen);
    case ts.SyntaxKind.UnionType: {
      const attempts = node.types.map((member) => {
        const local = [];
        check(value, member, path, local, seen);
        return local;
      });
      if (!attempts.some((local) => local.length === 0)) errors.push(...attempts.reduce((a, b) => (a.length <= b.length ? a : b)));
      return;
    }
    case ts.SyntaxKind.ArrayType: {
      if (!Array.isArray(value)) return errors.push(`${path}: expected array, got ${JSON.stringify(value)}`);
      value.forEach((item, i) => check(item, node.elementType, `${path}[${i}]`, errors, seen));
      return;
    }
    case ts.SyntaxKind.TypeReference: {
      const name = node.typeName.text;
      // A map: Record<string, V>, every value a V.
      if (name === "Record" && node.typeArguments?.[0]?.kind === ts.SyntaxKind.StringKeyword) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return errors.push(`${path}: expected object, got ${JSON.stringify(value)?.slice(0, 40)}`);
        }
        for (const [key, each] of Object.entries(value)) check(each, node.typeArguments[1], `${path}.${key}`, errors, seen);
        return;
      }
      const target = aliases.get(name);
      if (!target) return errors.push(`${path}: types.ts has no type ${name}`);
      seen?.add(name);
      return check(value, target, path, errors, seen);
    }
    case ts.SyntaxKind.IntersectionType:
      return node.types.forEach((member) => check(value, member, path, errors, seen));
    case ts.SyntaxKind.TypeLiteral: {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return errors.push(`${path}: expected object, got ${JSON.stringify(value)?.slice(0, 40)}`);
      }
      const declared = node.members.map((m) => m.name.text);
      for (const key of Object.keys(value)) if (!declared.includes(key)) errors.push(`${path}.${key}: the API sends it, types.ts doesn't declare it`);
      for (const member of node.members) {
        const key = member.name.text;
        if (!(key in value)) {
          if (!member.questionToken) errors.push(`${path}.${key}: declared in types.ts, missing from the API's JSON`);
        } else check(value[key], member.type, `${path}.${key}`, errors, seen);
      }
      return;
    }
    default:
      return errors.push(`${path}: the checker doesn't handle ${ts.SyntaxKind[node.kind]}`);
  }
}

function conforms(value, typeName) {
  const errors = [];
  const seen = new Set();
  check(value, { kind: ts.SyntaxKind.TypeReference, typeName: { text: typeName } }, typeName, errors, seen);
  return { errors, seen };
}

// Each recorded response and the type that describes it. The catalog fixture is the site's assembly of
// the resource fixtures (catalog-resources.ts), which must also fit its own type.
const cases = [
  ["status.json", "StatusResponse", FIXTURES.status],
  ["items.json", "ItemsBody", FIXTURES.parts.items],
  ["hulls.json", "HullsBody", FIXTURES.parts.hulls],
  ["ciphers.json", "CiphersBody", FIXTURES.parts.ciphers],
  ["artifacts.json", "ArtifactsBody", FIXTURES.parts.artifacts],
  ["regalia-sets.json", "RegaliaSetsBody", FIXTURES.parts.regaliaSets],
  ["affinity.json", "AffinityBody", FIXTURES.parts.affinity],
  ["regalia.json", "RegaliaBody", FIXTURES.parts.regalia],
  ["heretical-specials.json", "HereticalSpecialsBody", FIXTURES.parts.hereticalSpecials],
  ["harmonic-sets.json", "HarmonicSetsBody", FIXTURES.parts.harmonicSets],
  ["modifier-pools.json", "ModifierPoolsBody", FIXTURES.parts.modifierPools],
  ["qualities.json", "QualitiesBody", FIXTURES.parts.qualities],
  ["placement-rules.json", "PlacementRulesBody", FIXTURES.parts.placementRules],
  ["grid-consumables.json", "GridConsumablesBody", FIXTURES.parts.gridConsumables],
  ["breach-tiers.json", "BreachTiersBody", FIXTURES.parts.breachTiers],
  ["stats.json", "StatsBody", FIXTURES.parts.stats],
  ["fitting-grid-style.json", "FittingGridStyleBody", FIXTURES.parts.fittingGridStyle],
  ["the assembled catalog", "Catalog", FIXTURES.catalog],
  ["fit.json", "OpenFit", FIXTURES.fit],
  ["evaluate-valid.json", "EvaluationResponse", FIXTURES.evaluateValid],
  ["evaluate-invalid.json", "EvaluationResponse", FIXTURES.evaluateInvalid],
  ["evaluate-showcase.json", "EvaluationResponse", FIXTURES.evaluateShowcase],
  ["evaluate-removed-item.json", "EvaluationResponse", FIXTURES.evaluateRemovedItem],
  ["fit-showcase.json", "OpenFit", FIXTURES.fitShowcase],
  ["fit-removed-item.json", "OpenFit", FIXTURES.fitRemovedItem],
  ["export.json", "FitStringBody", FIXTURES.exported],
  ["import.json", "FitBody", FIXTURES.imported],
  ["error.json", "ErrorBody", FIXTURES.error],
  ["item-facts-request.json", "ItemBody", FIXTURES.itemFactsRequest],
  ["item-facts.json", "FactsBody", FIXTURES.itemFacts],
  ["grid-mods.json", "GridModsResponse", FIXTURES.gridMods],
  ["roll-request.json", "RollRequest", FIXTURES.rollRequest],
  ["roll.json", "RollResponse", FIXTURES.roll],
  ["roll-line-request.json", "RollRequest", FIXTURES.rollLineRequest],
  ["roll-line.json", "RollResponse", FIXTURES.rollLine],
];

for (const [file, typeName, value] of cases) {
  test(`${file} matches ${typeName} in types.ts`, () => {
    assert.deepEqual(conforms(value, typeName).errors, []);
  });
}

test("the fixtures exercise every type in types.ts", () => {
  const covered = new Set();
  for (const [, typeName, value] of cases) for (const name of conforms(value, typeName).seen) covered.add(name);
  // A type no fixture reaches (an empty array, a null) would be checked by nothing.
  assert.deepEqual([...aliases.keys()].filter((name) => !covered.has(name)), []);
});

test("the checker bites: an extra, a missing and a mistyped field are all reported", () => {
  const extra = structuredClone(FIXTURES.evaluateValid);
  extra.surprise = 1;
  assert.match(conforms(extra, "EvaluationResponse").errors.join("\n"), /surprise/);
  const missing = structuredClone(FIXTURES.evaluateValid);
  delete missing.rating;
  assert.match(conforms(missing, "EvaluationResponse").errors.join("\n"), /rating/);
  const mistyped = structuredClone(FIXTURES.catalog);
  mistyped.hulls[0].rows = "15";
  assert.match(conforms(mistyped, "Catalog").errors.join("\n"), /rows/);
  const nested = structuredClone(FIXTURES.fit);
  nested.modules[0].item.roll.rolledPointRating = 5;
  assert.match(conforms(nested, "OpenFit").errors.join("\n"), /rolledPointRating/);
});
