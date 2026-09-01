import { createAppLogger } from "@openstyle/utils";
import { Hono } from "hono";
import { beginDictation, endDictation } from "../lib/dictation-activity.js";
import { MLX_ASR_PROVIDER_ID } from "../lib/mlx-asr/constants.js";
import { getMlxModelStatus } from "../lib/mlx-asr/models.js";
import { canRunMlxAsr, startMlxInBackground } from "../lib/mlx-asr/server.js";
import { prewarmPostProcess } from "../lib/post-process.js";
import { getDefaultModels } from "../lib/providers.js";
import { stripProviderPrefix } from "../lib/streaming/types.js";
import {
  decodeAppContext,
  runTranscriptionPipeline,
} from "../lib/transcription-pipeline.js";
import { isServerBinaryAvailable } from "../lib/whisper/binary.js";
import { WHISPER_PROVIDER_ID } from "../lib/whisper/constants.js";
import { startInBackground } from "../lib/whisper/server.js";
import { prewarmModelCostRegistry } from "./models.js";

const log = createAppLogger("transcribe");

const transcribeRoute = new Hono()
  // Dictation-activity lease: while a dictation transcription is in flight the
  // meeting transcriber yields the (single) local whisper server to it. See
  // `lib/dictation-activity.ts` and `lib/meetings/transcriber.ts`.
  .use("/", async (_c, next) => {
    beginDictation();
    try {
      await next();
    } finally {
      endDictation();
    }
  })
  .post("/", async (c) => {
    const start = Date.now();

    const contentType = c.req.header("content-type") ?? "";
    let audioData: Uint8Array;

    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const audioFile = form.get("audio");
      if (!(audioFile instanceof File)) {
        return c.json({ error: "audio field missing or not a file" }, 400);
      }
      audioData = new Uint8Array(await audioFile.arrayBuffer());
    } else {
      audioData = new Uint8Array(await c.req.arrayBuffer());
    }

    if (audioData.length === 0) {
      return c.json({ error: "Empty audio data" }, 400);
    }

    log.debug(
      `received audio: ${audioData.length} bytes, header=${String.fromCharCode(
        ...audioData.slice(0, 4),
      )} contentType=${contentType.slice(0, 40)}`,
    );

    let audioDurationMs = 0;
    if (audioData.length > 44) {
      audioDurationMs = Math.round((audioData.length - 44) / 32);
    }
    if (!audioDurationMs) {
      const h = c.req.header("x-audio-duration-ms");
      if (h) audioDurationMs = Number(h) || 0;
    }

    const r = await runTranscriptionPipeline({
      audio: audioData,
      audioDurationMs,
      appContext: decodeAppContext(c.req.header("x-app-context")),
      languageOverride: c.req.header("x-dictation-language"),
      skipPostProcess: c.req.header("x-skip-post-process") === "true",
      start,
    });
    return c.json(r.body, r.status);
  });

export default transcribeRoute;

/**
 * Pre-warm the local ASR server for the currently-selected voice model so it
 * loads while the user is still speaking, instead of stalling at submission.
 *
 * The client fires this fire-and-forget on recording start. We dispatch on the
 * default voice provider: only local engines (whisper/mlx) need warming, and
 * each has its own availability gate. Cloud/BYOK providers are a cheap no-op.
 * The underlying `startInBackground` helpers are themselves fire-and-forget and
 * no-op when the server is already warm, so repeated calls are safe.
 *
 * Kept as a separate router (mounted alongside `transcribeRoute` at
 * `/transcribe`) so it can be added to the typed RPC surface without reindenting
 * the large batch-transcribe handler above.
 */
export const transcribePreWarmRoute = new Hono().post("/pre-warm", (c) => {
  try {
    // Warm the cleanup LLM connection while the user is still speaking, so the
    // post-transcription handoff reuses a hot socket. Independent of the voice
    // provider; a no-op unless cleanup is enabled and the configured provider
    // supports prewarming (e.g. Groq).
    prewarmPostProcess();

    // Warm the models.dev cost registry in the background so the per-dictation
    // cost lookup hits a warm cache and never blocks the response.
    prewarmModelCostRegistry();

    const defaults = getDefaultModels();
    const provider = defaults.voice?.provider;

    if (!defaults.voice || !provider) {
      return c.json({ ok: true, warming: null });
    }

    const modelId = stripProviderPrefix(defaults.voice.model_id);

    if (provider === WHISPER_PROVIDER_ID) {
      if (!isServerBinaryAvailable()) {
        return c.json({ ok: true, warming: null });
      }
      startInBackground(modelId);
      return c.json({ ok: true, warming: "whisper" });
    }

    if (provider === MLX_ASR_PROVIDER_ID) {
      if (!canRunMlxAsr()) return c.json({ ok: true, warming: null });
      if (getMlxModelStatus(modelId)?.status !== "ready") {
        return c.json({ ok: true, warming: null });
      }
      startMlxInBackground(modelId);
      return c.json({ ok: true, warming: "mlx" });
    }

    return c.json({ ok: true, warming: null });
  } catch {
    // Best-effort warmup — DB not ready or any other init issue is non-fatal;
    // the lazy start at submission time remains the fallback.
    return c.json({ ok: true, warming: null });
  }
});
