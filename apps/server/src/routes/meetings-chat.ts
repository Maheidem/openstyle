/**
 * `POST /api/meetings/:id/chat` — live chat during a recording (issue #375,
 * specs/live-chat.md section 4). Experimental, off by default.
 *
 * One question gives one JSON answer. There is no token streaming. The route
 * saves each answered question with the meeting (`chat-store.ts`) and builds
 * the model history from the saved messages. `GET /:id/chat` returns them, so
 * the chat survives a page change and can be read after Stop. Code builds the
 * context (`lib/meetings/live/chat-context.ts`).
 * The route follows the light pattern of dictation cleanup:
 * resolveTaskCall, createChatModel, withLlmLane.
 *
 * Mounted as a sibling router at the same `/meetings` prefix
 * (`routes/index.ts`), like `meetings-runs.ts`.
 */

import { zValidator } from "@hono/zod-validator";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import { SETTINGS_KEYS } from "@openstyle/validations";
import { generateText } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { getDb, readSetting } from "../lib/db.js";
import { withLlmLane } from "../lib/llm/lane.js";
import { isLocalProvider } from "../lib/llm/registry.js";
import { resolveTaskCall, resolveTaskModel } from "../lib/llm/task-profiles.js";
import {
  contextWindowFor,
  estimatePromptTokens,
  fitsWindow,
} from "../lib/llm/token-budget.js";
import {
  buildChatContext,
  type ChatSource,
  RETRIEVE_WAIT_MS,
} from "../lib/meetings/live/chat-context.js";
import {
  CHAT_SYSTEM_PROMPT,
  parseChatReply,
} from "../lib/meetings/live/chat-prompt.js";
import {
  appendChatPair,
  listChatMessages,
  recentChatHistory,
} from "../lib/meetings/live/chat-store.js";
import { getLive } from "../lib/meetings/live/store.js";
import { createChatModel } from "../lib/providers.js";

const log = createAppLogger("meeting-live-chat");

/** The first call loads the model. It gets a longer limit than a warm call. */
const COLD_TIMEOUT_MS = 120_000;
/** The model sees the last messages of the saved chat. */
const HISTORY_MESSAGES = 4;
const PROMPT_BUDGET_TOKENS = 6000;
/** Tokens kept for the system rules and the question. */
const FIXED_TOKENS = 700;

/** Slack on top of the model timeout for the wait in the lane. */
const LANE_SLACK_MS = 15_000;

let chatsAnswered = 0;

/** Reject when `promise` takes longer than `ms`: the panel never waits forever. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`No answer within ${Math.round(ms / 1000)} s`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The provider and model that get the live text. Null when none is set. */
async function chatModelInfo(): Promise<{
  provider: string;
  model: string;
  local: boolean;
} | null> {
  try {
    const { provider, modelId } = await resolveTaskModel("liveChat");
    return {
      provider,
      model: modelId,
      local: isLocalProvider(provider),
    };
  } catch {
    return null;
  }
}

const chatSchema = z.object({
  question: z.string().trim().min(1).max(1000),
});

interface CiteOut {
  label: string;
  kind: ChatSource["kind"];
  meetingId?: string;
  title?: string | null;
  timeMs?: number | null;
  startedAt?: number;
}

