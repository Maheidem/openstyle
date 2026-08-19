import { createAppLogger } from "@freestyle-voice/utils";
import { clientErrorSchema } from "@freestyle-voice/validations";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import apiKeys from "./api-keys.js";
import auth from "./auth.js";
import billing from "./billing.js";
import configRoute from "./config.js";
import dictionary from "./dictionary.js";
import dismissedNotifications from "./dismissed-notifications.js";
import eventsRoute from "./events.js";
import history from "./history.js";
import mlxAsr from "./mlx-asr.js";
import models from "./models.js";
import org from "./org.js";
import outputRoute from "./output.js";
import pluginsRoute from "./plugins.js";
import postProcessRoute from "./post-process-route.js";
import pricing from "./pricing.js";
import remixRoute from "./remix/index.js";
import settings from "./settings.js";
import streamRoute from "./stream.js";
import transcribe, { transcribePreWarmRoute } from "./transcribe.js";
import usage from "./usage.js";
import vocabulary from "./vocabulary.js";
import whisper from "./whisper.js";

const clientLog = createAppLogger("renderer");

const apiRouter = new Hono()
  .get("/health", (c) => c.json({ status: "ok", name: "freestyle" }))
  // Crash/error reports from the renderer (window.onerror, unhandled
  // rejections, React error boundary), persisted to the local log file for
  // diagnostics. Only message/stack/source/context are accepted — callers
  // must never include transcript or clipboard text.
  .post("/client-error", zValidator("json", clientErrorSchema), (c) => {
    const { message, stack, source = "renderer" } = c.req.valid("json");
    clientLog.error(`[${source}] ${message}${stack ? `\n${stack}` : ""}`);

    return c.json({ ok: true });
  })
  .route("/settings", settings)
  .route("/config", configRoute)
  .route("/keys", apiKeys)
  .route("/auth", auth)
  .route("/models", models)
  .route("/transcribe", transcribe)
  .route("/transcribe", transcribePreWarmRoute)
  .route("/history", history)
  .route("/dictionary", dictionary)
  .route("/dismissed-notifications", dismissedNotifications)
  .route("/vocabulary", vocabulary)
  .route("/post-process", postProcessRoute)
  .route("/remix", remixRoute)
  .route("/output", outputRoute)
  .route("/events", eventsRoute)
  .route("/usage", usage)
  .route("/billing", billing)
  .route("/pricing", pricing)
  .route("/org", org)
  .route("/plugins", pluginsRoute)
  .route("/whisper", whisper)
  .route("/mlx-asr", mlxAsr);

const router = new Hono()
  .route("/api", apiRouter)
  .route("/stream", streamRoute);

export default router;
