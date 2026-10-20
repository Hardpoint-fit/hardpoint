"use client";

// Keeps a shown tooltip on screen. CSS opens a .tip beside its .tip-anchor on hover or focus, which can run
// past the window's edge (a tall module tooltip off a low module). When one opens, this shifts it back by
// the overflow, top and left edges winning when it is larger than the window. One listener for the whole
// site, so the grid and the stats tables stay server-rendered.
import { useEffect } from "react";

const MARGIN = 8;

/** How far to move a box from `start` to `end` along one axis so it fits in `[0, size]` with a margin. */
export function shiftInto(start: number, end: number, size: number): number {
  let shift = 0;
  if (end > size - MARGIN) shift = size - MARGIN - end;
  if (start + shift < MARGIN) shift = MARGIN - start;
  return shift;
}

function place(event: Event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest(".tip-anchor");
  const tip = anchor?.querySelector<HTMLElement>(":scope > .tip");
  if (!tip) return;
  // The :hover or :focus style shows it before the event arrives, so it can be measured now; if it isn't
  // shown yet, try again on the next frame.
  if (!fit(tip)) requestAnimationFrame(() => fit(tip));
}

/** Shifts a shown tip into the window. The box is measured without the shift already applied, so moving
 * across the module's own cells leaves a placed tip still. False when the tip isn't shown. */
function fit(tip: HTMLElement): boolean {
  const box = tip.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return false;
  const [dx = 0, dy = 0] = tip.style.translate.split(" ").map((part) => parseFloat(part) || 0);
  const x = shiftInto(box.left - dx, box.right - dx, document.documentElement.clientWidth);
  const y = shiftInto(box.top - dy, box.bottom - dy, window.innerHeight);
  const next = x !== 0 || y !== 0 ? `${x}px ${y}px` : "";
  if (tip.style.translate !== next) tip.style.translate = next;
  return true;
}

export function TipPlacement() {
  useEffect(() => {
    document.addEventListener("pointerover", place);
    document.addEventListener("focusin", place);
    return () => {
      document.removeEventListener("pointerover", place);
      document.removeEventListener("focusin", place);
    };
  }, []);
  return null;
}
