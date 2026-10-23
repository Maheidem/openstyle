// audio-verify.mts: the audio second-opinion experiment for Enhance
// corrections (PR #320, issue #211). Tooling and measurement only: it does
// not change the app.
//
// Usage (from the repo root):
//   node --import ./scripts/meeting-v2/ts-register.mjs \
//     scripts/meeting-v2/eval/audio-verify.mts --model <gemma-4-e2b-qat-4bit|gemma-4-e4b-qat-4bit> \
//     --base-url http://<desktop>/v1 --audio-dir <dir with <meetingId>/{mic,system}.wav> \
//     --out <dir under /tmp/audio-verify> [--meetings <id8,...>] [--noise]
//
// Arms, per meeting (stage replay of correctChunk on the owner's desktop
// llama.cpp server; the app's code checks run on every answer):
//   A  the current correctChunk output (runCorrect of stage-replay.mts).
//   B  A, then for each applied correction that changes words: the segment
//      audio (+300 ms padding, at most CLIP_LIMIT_MS) and both texts go to
//      Gemma twice (both orders). The correction stays only when Gemma picks
//      it in both orders. A JSON-schema answer picked "A" in every order on
//      a synthetic test (position bias), so the answer is one free letter.
//   B2 A, then for each such correction: Gemma transcribes the clip, and the
//      correction stays only when its words are closer to that transcript
//      (word edit distance) than the original words.
//   In B and B2 a change of case or punctuation only stays (the audio cannot
//   judge it), and a segment longer than the clip limit keeps its
//   correction (counted as unverifiable).
//   CV C, then each change of C (against A) through the choice check of B.
//   C  A, then for each segment whose text holds a vocabulary term or a near
//      match of one (letters edit distance): the segment audio and its text
//      go to Gemma, which fixes only misheard words. checkCorrections (the
//      app's code checks) runs on the answer.
// --noise runs A, B, B2 and C again with one word changed in each prompt (the
// noise band of each arm).
//
// Scores (numbers only): normalized word errors of score.mts (the #211
// scorer, norm-v1), term recall (gold term occurrences that the output has
// at the same aligned place), term false adds, applied and dropped counts,
// audio clips, audio seconds, prompt tokens and time.
//
// Privacy: the captures, the gold keys and the audio hold real meeting
// content. Audio clips stay in memory. The console and the out files hold
// counts only. The model calls go only to --base-url (the desktop); the
// tool refuses the ports 8123 and 4649 and any 127.0.0.1 address.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { checkCorrections } from "../../../apps/server/src/lib/meetings/workflow/nodes/correct-chunk.ts";
import type { PreparedSegment } from "../../../apps/server/src/lib/meetings/workflow/types.ts";
import type { SegmentRow } from "./checks.mts";
import {
  CHANNELS,
  type Channel,
  DEFAULT_GOLD_DIR,
  type Gold,
  loadGold,
} from "./gold.mts";
import { alignWords, normalizeWords, scoreWords, words } from "./score.mts";
import {
  capturePaths,
  loadCapture,
  type MeetingInput,
  PERTURB,
  readMeeting,
  removeWorkDir,
  runCorrect,
  workerClient,
} from "./stage-replay.mts";
import { scoreStage, withCorrections } from "./stage-score.mts";

