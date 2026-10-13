"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PublicConfig } from "./config";

const PublicConfigContext = createContext<PublicConfig | null>(null);

/** Receives the config the server read for this request, so no value is baked in at build time. */
export function PublicConfigProvider({ config, children }: { config: PublicConfig; children: ReactNode }) {
  return <PublicConfigContext.Provider value={config}>{children}</PublicConfigContext.Provider>;
}

export function usePublicConfig(): PublicConfig {
  const config = useContext(PublicConfigContext);
  if (!config) throw new Error("usePublicConfig needs PublicConfigProvider");
  return config;
}
