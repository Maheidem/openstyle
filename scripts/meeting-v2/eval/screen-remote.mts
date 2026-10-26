// screen-remote.mts: screening lane of the quality ranking. It sends the
// identifySpeakers and summarize stages of the 2 gold meetings to big models
// on the llama.cpp desktop (llama-swap, OpenAI-style). The outputs enter the
// blind ranking only. They never gate and never enter speed or memory tables.
// Label every result "screening, llama.cpp".
//
// Input: raw-<id8>.json packs (segments[] with source, idx, start_ms,
// speaker_label, text). The prompts, schemas and the summary plan come from
// the app code (prompts.ts, schemas.ts, runSummary of stage-replay.mts).
// The files hold real meeting text: never commit or print them.
//
// Usage:
//   node --experimental-strip-types scripts/meeting-v2/eval/screen-remote.mts \
//     --pack /tmp/meeting-eval/out/nemotron-2of4/pack \
//     --out /tmp/meeting-eval/out/screening-222 \
//     [--url http://192.168.31.222] [--models gemma4-26b,gemma4-31b,...] \
//     [--meetings 5578edb0,ca70f895] [--context-budget 24000]
//
// Output per model and meeting: <model>-<id8>.summary.md, <model>-<id8>.raw.json,
// and one line per call in run.log.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { speakerDisplayLabel } from "../../../apps/server/src/lib/meetings/merge.ts";
import { formatEnhanceLine } from "../../../apps/server/src/lib/meetings/workflow/chunking.ts";
import {
  buildIdentifySystemPrompt,
  buildIdentifyUserPrompt,
} from "../../../apps/server/src/lib/meetings/workflow/prompts.ts";
import {
  identifySpeakersStepSchema,
  type MeetingSummary,
} from "../../../apps/server/src/lib/meetings/workflow/schemas.ts";
import { renderSummaryMarkdown } from "../../../apps/server/src/lib/meetings/workflow/summary-pure.ts";
import type { PreparedSegment } from "../../../apps/server/src/lib/meetings/workflow/types.ts";
import {
  type Capture,
  type MeetingInput,
  runSummary,
  type StageOutput,
  wireSchema,
  workerClient,
} from "./stage-replay.mts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const PACK = arg("pack") ?? "/tmp/meeting-eval/out/nemotron-2of4/pack";
const OUT = arg("out") ?? "/tmp/meeting-eval/out/screening-222";
const URL_BASE = (arg("url") ?? "http://192.168.31.222").replace(/\/$/, "");
const MODELS = (
  arg("models") ?? "gemma4-26b,gemma4-31b,qwen3.6-35b,qwen3.8-27b"
).split(",");
const MEETINGS = (arg("meetings") ?? "5578edb0,ca70f895").split(",");
const CONTEXT_BUDGET = Number(arg("context-budget") ?? 24_000);
const TIMEOUT_MS = 1_200_000;
const IDENTIFY_MAX_TOKENS = 2048;

interface RawSegment {
  source: "mic" | "system";
  idx: number;
  start_ms: number;
  speaker_label: string | null;
  text: string | null;
  enhanced_text: string | null;
}

/** The merged transcript as prepare.ts builds it: by start time, Me / Them N. */
function readPack(id8: string): MeetingInput {
  const raw = JSON.parse(
    readFileSync(join(PACK, `raw-${id8}.json`), "utf8"),
  ) as {
    meetingId: string;
    segments: RawSegment[];
  };
  const sorted = raw.segments
    .filter((s) => (s.text ?? "").trim().length > 0)
    .sort((a, b) => a.start_ms - b.start_ms || a.idx - b.idx);
  const segments: PreparedSegment[] = sorted.map((s) => {
    const speaker = s.source === "mic" ? "Me" : "Them";
    const speakerLabel = speaker === "Them" ? s.speaker_label : null;
    return {
      id: `${s.source}-${s.idx}`,
      speaker,
      startMs: s.start_ms,
      speakerLabel,
      displayLabel: speakerDisplayLabel(
        { speaker, speakerName: null, speakerLabel } as never,
        "Them",
      ),
      text: s.text as string,
      enhancedText: s.enhanced_text,
      speakerName: null,
    } as PreparedSegment;
  });
  return {
    meetingId: raw.meetingId,
    row: {},
    segments,
    language: null,
    summaryInstructions: "",
    rows: [],
    app: {
      language: null,
      vocabTerms: [],
      title: null,
      context: null,
      contextWithFolder: null,
    },
  } as MeetingInput;
}

/** The template of a stored call: the wire parameters of the summary stage. */
function captureFor(model: string): Capture {
  return {
    calls: [
      {
        id: 1,
        node: "summarize",
        unitKey: "single",
        topLevel: {
          model,
          temperature: 0,
          response_format: {
            type: "json_schema",
            json_schema: { name: "step", strict: true, schema: {} },
          },
        },
        extraBody: { chat_template_kwargs: { enable_thinking: false } },
        messages: [],
      },
    ],
  } as unknown as Capture;
}

const log = (line: string) => appendFileSync(join(OUT, "run.log"), `${line}\n`);