/** The longest clip sent to Gemma (Gemma 4 audio input: 30 s per clip). */
export const CLIP_LIMIT_MS = 30_000;
const PAD_MS = 300;
const LLAMA_NAMES: Record<string, string> = {
  "gemma-4-e2b-qat-4bit": "gemma4-e2b",
  "gemma-4-e4b-qat-4bit": "gemma4-e4b",
};
const NOISE_WORD: [string, string] = [
  "Listen to the audio",
  "Listen to the clip",
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

// --- Audio -----------------------------------------------------------------------------

interface Pcm {
  rate: number;
  data: Buffer;
}

/** The PCM16 mono data chunk of a WAV file. */
export function readPcm(path: string): Pcm {
  const b = readFileSync(path);
  if (
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("not a WAV file");
  let off = 12;
  let rate = 0;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt ") {
      if (
        b.readUInt16LE(off + 8) !== 1 ||
        b.readUInt16LE(off + 10) !== 1 ||
        b.readUInt16LE(off + 22) !== 16
      )
        throw new Error("the WAV file must be PCM16 mono");
      rate = b.readUInt32LE(off + 12);
    } else if (id === "data") {
      if (!rate) throw new Error("WAV data before fmt");
      return {
        rate,
        data: b.subarray(off + 8, Math.min(b.length, off + 8 + size)),
      };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("the WAV file has no data chunk");
}

/** A WAV file (in memory) of [fromMs, toMs) of the PCM. */
export function clipWav(pcm: Pcm, fromMs: number, toMs: number): Buffer {
  const at = (ms: number) =>
    Math.min(
      pcm.data.length,
      Math.max(0, Math.round((ms * pcm.rate) / 1000) * 2),
    );
  const body = pcm.data.subarray(at(fromMs), at(toMs));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + body.length, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(pcm.rate, 24);
  h.writeUInt32LE(pcm.rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(body.length, 40);
  return Buffer.concat([h, body]);
}

// --- Desktop calls with audio ------------------------------------------------------------

interface AudioStat {
  clips: number;
  audioMs: number;
  promptTokens: number;
  outputTokens: number;
  latencyMs: number;
  failed: number;
}
const newStat = (): AudioStat => ({
  clips: 0,
  audioMs: 0,
  promptTokens: 0,
  outputTokens: 0,
  latencyMs: 0,
  failed: 0,
});

function audioClient(baseUrl: string, model: string) {
  return async (
    wav: Buffer,
    text: string,
    stat: AudioStat,
    o: { maxTokens: number },
  ): Promise<string | null> => {
    const body: Record<string, unknown> = {
      model,
      temperature: 0,
      max_tokens: o.maxTokens,
      cache_prompt: false,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: wav.toString("base64"), format: "wav" },
            },
            { type: "text", text },
          ],
        },
      ],
    };
    const t0 = Date.now();
    stat.clips++;
    stat.audioMs += Math.round(((wav.length - 44) / 2 / 16000) * 1000);
    try {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const j = (await r.json().catch(() => null)) as any;
      stat.latencyMs += Date.now() - t0;
      if (r.status !== 200 || !j?.choices?.[0]) {
        stat.failed++;
        return null;
      }
      stat.promptTokens += Number(j.usage?.prompt_tokens ?? 0);
      stat.outputTokens += Number(j.usage?.completion_tokens ?? 0);
      if (j.choices[0].finish_reason !== "stop") {
        stat.failed++;
        return null;
      }
      // Strip an empty thought block if the template leaks one.
      return String(j.choices[0].message?.content ?? "")
        .replace(/<\|channel>[\s\S]*?<channel\|>/g, "")
        .trim();
    } catch {
      stat.latencyMs += Date.now() - t0;
      stat.failed++;
      return null;
    }
  };
}

export function verifyPrompt(
  first: string,
  second: string,
  noise: boolean,
): string {
  const p = `Listen to the audio. Then read two transcripts of it.\nA: ${first}\nB: ${second}\nOne transcript has wrong words. Which transcript matches the audio exactly? Reply with only the letter.`;
  return noise ? p.replace(NOISE_WORD[0], NOISE_WORD[1]) : p;
}

export function transcribePrompt(noise: boolean): string {
  return noise
    ? "Transcribe the clip exactly, word for word."
    : "Transcribe the audio exactly, word for word.";
}

export function termPrompt(
  text: string,
  terms: string[],
  noise: boolean,
): string {
  const p = `The audio is one speaker's turn in a meeting. A speech recognizer wrote this transcript of it:\n<transcript>\n${text}\n</transcript>\nKnown names and terms that can occur in it: ${terms.join(", ")}.\nListen to the audio. Fix only the words that the recognizer misheard, for example a known term that it wrote as other words. Keep every other word, every filler and the punctuation as they are. If the transcript is correct, write it again unchanged. Write only the transcript text.`;
  return noise ? p.replace(NOISE_WORD[0], NOISE_WORD[1]) : p;
}

/** The letter of a free-text choice answer ("A", "B." or "**B**"), else null. */
export function choiceOf(answer: string | null): "A" | "B" | null {
  const m = /^\W*([AB])\b/.exec(answer ?? "");
  return m ? (m[1] as "A" | "B") : null;
}

/** Word edit distance of two texts (normalized words of score.mts). */
export function wordDistance(a: string, b: string): number {
  const x = normalizeWords(scoreWords(a)).words;
  const y = normalizeWords(scoreWords(b)).words;
  return alignWords(x, y).filter((s) => s.op !== "eq").length;
}

// --- Terms ---------------------------------------------------------------------------------

function lev(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      prev[j] = Math.min(
        up + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = up;
    }
  }
  return prev[b.length] as number;
}

const letters = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The vocabulary terms that a text holds, or nearly holds: an n-gram of 1 to
 * 3 words whose letters equal the term's letters, or are within an edit
 * distance of 34 % of the term (terms of at least 4 letters).
 */
