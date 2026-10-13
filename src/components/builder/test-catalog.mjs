// The recorded catalog for builder tests, plus links the trimmed recording lacks: its artifacts and
// regalia pieces belong to items the trimmed list dropped, so two are re-pointed at TRACER ROUNDS
// (whose rarities already list Artifact and Regalia), one with a scaled stat and a patina cap.
import { FIXTURES } from "../../lib/engine/stub-engine.mjs";

export const SCARAB = "1274722114706556685";
export const SERAPH = "1421202711594240286";
export const itemNamed = (catalog, name) => catalog.items.find((item) => item.name === name);

export function richCatalog() {
  const catalog = structuredClone(FIXTURES.catalog);
  const tracer = itemNamed(catalog, "TRACER ROUNDS");
  const artifact = catalog.artifacts.find((each) => each.scaledStat !== null);
  artifact.item = tracer.def;
  artifact.patinaMax = 2;
  const regalia = catalog.regalia[0];
  regalia.item = tracer.def;
  tracer.roll.artifacts = [artifact.def];
  tracer.roll.regalia = [regalia.def];
  return catalog;
}
