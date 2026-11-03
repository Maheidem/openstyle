/**
 * The oracle arms of the dig ladder (cloud-model study, 2026-11-03). Eval only.
 *
 * Both arms skip retrieval: every summary and every transcript window of the
 * scope becomes a source (the real read tools run, so the cites stay valid).
 *   oracle-harness (L2): today's `answerStage` (synthesize + cite_check).
 *   oracle-plain   (L3): ONE call with the whole scope and a plain prompt.
 * The source budget is 30000 tokens, so nothing is dropped.
 */

import { createRequire } from "node:module";
import type { ChatBlock, ChatMessage } from "@openstyle/validations";
import type { ChatTurnInput } from "../../apps/server/src/lib/chat/pipeline.ts";
import type { TurnResult } from "../../apps/server/src/lib/chat/types.ts";

// zod comes from the server package (the gateway uses the same copy). The
// name is a constant: the root package does not list zod.
const ZOD_PACKAGE = "zod";
const { z } = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
)(ZOD_PACKAGE) as {
  z: any;
};

const WINDOWS_MAX = 60;
const FOCUS =
  "answer with the reasons, changes or facts that the sources show; one bullet for each, from every meeting that tells one, with the date of the meeting";

const plainSchema = {
  name: "chat_plain_answer",
  version: 1,
  zod: z.object({
    answer: z
      .array(
        z.object({
          text: z.string().max(900),
          cites: z.array(z.string().max(8)).max(12),
        }),
      )
      .max(60),
  }),
};

const PLAIN_SYSTEM = `You answer a question about meeting notes. Use ONLY the numbered sources.
Answer fully, in the language of the question. Cover every meeting that holds a fact about the question.
Cite each claim: put the labels of the sources that show it in "cites", for example ["S2"]. Never write a label inside the text.
Copy names, numbers and dates exactly as the sources write them.
If the sources hold no answer, return an empty list.`;

/** The Turn class, the id lister and nothing else from the server, loaded late. */
async function mods() {
  const [turn, tools] = await Promise.all([
    import("../../apps/server/src/lib/chat/turn.ts"),
    import("../../apps/server/src/lib/chat/tools.ts"),
  ]);
  return { Turn: turn.Turn, scopeMeetingIds: tools.scopeMeetingIds };
}

/** Runs the read tools for every meeting of the scope. Returns the sources in order. */
async function gather(
  t: InstanceType<Awaited<ReturnType<typeof mods>>["Turn"]>,
) {
  const { scopeMeetingIds } = await mods();
  for (const id of scopeMeetingIds(t.input.db, t.turnScope)) {
    await t.run({ tool: "get_meeting_summary", args: { meeting_id: id } });
    let from = 0;
    for (let i = 0; i < WINDOWS_MAX; i++) {
      const r = await t.run({
        tool: "get_transcript_window",
        args: { meeting_id: id, from_ms: from, to_ms: from + 180_000 },
      });
      const src = r?.labels.map((l) => t.sources.get(l)).at(-1);
      if (!r || r.rows === 0 || !src) break;
      // The window ends at its last shown line. A window with more lines than
      // fit starts the next one there.
      const end = (src.endMs ?? from + 180_000) + 1;
      from = end > from ? end : from + 180_000;
      if (r.rows <= 1) break;
    }
  }
  return t.sources.all().filter((s) => s.kind !== "folder");
}

export async function runOracle(
  arm: "oracle-harness" | "oracle-plain",
  raw: ChatTurnInput,
): Promise<TurnResult> {
  const { Turn } = await mods();
  // No source is dropped: the budget is the top of the setting.
  const input: ChatTurnInput = {
    ...raw,
    settings: { ...raw.settings, sourceBudget: 30000 },
  };
  const t = new Turn(input);
  t.prepare();
  const ranked = await gather(t);
  if (ranked.length === 0) return t.notFound("no_sources");
  if (arm === "oracle-harness") {
    const exit = await t.answerStage({ ranked, synth: true, focus: FOCUS });
    return t.resolve(exit);
  }
  // oracle-plain: one call.
  const day = (ms: number | null) =>
    ms === null ? "" : ` (${new Date(ms).toISOString().slice(0, 10)})`;
  const sources = ranked
    .map(
      (s) =>
        `[${s.label}] ${s.title ?? "meeting"}${day(s.startedAt)}: ${s.text}`,
    )
    .join("\n\n");
  const hist = (raw.history as ChatMessage[])
    .slice(-4)
    .map((m) => `${m.role === "user" ? "Question" : "Answer"}: ${m.content}`)
    .join("\n");
  const started = Date.now();
  const r = await input.llm.structured({
    step: "chatAnswer",
    unitKey: "answer-plain",
    schema: plainSchema,
    system: PLAIN_SYSTEM,
    messages: [
      {
        role: "user",
        content: `${hist ? `Earlier in this thread:\n${hist}\n\n` : ""}Sources:\n${sources}\n\nQuestion: ${raw.question}`,
      },
    ],
    maxOutputTokens: 4000,
  });
  t.step("answer", "plain", started);
  const sentences = r.object.answer.filter((x) => x.text.trim() !== "");
  if (sentences.length === 0) return t.notFound("no_sources");
  const known = new Set(ranked.map((s) => s.label));
  const blocks: ChatBlock[] = sentences.map((s) => ({
    kind: "text",
    text: s.text,
    cites: s.cites.filter((c) => known.has(c)),
  }));
  const labels = [
    ...new Set(blocks.flatMap((b) => (b.kind === "text" ? b.cites : []))),
  ];
  const cites = labels.flatMap((l) => {
    const c = t.sources.toCite(l);
    return c ? [c] : [];
  });
  return t.finish(blocks, cites, sentences.map((s) => s.text).join("\n"));
}
