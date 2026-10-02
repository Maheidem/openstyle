import { z } from "zod/v3";

/**
 * Shared URL rule for optional endpoint settings. An empty value is valid
 * and means "disabled". Any other value must parse as a URL with one of the
 * listed protocols (for example `["http:", "https:"]`).
 * Package-internal: the package index does not export it.
 */
export function httpUrlOrEmpty(protocols: readonly string[], message: string) {
  return z
    .string()
    .max(2048)
    .refine(
      (value) => {
        if (value.trim() === "") return true;
        try {
          return protocols.includes(new URL(value.trim()).protocol);
        } catch {
          return false;
        }
      },
      { message },
    );
}
