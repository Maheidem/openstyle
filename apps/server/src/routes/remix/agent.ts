import { zValidator } from "@hono/zod-validator";
import { createAppLogger } from "@openstyle/utils";
import { remixAgentRequestSchema } from "@openstyle/validations";
import { Hono } from "hono";
import { runRemixAgentLocally } from "../../lib/remix-agent.js";
import { remixErrorResponse } from "./error-response.js";

const log = createAppLogger("remix-agent");

/** One agent turn, run in-process against the configured model. */
const agentRoute = new Hono().post(
  "/",
  zValidator("json", remixAgentRequestSchema),
  async (c) => {
    const body = c.req.valid("json");
    try {
      return await runRemixAgentLocally(body, c.req.raw.signal);
    } catch (err) {
      log.error(`Remix agent failed: ${err}`);
      return remixErrorResponse(c, err, "Remix failed.");
    }
  },
);

export default agentRoute;