const meetingsChat = new Hono()
  // The saved chat of a meeting, oldest first. No setting check: the user can
  // read the chat after Stop, also when the setting is off again.
  .get("/:id/chat", async (c) => {
    const id = c.req.param("id");
    const db = getDb();
    if (!db.prepare("SELECT 1 FROM meetings WHERE id = ?").get(id)) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({
      messages: listChatMessages(db, id),
      model: await chatModelInfo(),
    });
  })
  .post("/:id/chat", zValidator("json", chatSchema), async (c) => {
    const id = c.req.param("id");
    const { question } = c.req.valid("json");
    const db = getDb();
    if (!db.prepare("SELECT 1 FROM meetings WHERE id = ?").get(id)) {
      return c.json({ error: "Not found" }, 404);
    }
    const history = recentChatHistory(db, id, HISTORY_MESSAGES);
    if (readSetting(SETTINGS_KEYS.liveChatEnabled) !== "true") {
      return c.json({ error: "Live chat is off", reason: "off" }, 409);
    }
    const startedAt = Date.now();
    try {
      const resolved = await resolveTaskCall("liveChat");
      // Cloud is the user's choice, like Ask (specs/meeting-chat-agent.md D1).
      // The panel shows which provider and model get the live text.
      const window = contextWindowFor(resolved.provider, resolved.modelId);
      const budget =
        window === null
          ? PROMPT_BUDGET_TOKENS
          : Math.min(
              PROMPT_BUDGET_TOKENS,
              window - resolved.maxOutputTokens - FIXED_TOKENS,
            );
      const live = getLive(id)?.lines ?? [];
      const context = await withDeadline(
        buildChatContext(db, {
          meetingId: id,
          question,
          live,
          budgetTokens: budget,
        }),
        RETRIEVE_WAIT_MS + LANE_SLACK_MS,
      );
      const user = `SOURCES:\n${context.sources || "(none)"}\n\nQUESTION: ${question}`;
      const promptTokens =
        estimatePromptTokens(CHAT_SYSTEM_PROMPT) +
        estimatePromptTokens(user) +
        history.reduce((n, h) => n + estimatePromptTokens(h.content), 0);
      if (!fitsWindow(promptTokens, resolved.maxOutputTokens, window)) {
        return c.json(
          { error: "The question is too long", reason: "too_long" },
          413,
        );
      }

      const cold = chatsAnswered === 0;
      const model = await withDeadline(
        createChatModel(resolved.provider, resolved.modelId, {
          task: "liveChat",
          sampling: resolved.samplingParams,
        }),
        COLD_TIMEOUT_MS + LANE_SLACK_MS,
      );
      const timeoutMs = cold ? COLD_TIMEOUT_MS : resolved.timeoutMs;
      const callModel = (): Promise<string> =>
        withLlmLane(
          resolved.provider,
          resolved.modelId,
          { cls: "interactive", taskId: "liveChat" },
          async () =>
            (
              await generateText({
                model,
                instructions: CHAT_SYSTEM_PROMPT,
                messages: [...history, { role: "user", content: user }],
                temperature: resolved.temperature,
                ...(resolved.topP !== undefined ? { topP: resolved.topP } : {}),
                maxOutputTokens: resolved.maxOutputTokens,
                abortSignal: AbortSignal.timeout(timeoutMs),
              })
            ).text,
        );
      // One try, and one retry when the reply is not readable. A reply that
      // looks like JSON but cannot be read is never shown raw.
      let reply: ReturnType<typeof parseChatReply> = null;
      for (let attempt = 1; attempt <= 2 && !reply; attempt++) {
        const text = await withDeadline(callModel(), timeoutMs + LANE_SLACK_MS);
        reply = parseChatReply(text);
        if (!reply) log.warn(`Live chat reply not readable (try ${attempt})`);
      }
      if (!reply) {
        return c.json(
          { error: "The model reply was not readable", reason: "bad_reply" },
          502,
        );
      }
      chatsAnswered++;
      // Code drops every cite that is not in the source list.
      const seen = new Set<string>();
      const cites: CiteOut[] = [];
      for (const label of reply.cites) {
        const source = context.index.get(label);
        if (!source || seen.has(label)) continue;
        seen.add(label);
        cites.push({
          label,
          kind: source.kind,
          ...(source.meetingId ? { meetingId: source.meetingId } : {}),
          ...(source.title !== undefined ? { title: source.title } : {}),
          ...(source.timeMs !== undefined ? { timeMs: source.timeMs } : {}),
          ...(source.startedAt !== undefined
            ? { startedAt: source.startedAt }
            : {}),
        });
      }
      const ms = Date.now() - startedAt;
      log.info(
        `Live chat answered in ${ms} ms (${context.tokens} source tokens, ${cites.length} cites${cold ? ", cold" : ""})`,
      );
      // Save the pair. A failed write does not lose the answer.
      try {
        appendChatPair(db, id, {
          question,
          answer: reply.answer,
          cites,
          ms,
        });
      } catch (err) {
        log.warn(`Live chat not saved: ${errorMessage(err)}`);
      }
      return c.json({
        answer: reply.answer,
        cites,
        ms,
        cold,
        provider: resolved.provider,
        model: resolved.modelId,
        sourceTokens: context.tokens,
        // What was in the context: labels, and what code left out.
        sources: [...context.index.keys()],
        notes: context.notes,
      });
    } catch (err) {
      log.warn(`Live chat failed: ${errorMessage(err)}`);
      return c.json({ error: errorMessage(err), reason: "failed" }, 502);
    }
  });

export default meetingsChat;
