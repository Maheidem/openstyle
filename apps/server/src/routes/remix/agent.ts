import { createAppLogger } from "@freestyle-voice/utils";
import { remixAgentRequestSchema } from "@freestyle-voice/validations";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getDefaultModels } from "../../lib/providers.js";
import { runRemixAgentLocally } from "../../lib/remix-agent.js";
import { isCleanupModelSupported } from "../models.js";

const log = createAppLogger("remix-agent");

/** One agent turn, run in-process against the configured model. */
const agentRoute = new Hono().post(
  "/",
  zValidator("json", remixAgentRequestSchema),
  async (c) => {
    const body = c.req.valid("json");
    const llm = getDefaultModels().llm;
    if (!llm) {
      return c.json(
        {
          error: "no-model",
          detail: "No AI model is set up yet. Pick one in Settings > Models.",
        },
        400,
      );
    }

    if (!(await isCleanupModelSupported(llm.provider, llm.model_id))) {
      return c.json(
        {
          error: "unsupported-model",
          detail: `${llm.model_id} can't run Remix. Pick a different model in Settings > Models.`,
        },
        400,
      );
    }

    try {
      return await runRemixAgentLocally(body, llm, c.req.raw.signal);
    } catch (err) {
      log.error(`Remix agent failed: ${err}`);
      return c.json(
        {
          error: "failed",
          detail: err instanceof Error ? err.message : "Remix failed.",
        },
        502,
      );
    }
  },
);

export default agentRoute;
