"use client";

// A rolled item's fact rows in the browser: the catalog's rows for its plainest roll at once, then the
// engine's for this roll (lib/engine/item-facts.ts). One loader per engine, shared by the inspector and
// every tooltip on the page, so asks queue together and a 429 holds them all.
import { useEffect, useReducer, useRef, useState } from "react";
import { createEngineClient } from "#/lib/engine/client";
import { createFactsLoader, factsKey, type CatalogFacts, type FactsLoader, type FactsState } from "#/lib/engine/item-facts";
import type { OpenItem } from "#/lib/engine/types";
import { usePublicConfig } from "#/lib/public-config";
import { FactRows } from "./item-text";

/** One loader per engine URL for the page's life, however many clients the components make. */
const loaders = new Map<string | null, FactsLoader>();

function loaderFor(engineUrl: string | null): FactsLoader {
  let loader = loaders.get(engineUrl);
  if (!loader) {
    const engine = createEngineClient({ baseUrl: engineUrl });
    loader = createFactsLoader({ fetchFacts: (item, signal) => engine.itemFacts(item, { signal }) });
    loaders.set(engineUrl, loader);
  }
  return loader;
}

/** The item's facts to show now; asks the engine while `active` and the roll isn't the plainest. */
export function useItemFacts(item: OpenItem | null, catalog: CatalogFacts, active = true): FactsState {
  const loader = loaderFor(usePublicConfig().engineUrl);
  const [, changed] = useReducer((n: number) => n + 1, 0);
  useEffect(() => loader.subscribe(changed), [loader]);
  const key = item ? factsKey(item) : null;
  useEffect(() => {
    if (!item || !active) return;
    loader.request(item, catalog);
    return () => loader.release(item);
    // The key stands for the item: a new object with the same roll asks nothing new.
  }, [loader, key, active, catalog.rarity]);
  return item ? loader.state(item, catalog) : { status: "default", facts: catalog.facts };
}

const NOTES: Record<FactsState["status"], string | null> = {
  default: null,
  ready: null,
  loading: "STANDARD ROLL · CHECKING THIS ROLL",
  refused: "STANDARD ROLL · THE ENGINE CAN'T CHECK THIS ROLL",
  down: "STANDARD ROLL · THE ENGINE ISN'T ANSWERING",
  limited: "STANDARD ROLL · CHECKING PAUSED",
};

/** Facts for the item now, asking about its roll while `active`. */
export function RolledFacts({ item, catalog, active = true }: { item: OpenItem; catalog: CatalogFacts; active?: boolean }) {
  const state = useItemFacts(item, catalog, active);
  // Not asked about yet (a tooltip not opened): the catalog's rows, named for what they are.
  return <FactRows facts={state.facts} note={!active && state.status === "loading" ? "STANDARD ROLL" : NOTES[state.status]} />;
}

/**
 * Facts inside a hover tooltip: asks about the roll only once the tooltip's anchor (the nearest
 * `.tip-anchor`) is hovered or focused, so a page of modules doesn't ask about every one at load.
 */
export function TooltipFacts({ item, catalog }: { item: OpenItem; catalog: CatalogFacts }) {
  const marker = useRef<HTMLSpanElement>(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const anchor = marker.current?.closest(".tip-anchor");
    if (!anchor || opened) return;
    const open = () => setOpened(true);
    anchor.addEventListener("pointerenter", open);
    anchor.addEventListener("focusin", open);
    return () => {
      anchor.removeEventListener("pointerenter", open);
      anchor.removeEventListener("focusin", open);
    };
  }, [opened]);
  return (
    <>
      <span ref={marker} hidden />
      <RolledFacts item={item} catalog={catalog} active={opened} />
    </>
  );
}
