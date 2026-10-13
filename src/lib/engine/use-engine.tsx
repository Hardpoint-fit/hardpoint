"use client";

import { useMemo } from "react";
import { usePublicConfig } from "../public-config";
import { createEngineClient, type EngineClient } from "./client.ts";

/** The engine as the browser reaches it (the public URL the server rendered into the page). */
export function useEngine(): EngineClient {
  const { engineUrl } = usePublicConfig();
  return useMemo(() => createEngineClient({ baseUrl: engineUrl }), [engineUrl]);
}
