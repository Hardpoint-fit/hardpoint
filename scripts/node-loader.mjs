// Module hooks that let `node --test` load the app's components the way Next does: the `#/` alias,
// extensionless imports, .tsx (compiled with the TypeScript compiler the app already has), JSON, and
// CSS imports (empty). `server-only` resolves to an empty module so server code can be tested.
// Registered (synchronously, in-thread) by node-hooks.mjs; see package.json "test".
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const src = resolvePath(dirname(fileURLToPath(import.meta.url)), "../src");
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".json"];
const EMPTY = "data:text/javascript,export {};";

function probe(path) {
  if (existsSync(path) && statSync(path).isFile()) return path;
  for (const extension of EXTENSIONS) if (existsSync(path + extension)) return path + extension;
  for (const extension of EXTENSIONS) if (existsSync(`${path}/index${extension}`)) return `${path}/index${extension}`;
  return null;
}

export function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: EMPTY, shortCircuit: true };
  if (specifier.endsWith(".css")) return { url: EMPTY, shortCircuit: true };
  const base = specifier.startsWith("#/")
    ? resolvePath(src, specifier.slice(2))
    : (specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")
      ? resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)
      : null;
  if (base !== null) {
    const found = probe(base);
    if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
  }
  try {
    return next(specifier, context);
  } catch (error) {
    // Next's subpaths ("next/link") have no exports map; the bundler adds ".js", so do the same.
    if (error?.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith("next/")) return next(`${specifier}.js`, context);
    throw error;
  }
}

export function load(url, context, next) {
  if (url.endsWith(".tsx")) {
    const source = readFileSync(fileURLToPath(url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: false,
        rewriteRelativeImportExtensions: false,
      },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  if (url.endsWith(".json") && context.importAttributes?.type !== "json") {
    const source = readFileSync(fileURLToPath(url), "utf8");
    return { format: "module", source: `export default ${source};`, shortCircuit: true };
  }
  return next(url, context);
}
