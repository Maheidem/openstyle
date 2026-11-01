/**
 * The Ask tab routes (specs/meeting-chat-agent.md 5.3). Mounted at `/api/chat`.
 *
 * A thread belongs to one meeting, one folder, or to scope A (no meeting and
 * no folder). `POST /threads/:id/messages` runs one turn: the gate, the
 * pipeline (`lib/chat/pipeline.ts`) and the save of the answer. The user
 * message is saved first, so a failed turn keeps the question. A failed turn
 * saves no answer (spec 2.5a, X5).
 *
 * A body of `{ widen: true }` asks the last question again at the wider scope
 * that the last not_found block offered (spec 6.3, 11.6.4). The server checks
 * the offer; the client cannot pick a scope.
 *
 * A turn does NOT stop when the client disconnects (P1.2). The owner left the
 * meeting screen while an answer was generating, and the turn was cancelled
 * and lost. Now only the deadline ends a turn. `GET /threads/:id` says
 * `pending: true` while the turn runs, so a client that comes back shows the
 * thread and waits for the answer.
 */

import { zValidator } from "@hono/zod-validator";
import { createAppLogger, errorMessage } from "@openstyle/utils";
import {
  type ChatMessage,
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
  lastWidenOffer,
  listMessages,
  listThreads,
  loadHistoryForPrompt,
  threadScope,
} from "../lib/chat/store.js";
import { getDb } from "../lib/db.js";

const log = createAppLogger("chat");

/** Threads with a turn in flight. A turn is serial per thread. */
const running = new Set<string>();

/**
 * The last failed turn of a thread, by reason. A turn runs on the server and
 * does not stop when the client leaves (P1.2). A client that comes back reads
 * the failure here, because no answer was saved. The next question clears it.
 */
const lastFailure = new Map<string, { reason: string }>();

const listQuerySchema = z
  .object({
    meeting_id: z.string().min(1).optional(),
    folder_id: z.string().min(1).optional(),
    /** `all=1`: the threads of scope A. */
    all: z.literal("1").optional(),
  })
  .refine(
    (q) =>
      [q.meeting_id, q.folder_id, q.all].filter((v) => v !== undefined)
        .length === 1,
    { message: "Pass exactly one of meeting_id, folder_id and all" },
  );

const chat = new Hono()
  .get("/threads", zValidator("query", listQuerySchema), (c) => {
    const q = c.req.valid("query");
    const scope = chatScopeSchema.parse(
      q.meeting_id !== undefined
        ? { kind: "meeting", id: q.meeting_id }
        : q.folder_id !== undefined
          ? { kind: "folder", id: q.folder_id }
          : { kind: "all" },
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
    return c.json({
      thread,
      messages: listMessages(db, thread.id),
      pending: running.has(thread.id),
      failure: lastFailure.get(thread.id) ?? null,
    });
  })
  .post(
    "/threads/:id/messages",
    zValidator("json", chatAskSchema),
    async (c) => {
      const db = getDb();
      const thread = getThread(db, c.req.param("id"));
      if (!thread) return c.json({ error: "Not found" }, 404);
      const body = c.req.valid("json");
      const settings = readChatSettings();
      if (!settings.enabled) {
        return c.json({ error: "The Ask tab is off", reason: "off" }, 409);
      }
      let scope = threadScope(thread);
      if (running.has(thread.id)) {
        return c.json(
          { error: "A question is still running", reason: "busy" },
          409,
        );
      }
      // A widen turn takes the question and the scope from the thread.
      let question = body.question ?? "";
      let askedBefore: ChatMessage | null = null;
      if (body.widen) {
        const offer = lastWidenOffer(db, thread.id, settings.searchWider);
        if (!offer) {
          return c.json(
            {
              error: "The last answer offers no wider search",
              reason: "widen_not_offered",
            },
            409,
          );
        }
        question = offer.user.content;
        askedBefore = offer.user;
        scope = offer.scope;
      }
      running.add(thread.id);
      lastFailure.delete(thread.id);
      try {
        const user =
          askedBefore === null
            ? appendMessage(db, thread.id, {
                role: "user",
                content: question,
              })
            : askedBefore;
        // The deadline only. A client that leaves does not cancel the turn.
        const signal = AbortSignal.timeout(settings.deadlineMs);
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
          const kind =
            typeof (err as { kind?: unknown }).kind === "string"
              ? (err as { kind: string }).kind
              : "chat_failed";
          log.warn(`Chat turn failed: ${errorMessage(err)}`);
          lastFailure.set(thread.id, { reason: "failed" });
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
