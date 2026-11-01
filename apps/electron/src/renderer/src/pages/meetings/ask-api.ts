/**
 * The requests of the Ask surfaces (the meeting and folder tabs, the Ask page
 * and the bubble). They share one thread model (specs/meeting-chat-agent.md
 * 11.6): a scope gives a thread list, a thread gives messages.
 */
import type {
  ChatAskReply,
  ChatScope,
  ChatThread,
  ChatThreadDetail,
} from "@openstyle/validations";
import { getClient } from "@renderer/lib/api";

export class AskRequestError extends Error {
  constructor(
    readonly status: number | null,
    readonly reason: string | null,
  ) {
    super("ask request failed");
  }
}

async function failureOf(res: Response): Promise<AskRequestError> {
  let reason: string | null = null;
  try {
    const body = (await res.json()) as { reason?: unknown };
    if (typeof body.reason === "string") reason = body.reason;
  } catch {
    // No JSON body. The status alone decides.
  }
  return new AskRequestError(res.status, reason);
}

export async function fetchThreads(scope: ChatScope): Promise<ChatThread[]> {
  const query =
    scope.kind === "meeting"
      ? { meeting_id: scope.id }
      : scope.kind === "folder"
        ? { folder_id: scope.id }
        : { all: "1" as const };
  const res = await getClient().api.chat.threads.$get({ query });
  if (!res.ok) throw await failureOf(res);
  const body: unknown = await res.json();
  return (body as { threads: ChatThread[] }).threads;
}

export async function fetchThread(id: string): Promise<ChatThreadDetail> {
  const res = await getClient().api.chat.threads[":id"].$get({
    param: { id },
  });
  if (!res.ok) throw await failureOf(res);
  const body: unknown = await res.json();
  return body as ChatThreadDetail;
}

export async function createThread(scope: ChatScope): Promise<ChatThread> {
  const res = await getClient().api.chat.threads.$post({ json: { scope } });
  if (!res.ok) throw await failureOf(res);
  const body: unknown = await res.json();
  return (body as { thread: ChatThread }).thread;
}

/** A new question, or `widen` to ask the last question again at the wider scope. */
export async function postQuestion(
  threadId: string,
  turn: { question: string } | { widen: true },
): Promise<ChatAskReply> {
  const res = await getClient().api.chat.threads[":id"].messages.$post({
    param: { id: threadId },
    json: turn,
  });
  if (!res.ok) throw await failureOf(res);
  const body: unknown = await res.json();
  return body as ChatAskReply;
}