export function candidateTerms(text: string, terms: string[]): string[] {
  const ws = words(text);
  const grams: string[] = [];
  for (let n = 1; n <= 3; n++)
    for (let i = 0; i + n <= ws.length; i++)
      grams.push(ws.slice(i, i + n).join(""));
  return terms.filter((t) => {
    const tl = letters(t);
    if (tl.length < 4) return grams.includes(tl);
    return grams.some(
      (g) =>
        g === tl ||
        (Math.abs(g.length - tl.length) <= 3 && lev(g, tl) / tl.length <= 0.34),
    );
  });
}

/**
 * Term recall of one output: per channel, the meeting-level alignment of the
 * normalized gold words and output words (as scoreChannel builds them). A
 * gold occurrence of a term is found when each of its words aligns to an
 * equal output word. A false add is an output occurrence of a term that does
 * not align to equal gold words.
 */
export function termRecall(gold: Gold, rows: SegmentRow[], terms: string[]) {
  const seqs = terms
    .map((t) => normalizeWords(scoreWords(t)).words)
    .filter((s) => s.length > 0);
  let goldN = 0;
  let found = 0;
  let falseAdds = 0;
  for (const ch of CHANNELS) {
    const turns = gold.transcript?.[ch as Channel];
    if (!turns) continue;
    const ref = normalizeWords(turns.flatMap((t) => scoreWords(t.text))).words;
    const hyp = normalizeWords(
      rows
        .filter((s) => s.source === ch)
        .sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0) || a.idx - b.idx)
        .flatMap((s) => scoreWords(s.enhanced_text ?? s.text ?? "")),
    ).words;
    const steps = alignWords(ref, hyp);
    const refEq = new Set<number>();
    const hypEq = new Set<number>();
    for (const s of steps)
      if (s.op === "eq") {
        refEq.add(s.r);
        hypEq.add(s.h);
      }
    const occurrences = (ws: string[], seq: string[]) => {
      const at: number[] = [];
      for (let i = 0; i + seq.length <= ws.length; i++)
        if (seq.every((w, k) => ws[i + k] === w)) at.push(i);
      return at;
    };
    for (const seq of seqs) {
      for (const i of occurrences(ref, seq)) {
        goldN++;
        if (seq.every((_, k) => refEq.has(i + k))) found++;
      }
      for (const i of occurrences(hyp, seq))
        if (!seq.every((_, k) => hypEq.has(i + k))) falseAdds++;
    }
  }
  return { termGold: goldN, termFound: found, termFalseAdds: falseAdds };
}

// --- Arms ----------------------------------------------------------------------------------

interface SegTime {
  source: string;
  start: number;
  end: number;
}

function segTimes(dbPath: string, meetingId: string): Map<string, SegTime> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT id, source, start_ms, end_ms FROM meeting_segments WHERE meeting_id = ?",
      )
      .all(meetingId) as {
      id: string;
      source: string;
      start_ms: number;
      end_ms: number;
    }[];
    return new Map(
      rows.map((r) => [
        r.id,
        { source: r.source, start: r.start_ms, end: r.end_ms },
      ]),
    );
  } finally {
    db.close();
  }
}

const sameWords = (a: string, b: string) =>
  normalizeWords(scoreWords(a)).words.join(" ") ===
  normalizeWords(scoreWords(b)).words.join(" ");

