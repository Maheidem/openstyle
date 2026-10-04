import type { Context } from "hono";
import { RemixTransformError } from "../../lib/remix-transform.js";

/**
 * The JSON error for a failed remix. Both remix lanes use it. A setup problem
 * is the user's to fix and gets 400. A failure is ours and gets 502. The
 * pill's card shows the message as it is.
 */
export function remixErrorResponse(
  c: Context,
  err: unknown,
  // The text for an error that is not an Error. Each lane keeps its own text.
  fallbackDetail: string,
) {
  if (err instanceof RemixTransformError) {
    return c.json(
      { error: err.kind, detail: err.message },
      err.kind === "failed" ? 502 : 400,
    );
  }
  return c.json(
    {
      error: "failed" as const,
      detail: err instanceof Error ? err.message : fallbackDetail,
    },
    502,
  );
}