interface Row {
  model: string;
  meeting: string;
  calls: number;
  seconds: number;
  parseOk: boolean;
  files: string;
  note: string;
}

// Simpler than the app: identify.ts selectCandidates picks lines by budget and
// cues. Here the whole labelled pool goes in one call (both gold meetings fit).
async function identify(
  complete: ReturnType<typeof workerClient>,
  model: string,
  m: MeetingInput,
) {
  const labels = [
    ...new Set(
      m.segments
        .filter((s) => s.speaker === "Them" && s.speakerLabel)
        .map((s) => s.speakerLabel as string),
    ),
  ];
  const pool = m.segments.filter((s) => s.speaker === "Them" && s.speakerLabel);
  if (labels.length === 0 || pool.length === 0)
    return { skipped: "no_labels", calls: 0, seconds: 0, ok: true, data: null };
  const step = identifySpeakersStepSchema(
    pool.map((s) => s.id),
    labels,
    { sizeLimits: true },
  );
  const body = {
    model,
    temperature: 0,
    max_tokens: IDENTIFY_MAX_TOKENS,
    chat_template_kwargs: { enable_thinking: false },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "step",
        strict: true,
        schema: await wireSchema(step),
      },
    },
    messages: [
      {
        role: "system",
        content: buildIdentifySystemPrompt({
          labels,
          title: null,
          context: null,
        }),
      },
      {
        role: "user",
        content: buildIdentifyUserPrompt(
          pool.map((s) => formatEnhanceLine(s.id, s.displayLabel, s.text)),
        ),
      },
    ],
  };
  const reply = await complete(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.text);
  } catch {
    parsed = undefined;
  }
  const check = reply.finish === "stop" ? step.zod.safeParse(parsed) : null;
  log(
    `${model} ${m.meetingId.slice(0, 8)} identify ${reply.finish} ${(reply.latencyMs / 1000).toFixed(1)}s ${reply.promptTokens} ${reply.outputTokens}`,
  );
  return {
    skipped: null,
    calls: 1,
    seconds: reply.latencyMs / 1000,
    ok: check?.success === true,
    data: check?.success ? check.data : null,
    finish: reply.finish,
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const models = (await (await fetch(`${URL_BASE}/v1/models`)).json()) as {
    data: { id: string }[];
  };
  const served = new Set(models.data.map((x) => x.id));
  const rows: Row[] = [];
  for (const model of MODELS) {
    if (!served.has(model)) {
      log(`${model} - not served`);
      rows.push({
        model,
        meeting: "-",
        calls: 0,
        seconds: 0,
        parseOk: false,
        files: "-",
        note: "not served",
      });
      continue;
    }
    const complete = workerClient(`${URL_BASE}/v1/chat/completions`, {
      model,
      timeoutMs: TIMEOUT_MS,
      parallel: 1,
    });
    for (const id8 of MEETINGS) {
      const stem = join(OUT, `${model}-${id8}`);
      const m = readPack(id8);
      const t0 = Date.now();
      try {
        const idn = await identify(complete, model, m);
        const sum: StageOutput = await runSummary(
          captureFor(model),
          m,
          { contextBudget: CONTEXT_BUDGET },
          complete,
        );
        for (const c of sum.calls)
          log(
            `${model} ${id8} summarize:${c.key} ${c.finish} ${(c.latencyMs / 1000).toFixed(1)}s - ${c.outputTokens} json=${c.jsonValid}`,
          );
        const summary = sum.summaryJson
          ? (JSON.parse(sum.summaryJson) as MeetingSummary)
          : null;
        if (summary)
          writeFileSync(
            `${stem}.summary.md`,
            `${renderSummaryMarkdown(summary)}\n`,
          );
        writeFileSync(
          `${stem}.raw.json`,
          JSON.stringify(
            {
              label: "screening, llama.cpp",
              model,
              meeting: id8,
              identify: idn,
              summary,
              summaryPartial: sum.summaryPartial,
              summaryCalls: sum.calls,
              failedUnits: sum.failedUnits,
            },
            null,
            2,
          ),
        );
        rows.push({
          model,
          meeting: id8,
          calls: idn.calls + sum.calls.length,
          seconds: (Date.now() - t0) / 1000,
          parseOk: Boolean(summary) && idn.ok,
          files: `${stem}.{summary.md,raw.json}`,
          note: [
            idn.skipped
              ? `identify ${idn.skipped}`
              : idn.ok
                ? ""
                : "identify bad",
            summary ? "" : "summary failed",
            sum.summaryPartial ? "partial" : "",
          ]
            .filter(Boolean)
            .join(", "),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`${model} ${id8} ERROR ${msg}`);
        rows.push({
          model,
          meeting: id8,
          calls: 0,
          seconds: (Date.now() - t0) / 1000,
          parseOk: false,
          files: "-",
          note: msg,
        });
      }
    }
  }
  console.log("model | meeting | calls | total s | parse ok | note | files");
  for (const r of rows)
    console.log(
      `${r.model} | ${r.meeting} | ${r.calls} | ${r.seconds.toFixed(1)} | ${r.parseOk} | ${r.note} | ${r.files}`,
    );
}

await main();
