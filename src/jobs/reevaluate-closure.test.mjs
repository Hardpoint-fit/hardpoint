// The image copies the job's files by hand (Dockerfile). This walks the job's runtime imports from
// source and fails if one isn't in those COPY lines, so the cron can't ship with ERR_MODULE_NOT_FOUND.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = "src/jobs/reevaluate.ts";

/** Relative runtime imports of a file; type-only imports and exports are erased and need no file. */
export function runtimeImports(source) {
  const found = [];
  const statement = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gms;
  for (const m of source.matchAll(statement)) {
    if (m[2]) continue;
    const specifier = m[4] ?? m[5];
    if (specifier.startsWith(".")) found.push(specifier);
  }
  for (const m of source.matchAll(/\bimport\(\s*["'](\.[^"']+)["']\s*\)/g)) found.push(m[1]);
  return found;
}

function closure() {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of runtimeImports(readFileSync(join(root, file), "utf8"))) {
      const target = relative(root, resolve(root, dirname(file), specifier));
      assert.ok(existsSync(join(root, target)), `${file} imports ${specifier}, which must be an explicit existing path`);
      visit(target);
    }
  };
  visit(ENTRY);
  return [...seen].sort();
}

/** Files the Dockerfile's `COPY --from=build` lines put under src/, relative to the app root. */
function copied() {
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8").replace(/\\\n/g, " ");
  const files = new Set();
  for (const line of dockerfile.split("\n")) {
    if (!line.startsWith("COPY --from=build")) continue;
    const parts = line.split(/\s+/).slice(2).filter((part) => !part.startsWith("--"));
    const dest = parts.pop();
    for (const source of parts) {
      const local = source.replace("/repo/js/projects/theorycrafting/", "");
      if (!local.startsWith("src/") || !local.endsWith(".ts")) continue;
      files.add(join(dest.replace(/^\.\//, ""), local.split("/").pop()));
    }
  }
  return files;
}

test("the import closure walker ignores type-only imports and finds runtime ones", () => {
  const found = runtimeImports(`import type { A } from "./a.ts";\nimport { b, type C } from "./b.ts";\nexport { d } from "./d.ts";\nexport type { E } from "./e.ts";\nimport pg from "pg";\nimport {\n  f,\n} from "./f.ts";`);
  assert.deepEqual(found, ["./b.ts", "./d.ts", "./f.ts"]);
});

test("every file the job loads at run time is copied into the image", () => {
  const inImage = copied();
  const missing = closure().filter((file) => !inImage.has(file));
  assert.deepEqual(missing, [], `add to the job COPY lines in the Dockerfile: ${missing.join(", ")}`);
});
