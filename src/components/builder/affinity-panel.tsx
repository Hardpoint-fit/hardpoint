// The builder's affinity panel: the shared panel (components/affinity) made editable, with the open type
// held here and every control dispatching to the builder's state.
import { useState, type Dispatch } from "react";
import type { OpenProgression } from "#/lib/engine/types";
import { AffinityPanel as SharedAffinityPanel } from "#/components/affinity/affinity-panel";
import type { BuilderCatalog } from "./rules";
import type { BuilderAction } from "./state";

export function AffinityPanel({ cat, progression, dispatch }: { cat: BuilderCatalog; progression: OpenProgression; dispatch: Dispatch<BuilderAction> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <SharedAffinityPanel
      affinity={cat.catalog.affinity}
      progression={progression}
      editor={{
        open,
        onToggle: (moduleType) => setOpen(open === moduleType ? null : moduleType),
        onLevel: (level) => dispatch({ type: "level", level }),
        onAllocate: (moduleType, option, delta) => dispatch({ type: "allocate", moduleType, option, delta }),
        onThreshold: (moduleType, tier, choice) => dispatch({ type: "threshold", moduleType, tier, choice }),
      }}
    />
  );
}
