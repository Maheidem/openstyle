import { prepareCached } from "./db.js";
import { LOCAL_STT_PROVIDERS } from "./streaming/local-providers.js";

export function getApiKey(providerId: string): string | null {
  // On-device engines need no key.
  if (LOCAL_STT_PROVIDERS.has(providerId)) return "local";
  const row = prepareCached("SELECT key FROM api_keys WHERE provider = ?").get(
    providerId,
  ) as { key: string } | undefined;
  return row?.key ?? null;
}
