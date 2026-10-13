// `node --import ./scripts/node-hooks.mjs --test`: installs node-loader.mjs before any test file loads.
import { registerHooks } from "node:module";
import { load, resolve } from "./node-loader.mjs";

registerHooks({ resolve, load });
