import { zValidator } from "@hono/zod-validator";
import { createAppLogger } from "@openstyle/utils";
import { remixTransformSchema } from "@openstyle/validations";
import { Hono } from "hono";
import { getLanguagesSetting } from "../../lib/language.js";
import { recordRemixRun } from "../../lib/remix-store.js";
import { runRemixTransform } from "../../lib/remix-transform.js";
import { remixErrorResponse } from "./error-response.js";

const log = createAppLogger("remix");

/**
 * Run an AI edit over a text selection and hand back the replacement.
 *
 * Deliberately outside the dictation pipeline: no plugin hooks, no dictionary
 * replacements, no transcription-history row. A remix is a direct edit the
 * user asked for on text they already had — the transformations that exist to
 * turn speech into writing have nothing to say about it. It does land in
 * remix_runs, which is what powers Revert.
 */
const remixRoute = new Hono().post(
  "/",
  zValidator("json", remixTransformSchema),
  async (c) => {
    const body = c.req.valid("json");

    try {
      const result = await runRemixTransform({
        text: body.text,
        remixId: body.remixId,
        instruction: body.instruction,
        languages: body.language ? [body.language] : getLanguagesSetting(),
      });
      let runId: number | null = null;
      try {
        runId = recordRemixRun({
          lane: "transform",
          instruction: result.instruction,
          beforeText: body.text,
          afterText: result.text,
          appName: body.appName ?? null,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        });
      } catch {
        // History is a convenience; the edit itself already succeeded.
      }
      return c.json({ text: result.text, runId });
    } catch (err) {
      log.error(`Remix failed: ${err}`);
      return remixErrorResponse(c, err, "Remix failed");
    }
  },
);

export default remixRoute;
