import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getConfig, getFlag, setFlag } from "../lib/config.js";

const flagValueSchema = z.object({ value: z.boolean() });

const config = new Hono()
  /** Full config — the renderer loads this once on mount. */
  .get("/", (c) => {
    return c.json(getConfig());
  })
  /** Read a single flag. */
  .get("/flags/:key", (c) => {
    const key = c.req.param("key");
    return c.json({ key, value: getFlag(key) });
  })
  /** Set a single flag. */
  .put("/flags/:key", zValidator("json", flagValueSchema), (c) => {
    const key = c.req.param("key");
    const { value } = c.req.valid("json");
    setFlag(key, value);
    return c.json({ ok: true });
  });

export default config;
