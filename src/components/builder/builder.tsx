"use client";

// The builder page's client root: loads the catalog the server holds (/api/catalog), then hands it to
// the workspace. Everything below works in the browser alone; only saving and the engine calls leave it.
import { useRouter } from "next/navigation";
import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Catalog } from "#/lib/engine/types";
import type { BuilderStart } from "#/lib/site/loaders";
import { Panel } from "#/components/ui";
import { browserStorage, clearDraft, draftSlot } from "./draft-storage";
import { indexCatalog } from "./rules";
import type { BuilderAuth } from "./fit-details";
import { inPlaceNavigate } from "./save-flow";
import { Workspace } from "./workspace";
import "./builder.css";

type Loaded = { status: "loading" } | { status: "ready"; catalog: Catalog } | { status: "failed"; message: string };

export function Builder({ start, auth }: { start: BuilderStart; auth: BuilderAuth }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const router = useRouter();

  const load = useCallback(async () => {
    setLoaded({ status: "loading" });
    try {
      const response = await fetch("/api/catalog", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(String(response.status));
      setLoaded({ status: "ready", catalog: (await response.json()) as Catalog });
    } catch {
      setLoaded({ status: "failed", message: "THE BUILDER NEEDS THE LOADOUT ENGINE'S CATALOG, AND THE SITE HASN'T GOT ONE YET." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cat = useMemo(() => (loaded.status === "ready" ? indexCatalog(loaded.catalog) : null), [loaded]);

  if (!cat) {
    return (
      <main className="page">
        <Panel title="FIT BUILDER">
          <div className="empty-state" role="status">
            {loaded.status === "failed" ? (
              <>
                <span>{loaded.message}</span>
                <span className="note">IT ARRIVES WITH THE LOADOUT ENGINE. TRY AGAIN IN A MOMENT.</span>
                <button type="button" className="btn" onClick={() => void load()}>
                  TRY AGAIN
                </button>
              </>
            ) : (
              <span>LOADING THE CATALOG</span>
            )}
          </div>
        </Panel>
      </main>
    );
  }
  return (
    <DraftGuard start={start}>
      <Workspace cat={cat} start={start} auth={auth} navigate={inPlaceNavigate(router, window.history)} />
    </DraftGuard>
  );
}

/**
 * If the workspace fails to render (a saved draft this build can't draw, say), the draft that caused it
 * is dropped and the builder offers to start again, rather than the page staying broken on every visit.
 */
class DraftGuard extends Component<{ start: BuilderStart; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    const { start } = this.props;
    const storage = browserStorage();
    clearDraft(storage, draftSlot(start.fitId, start.copiedFrom?.id ?? null));
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="page">
        <Panel title="FIT BUILDER">
          <div className="empty-state" role="alert">
            <span>THE BUILDER COULDN&apos;T OPEN THIS FIT. THE CHANGES KEPT IN THIS BROWSER WERE DROPPED.</span>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              START AGAIN
            </button>
          </div>
        </Panel>
      </main>
    );
  }
}