async function runMeeting(o: {
  id8: string;
  model: string;
  baseUrl: string;
  audioDir: string;
  gold: Gold;
  noise: boolean;
}) {
  const cap = loadCapture(o.id8, o.model);
  const db = capturePaths(o.id8, o.model).db;
  const meeting: MeetingInput = readMeeting(db, cap.meetingId);
  const times = segTimes(db, cap.meetingId);
  const pcm: Record<string, Pcm> = {};
  for (const ch of CHANNELS)
    pcm[ch] = readPcm(join(o.audioDir, cap.meetingId, `${ch}.wav`));
  const llama = LLAMA_NAMES[o.model] as string;
  const complete = workerClient(`${o.baseUrl}/chat/completions`, {
    model: llama,
    parallel: 1,
    timeoutMs: 600_000,
  });
  const ask = audioClient(o.baseUrl, llama);
  const terms = meeting.app.vocabTerms;
  const segById = new Map(meeting.segments.map((s) => [s.id, s]));
  const missingTimes = meeting.segments.filter((s) => !times.has(s.id)).length;

  const clipOf = (id: string): Buffer | null => {
    const t = times.get(id);
    if (!t) return null;
    const from = Math.max(0, t.start - PAD_MS);
    const to = Math.min(t.end + PAD_MS, from + CLIP_LIMIT_MS);
    if (t.end - t.start > CLIP_LIMIT_MS - 2 * PAD_MS) return null;
    return clipWav(pcm[t.source] as Pcm, from, to);
  };

  const score = (corr: Record<string, string>) => {
    const out = {
      stage: "correctChunk" as const,
      calls: [],
      failedUnits: 0,
      corrections: corr,
      dropped: {},
    };
    const m = scoreStage("correctChunk", out, o.gold, meeting.rows);
    return {
      asrWordErrors: m.asrWordErrors,
      enhWordErrors: m.enhWordErrors,
      refWords: m.refWords,
      applied: Object.keys(corr).length,
      ...termRecall(o.gold, withCorrections(meeting.rows, corr), terms),
    };
  };

  const armA = async (noise: boolean) => {
    const t0 = Date.now();
    const out = await runCorrect(
      cap,
      meeting.app,
      {},
      complete,
      noise ? { perturb: PERTURB.correctChunk } : {},
    );
    return {
      corrections: out.corrections ?? {},
      failedUnits: out.failedUnits,
      droppedByChecks: Object.values(out.dropped ?? {}).reduce(
        (a, b) => a + b,
        0,
      ),
      seconds: Math.round((Date.now() - t0) / 1000),
    };
  };

  /**
   * B (choice): both texts in both orders; the correction stays only when
   * Gemma picks it in both orders (a position bias cannot keep it).
   * B2 (transcribe): Gemma transcribes the clip; the correction stays only
   * when its words are closer to that transcript than the original words.
   */
  const armB = async (
    a: Record<string, string>,
    noise: boolean,
    mode: "choice" | "transcribe",
    before: (id: string) => string = (id) => segById.get(id)?.text ?? "",
  ) => {
    const t0 = Date.now();
    const stat = newStat();
    const kept: Record<string, string> = {};
    let textOnly = 0;
    let unverifiable = 0;
    let droppedByAudio = 0;
    let keptByAudio = 0;
    let inconsistent = 0;
    for (const [id, text] of Object.entries(a)) {
      const orig = before(id);
      if (sameWords(orig, text)) {
        kept[id] = text;
        textOnly++;
        continue;
      }
      const wav = clipOf(id);
      if (!wav) {
        kept[id] = text;
        unverifiable++;
        continue;
      }
      let keep = false;
      if (mode === "choice") {
        const first = choiceOf(
          await ask(wav, verifyPrompt(orig, text, noise), stat, {
            maxTokens: 8,
          }),
        );
        const second = choiceOf(
          await ask(wav, verifyPrompt(text, orig, noise), stat, {
            maxTokens: 8,
          }),
        );
        keep = first === "B" && second === "A";
        if (!keep && first !== null && second !== null && first === second)
          inconsistent++;
      } else {
        const t = times.get(id) as SegTime;
        const maxTokens = Math.min(
          1024,
          Math.ceil((t.end - t.start + 2 * PAD_MS) / 1000) * 6 + 32,
        );
        const heard = await ask(wav, transcribePrompt(noise), stat, {
          maxTokens,
        });
        if (heard !== null)
          keep = wordDistance(heard, text) < wordDistance(heard, orig);
      }
      if (keep) {
        kept[id] = text;
        keptByAudio++;
      } else droppedByAudio++;
    }
    return {
      corrections: kept,
      textOnly,
      unverifiable,
      keptByAudio,
      droppedByAudio,
      inconsistent,
      ...stat,
      seconds: Math.round((Date.now() - t0) / 1000),
    };
  };

  const armC = async (b: Record<string, string>, noise: boolean) => {
    const t0 = Date.now();
    const stat = newStat();
    const out: Record<string, string> = { ...b };
    let candidates = 0;
    let tooLong = 0;
    let changed = 0;
    let droppedByChecks = 0;
    let unchanged = 0;
    for (const s of meeting.segments) {
      const cur = b[s.id] ?? s.text;
      const found = candidateTerms(cur, terms);
      if (found.length === 0) continue;
      candidates++;
      const wav = clipOf(s.id);
      if (!wav) {
        tooLong++;
        continue;
      }
      const maxTokens = Math.min(1024, Math.ceil(cur.length / 2) + 64);
      const ans = await ask(wav, termPrompt(cur, found, noise), stat, {
        maxTokens,
      });
      if (ans === null) continue;
      const text = ans
        .replace(/^<transcript>\s*|\s*<\/transcript>$/g, "")
        .trim();
      if (text === cur.trim()) {
        unchanged++;
        continue;
      }
      // The app's code checks, against the raw segment text.
      const seg: PreparedSegment = { ...s };
      const checked = checkCorrections([{ id: s.id, text }], [seg], null);
      if (checked.corrections.length === 1) {
        out[s.id] = (checked.corrections[0] as { text: string }).text;
        changed++;
      } else droppedByChecks++;
    }
    return {
      corrections: out,
      candidates,
      tooLong,
      changed,
      unchanged,
      droppedByChecks,
      ...stat,
      seconds: Math.round((Date.now() - t0) / 1000),
    };
  };

  const strip = <T extends { corrections: Record<string, string> }>(x: T) => {
    const { corrections, ...rest } = x;
    return rest;
  };
  const vsA = (s: { enhWordErrors: number | null }, aErr: number | null) =>
    s.enhWordErrors != null && aErr != null ? s.enhWordErrors - aErr : null;

  const run = async (noise: boolean) => {
    const a = await armA(noise);
    const b = await armB(a.corrections, noise, "choice");
    const b2 = await armB(a.corrections, noise, "transcribe");
    const c = await armC(a.corrections, noise);
    // CV: the changes of C (against A) through the choice check of B.
    const aText = (id: string) =>
      a.corrections[id] ?? segById.get(id)?.text ?? "";
    const cChanges = Object.fromEntries(
      Object.entries(c.corrections).filter(([id, t]) => t !== aText(id)),
    );
    const cv = await armB(cChanges, noise, "choice", aText);
    const cvAll = { ...a.corrections, ...cv.corrections };
    const sCV = score(cvAll);
    const sA = score(a.corrections);
    const sB = score(b.corrections);
    const sB2 = score(b2.corrections);
    const sC = score(c.corrections);
    return {
      A: { ...sA, ...strip(a) },
      B: { ...sB, vsA: vsA(sB, sA.enhWordErrors), ...strip(b) },
      B2: { ...sB2, vsA: vsA(sB2, sA.enhWordErrors), ...strip(b2) },
      C: { ...sC, vsA: vsA(sC, sA.enhWordErrors), ...strip(c) },
      CV: {
        ...sCV,
        vsA: vsA(sCV, sA.enhWordErrors),
        ...strip(cv),
        applied: Object.keys(cvAll).length,
      },
      ASR: score({}),
    };
  };
  const base = await run(false);
  const perturbed = o.noise ? await run(true) : null;
  return {
    meeting: o.id8,
    segments: meeting.segments.length,
    segmentsWithoutTimes: missingTimes,
    vocabTerms: terms.length,
    base,
    noise: perturbed,
  };
}

