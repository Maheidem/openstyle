import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod/v3";
import { listRemixRuns } from "../../lib/remix-store.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Remix run history: one row per write into the user's document. Powers the
 * Revert affordance (the row keeps the before-text) and the history view.
 */
const runsRoute = new Hono().get(
  "/",
  zValidator("query", listQuerySchema),
  (c) => {
    const { limit, offset } = c.req.valid("query");
    return c.json({ runs: listRemixRuns(limit, offset) });
  },
);

export default runsRoute;
