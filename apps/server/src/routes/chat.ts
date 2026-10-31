/**
 * The Ask tab routes (specs/meeting-chat-agent.md 5.3). Mounted at `/api/chat`.
 *
 * A thread belongs to one meeting or one folder. `POST /threads/:id/messages`
 * runs one turn: the gate, the pipeline (`lib/chat/pipeline.ts`) and the save
 * of the answer. The user message is saved first, so a failed turn keeps the
 * question. A failed or cancelled turn saves no answer (spec 2.5a, X5).
 */

import { zValidator } from "@hono/zod-validator";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import {
  chatAskSchema,
  chatCreateThreadSchema,
  chatScopeSchema,
} from "@openstyle/validations";
import { Hono } from "hono";
import { z } from "zod";
import { ChatGateError, createChatLlm } from "../lib/chat/llm.js";
import { runChatTurn } from "../lib/chat/pipeline.js";
import { readChatSettings } from "../lib/chat/settings.js";
import {
  appendMessage,
  createThread,
  getThread,
  listMessages,
  listThreads,
  loadHistoryForPrompt,
  threadScope,
} from "../lib/chat/store.js";
import { getDb } from "../lib/db.js";

const log = createAppLogger("chat");

/** Threads with a turn in flight. A turn is serial per thread. */
const running = new Set<string>();

const listQuerySchema = z
  .object({
    meeting_id: z.string().min(1).optional(),
    folder_id: z.string().min(1).optional(),
  })
  .refine((q) => (q.meeting_id === undefined) !== (q.folder_id === undefined), {
    message: "Pass exactly one of meeting_id and folder_id",
  });

const chat = new Hono()
  .get("/threads", zValidator("query", listQuerySchema), (c) => {
    const q = c.req.valid("query");
    const scope = chatScopeSchema.parse(
      q.meeting_id !== undefined
        ? { kind: "meeting", id: q.meeting_id }
        : { kind: "folder", id: q.folder_id },
    );
    return c.json({ threads: listThreads(getDb(), scope) });
  })
  .post("/threads", zValidator("json", chatCreateThreadSchema), (c) => {
    const { scope } = c.req.valid("json");
    const thread = createThread(getDb(), scope);
    if (!thread) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ thread });
  })
  .get("/threads/:id", (c) => {
    const db = getDb();
    const thread = getThread(db, c.req.param("id"));
    if (!thread) return c.json({ error: "Not found" }, 404);
    return c.json({ thread, messages: listMessages(db, thread.id) });
  })
  .post(
    "/threads/:id/messages",
    zValidator("json", chatAskSchema),
    async (c) => {
      const db = getDb();
      const thread = getThread(db, c.req.param("id"));
      if (!thread) return c.json({ error: "Not found" }, 404);
      const { question } = c.req.valid("json");
      const settings = readChatSettings();
      if (!settings.enabled) {
        return c.json({ error: "The Ask tab is off", reason: "off" }, 409);
      }
      const scope = threadScope(thread);
      if (!scope) {
        return c.json(
          {
            error: "The thread has no meeting or folder",
            reason: "scope_missing",
          },
          409,
        );
      }
      if (running.has(thread.id)) {
        return c.json(
          { error: "A question is still running", reason: "busy" },
          409,
        );
      }
      running.add(thread.id);
      try {
        const user = appendMessage(db, thread.id, {
          role: "user",
          content: question,
        });
        const signal = AbortSignal.any([
          c.req.raw.signal,
          AbortSignal.timeout(settings.deadlineMs),
        ]);
        let llm: Awaited<ReturnType<typeof createChatLlm>>;
        try {
          llm = await createChatLlm(db, { threadId: thread.id, signal });
        } catch (err) {
          if (err instanceof ChatGateError) {
            return c.json({ error: err.message, reason: err.reason }, 409);
          }
          log.warn(`Chat gate failed: ${errorMessage(err)}`);
          return c.json({ error: errorMessage(err), reason: "failed" }, 502);
        }
        try {
          const history = loadHistoryForPrompt(db, thread.id, user.id);
          const result = await runChatTurn({
            db,
            scope,
            question,
            history,
            settings,
            llm,
            signal,
          });
          if (c.req.raw.signal.aborted) {
            llm.finish("cancelled");
            return c.json({ error: "Cancelled", reason: "cancelled" }, 408);
          }
          const assistant = appendMessage(db, thread.id, {
            role: "assistant",
            content: result.content,
            blocks: result.blocks,
            cites: result.cites,
            trace: result.trace,
            runId: result.runId,
            modelId: result.modelId,
            provider: result.provider,
            ms: result.ms,
          });
          llm.finish("succeeded");
          return c.json({ user, assistant });
        } catch (err) {
          if (c.req.raw.signal.aborted) {
            llm.finish("cancelled");
            return c.json({ error: "Cancelled", reason: "cancelled" }, 408);
          }
          const kind =
            typeof (err as { kind?: unknown }).kind === "string"
              ? (err as { kind: string }).kind
              : "chat_failed";
          log.warn(`Chat turn failed: ${errorMessage(err)}`);
          llm.finish("failed", {
            errorKind: kind,
            errorDetail: errorMessage(err),
          });
          return c.json({ error: errorMessage(err), reason: "failed" }, 502);
        }
      } finally {
        running.delete(thread.id);
      }
    },
  );

export default chat;
