"use client";

import { useMemo } from "react";
import { usePublicConfig } from "../public-config";
import { createEngineClient, type EngineClient } from "./client.ts";

/** The game data API as the browser reaches it (the public URL the server rendered into the page). */
export function useEngine(): EngineClient {
  const { apiUrl } = usePublicConfig();
  return useMemo(() => createEngineClient({ baseUrl: apiUrl }), [apiUrl]);
}
