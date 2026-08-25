import { zValidator } from "@hono/zod-validator";
import { postProcessSchema } from "@openstyle/validations";
import { Hono } from "hono";
import { getLanguagesSetting } from "../lib/language.js";
import { postProcess } from "../lib/post-process.js";

const postProcessRoute = new Hono().post(
  "/",
  zValidator("json", postProcessSchema),
  async (c) => {
    const body = c.req.valid("json");

    const appContext: string | null = body.appContext ?? null;
    const languages = body.languages ?? getLanguagesSetting();

    const pp = await postProcess(body.text, appContext, {
      languages,
      source: "multi_segment",
    });

    return c.json({
      cleaned: pp.cleaned,
      inputTokens: pp.inputTokens,
      outputTokens: pp.outputTokens,
      costUsd: pp.costUsd,
    });
  },
);

export default postProcessRoute;
