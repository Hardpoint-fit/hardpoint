import "server-only";
import { parseConfig, toPublicConfig, type PublicConfig, type SiteConfig } from "./config";

/** Read per call, never cached at module load: the environment is only known at run time. */
export function getConfig(): SiteConfig {
  return parseConfig(process.env);
}

export function getPublicConfig(): PublicConfig {
  return toPublicConfig(getConfig());
}
