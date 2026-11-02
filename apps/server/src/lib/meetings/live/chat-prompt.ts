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

/** A label marker in the text: [L7], [P2], [F], or a group: [L7, L10]. */
const LABEL_MARKER_RE = /\[\s*(?:(?:[LP]\d+|F)\s*(?:,\s*)?)+\]/g;

/**
 * The first balanced `{...}` object in the text that parses as JSON. Braces
 * inside strings do not count. Text before and after the object is ignored,
 * so trailing junk (for example a stray character) does no harm.
 */
function firstJsonObject(text: string): unknown {
  for (let start = text.indexOf("{"); start >= 0; ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Not JSON (junk inside). Try the next "{".
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return null;
}

/** Read a JSON string literal that starts at `from` (after the open quote). */
function readJsonString(text: string, from: number): string | null {
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if (ch === '"') {
      try {
        return JSON.parse(`"${text.slice(from, i)}"`) as string;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Last resort for a reply with junk inside the object: take the "answer"
 * string and the "cites" array with a pattern each.
 */
function salvage(text: string): { answer: unknown; cites: unknown } | null {
  const key = /"answer"\s*:\s*"/.exec(text);
  if (!key) return null;
  const answer = readJsonString(text, key.index + key[0].length);
  if (answer === null) return null;
  const list = /"cites"\s*:\s*\[([^\]]*)\]/.exec(text);
  const cites = list
    ? [...list[1].matchAll(/"([^"]*)"/g)].map((m) => m[1])
    : [];
  return { answer, cites };
}

function cleanLabel(c: string): string {
  return c.replace(/[[\]\s]/g, "");
}

/** Move inline markers out of the text into the cite list. */
function liftMarkers(answer: string, cites: string[]): ChatAnswer {
  const all = [...cites];
  const text = answer
    .replace(LABEL_MARKER_RE, (marker: string) => {
      all.push(...(marker.match(/[LP]\d+|F/g) ?? []));
      return "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  return { answer: text, cites: [...new Set(all)] };
}

/** True when the reply looks like the JSON form, so it must never be shown raw. */
function looksLikeJson(text: string): boolean {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "");
  return t.startsWith("{") || /"answer"\s*:/.test(t);
}

/**
 * Read the reply of the model. It takes the first balanced JSON object, so
 * trailing text does not matter. Inline markers such as [L7] leave the text
 * and join the cites. A reply with no JSON at all is a plain answer. A reply
 * that looks like JSON but has no readable "answer" gives null: the caller
 * retries once and then shows an error, never the raw text. Code, not the
 * model, decides which cites are valid.
 */
export function parseChatReply(text: string): ChatAnswer | null {
  const parsed = firstJsonObject(text);
  const found =
    parsed && typeof parsed === "object" && "answer" in parsed
      ? (parsed as Record<string, unknown>)
      : salvage(text);
  if (found && typeof found.answer === "string") {
    const cites = Array.isArray(found.cites)
      ? found.cites
          .filter((c): c is string => typeof c === "string")
          .map(cleanLabel)
      : [];
    const reply = liftMarkers(found.answer, cites);
    return reply.answer ? reply : null;
  }
  if (looksLikeJson(text)) return null;
  const reply = liftMarkers(text, []);
  return reply.answer ? reply : null;
}