async function main(): Promise<number> {
  const model = arg("model") ?? "";
  const baseUrl = arg("base-url") ?? "";
  const audioDir = arg("audio-dir") ?? "";
  const outDir = arg("out") ?? "";
  if (!LLAMA_NAMES[model])
    throw new Error(
      "--model must be gemma-4-e2b-qat-4bit or gemma-4-e4b-qat-4bit",
    );
  const u = new URL(baseUrl);
  if (
    ["8123", "4649"].includes(u.port) ||
    /^(127\.|localhost$|\[::1\]$)/.test(u.hostname)
  )
    throw new Error("--base-url must be the desktop server");
  if (!outDir.startsWith("/tmp/audio-verify/"))
    throw new Error("--out must be under /tmp/audio-verify/");
  const ids = (arg("meetings") ?? "2943c36a,5578edb0,ca70f895,9243bea0").split(
    ",",
  );
  const golds = loadGold(ids, DEFAULT_GOLD_DIR);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const results = [];
  try {
    for (const id8 of ids) {
      const t0 = Date.now();
      const r = await runMeeting({
        id8,
        model,
        baseUrl,
        audioDir,
        gold: golds.get(id8) as Gold,
        noise: process.argv.includes("--noise"),
      });
      results.push({ ...r, wallSeconds: Math.round((Date.now() - t0) / 1000) });
      const n = (x: unknown) => JSON.stringify(x);
      console.log(
        `${model} ${id8}: A ${n(r.base.A.enhWordErrors)} B ${n(r.base.B.enhWordErrors)} B2 ${n(r.base.B2.enhWordErrors)} C ${n(r.base.C.enhWordErrors)} CV ${n(r.base.CV.enhWordErrors)} (ASR ${n(r.base.A.asrWordErrors)}), ${Math.round((Date.now() - t0) / 1000)} s`,
      );
    }
  } finally {
    removeWorkDir();
  }
  const file = join(outDir, `${model}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ model, clipLimitMs: CLIP_LIMIT_MS, padMs: PAD_MS, results }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  console.log(`results (numbers only): ${file}`);
  return 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(`audio-verify failed: ${(e as Error).message}`);
    process.exit(1);
  },
);
