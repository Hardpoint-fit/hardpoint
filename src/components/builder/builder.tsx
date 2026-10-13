"use client";

// The builder page's client root: loads the catalog the server holds (/api/catalog), then hands it to
// the workspace. Everything below works in the browser alone; only saving and the engine calls leave it.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Catalog } from "#/lib/engine/types";
import type { BuilderStart } from "#/lib/site/loaders";
import { Panel } from "#/components/ui";
import { indexCatalog } from "./rules";
import type { BuilderAuth } from "./fit-details";
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
  return <Workspace cat={cat} start={start} auth={auth} navigate={router} />;
}
