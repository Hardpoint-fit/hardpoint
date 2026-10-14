// Checks types.ts against JSON recorded from the real engine (see __fixtures__): every object must have
// exactly the declared keys, each of the declared kind. Re-record the fixtures when the C# records change.
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
      for (const key of Object.keys(value)) if (!declared.includes(key)) errors.push(`${path}.${key}: the engine sends it, types.ts doesn't declare it`);
      for (const member of node.members) {
        const key = member.name.text;
        if (!(key in value)) {
          if (!member.questionToken) errors.push(`${path}.${key}: declared in types.ts, missing from the engine's JSON`);
        }
        else check(value[key], member.type, `${path}.${key}`, errors, seen);
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

const cases = [
  ["health.json", "HealthResponse"],
  ["catalog.json", "Catalog"],
  ["fit.json", "OpenFit"],
  ["evaluate-valid.json", "EvaluationResponse"],
  ["evaluate-invalid.json", "EvaluationResponse"],
  ["evaluate-showcase.json", "EvaluationResponse"],
  ["evaluate-removed-item.json", "EvaluationResponse"],
  ["fit-showcase.json", "OpenFit"],
  ["fit-removed-item.json", "OpenFit"],
  ["export.json", "FitStringBody"],
  ["import.json", "FitBody"],
  ["error.json", "ErrorBody"],
  ["item-facts-request.json", "ItemBody"],
  ["item-facts.json", "FactsBody"],
  ["grid-mods.json", "GridModsResponse"],
  ["roll-request.json", "RollRequest"],
  ["roll.json", "RollResponse"],
  ["roll-line-request.json", "RollRequest"],
  ["roll-line.json", "RollResponse"],
];
const byName = {
  "health.json": FIXTURES.health,
  "catalog.json": FIXTURES.catalog,
  "fit.json": FIXTURES.fit,
  "evaluate-valid.json": FIXTURES.evaluateValid,
  "evaluate-invalid.json": FIXTURES.evaluateInvalid,
  "evaluate-showcase.json": FIXTURES.evaluateShowcase,
  "evaluate-removed-item.json": FIXTURES.evaluateRemovedItem,
  "fit-showcase.json": FIXTURES.fitShowcase,
  "fit-removed-item.json": FIXTURES.fitRemovedItem,
  "export.json": FIXTURES.exported,
  "import.json": FIXTURES.imported,
  "error.json": FIXTURES.error,
  "item-facts-request.json": FIXTURES.itemFactsRequest,
  "item-facts.json": FIXTURES.itemFacts,
  "grid-mods.json": FIXTURES.gridMods,
  "roll-request.json": FIXTURES.rollRequest,
  "roll.json": FIXTURES.roll,
  "roll-line-request.json": FIXTURES.rollLineRequest,
  "roll-line.json": FIXTURES.rollLine,
};

for (const [file, typeName] of cases) {
  test(`${file} matches ${typeName} in types.ts`, () => {
    assert.deepEqual(conforms(byName[file], typeName).errors, []);
  });
}

test("the fixtures exercise every type in types.ts", () => {
  const covered = new Set();
  for (const [file, typeName] of cases) for (const name of conforms(byName[file], typeName).seen) covered.add(name);
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
