/**
 * Prompt of the live chat (issue #375, specs/live-chat.md section 4). One
 * narrow job: answer one question from the numbered sources. Code builds the
 * sources. The model only reads them.
 */

export const CHAT_SYSTEM_PROMPT = `You answer one question about a meeting that is in progress.
Use only the SOURCES below. Each source has a label, for example [L3] or [P2].
Rules:
- Answer in the language of the question. Keep the answer short.
- Put the label of each source that you used in "cites", without brackets.
- Live lines [L] are the newest information. They win over older sources [P].
- If the sources do not hold the answer, set "answer" to "Not found in the sources." written in the language of the question (Portuguese: "Não encontrei nas fontes."), and "cites" to [].
- Never invent a fact. Never invent a label.
Reply with JSON only, in this form:
{"answer": "text", "cites": ["L3"]}`;

export interface ChatAnswer {
  answer: string;
  cites: string[];
}

/** Take the first JSON object out of a model reply. Null when there is none. */
function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Read the reply of the model. A reply that is not JSON becomes a plain
 * answer with no cites. Code, not the model, decides which cites are valid.
 */
export function parseChatReply(text: string): ChatAnswer {
  const parsed = parseJsonObject(text);
  if (parsed && typeof parsed === "object") {
    const { answer, cites } = parsed as Record<string, unknown>;
    if (typeof answer === "string") {
      return {
        answer: answer.trim(),
        cites: Array.isArray(cites)
          ? cites
              .filter((c): c is string => typeof c === "string")
              .map((c) => c.replace(/[[\]\s]/g, ""))
          : [],
      };
    }
  }
  return { answer: text.trim(), cites: [] };
}
