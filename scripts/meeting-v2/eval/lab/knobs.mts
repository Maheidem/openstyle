// knobs.mts: the knob registry of the Eval Lab (meeting ASR stage).
//
// A knob is one input of a meeting transcription that a grid can change.
// Each knob has a name, its allowed values, its default (the shipped
// behaviour on this branch), and the way the lab applies it: a scratch-DB
// setting or row, the run name of run-baseline.mjs (diarization and the
// previous-chunk context), a server env var, or the voice model id. Every
// knob value enters the ASR cache key and the run snapshot.
//
// Add a knob only when the app code reads that input today. A constant
// in the code is "not a knob yet" (NOT_KNOBS below).

import { MLX_ASR_MODELS } from "../../../../apps/server/src/lib/mlx-asr/constants.ts";

/** How the lab applies a knob to one cell. */
export type KnobApply =
  | "model" // the default voice row of the scratch DB
  | "db-setting" // a row of the settings table of the scratch DB
  | "db-vocabulary" // the vocabulary table of the scratch DB
  | "db-meetings" // a column of the meetings rows of the scratch DB
  | "run" // the run name of run-baseline.mjs
  | "env"; // an env var of the isolated server

export interface Knob {
  name: string;
  apply: KnobApply;
  /** The setting key, column or env var that the knob sets. */
  target: string;
  default: string;
  /** The allowed values, for the help text. */
  values: string;
  /** null when the value is allowed, else the reason. */
  check: (v: string) => string | null;
  /**
   * True when the value is private (the owner name). The ledger then logs
   * "set" or "unset" and a salted fingerprint, never the value.
   */
  secret?: boolean;
  doc: string;
}

const oneOf =
  (...xs: string[]) =>
  (v: string) =>
    xs.includes(v) ? null : `must be one of ${xs.join(", ")}`;

const LANGS = /^\[("[a-z]{2,3}"(,"[a-z]{2,3}")*)?\]$/;

export const KNOBS: Knob[] = [
  {
    name: "asr_model",
    apply: "model",
    target: "model_configs voice row",
    default: "qwen3-1.7b-8bit",
    values: MLX_ASR_MODELS.map((m) => m.id).join(" | "),
    check: (v) =>
      MLX_ASR_MODELS.some((m) => m.id === v)
        ? null
        : "is not an id of the MLX ASR catalog",
    doc: "The built-in MLX ASR model. The model must be in the eval HF cache (no download).",
  },
  {
    name: "owner_name",
    apply: "db-setting",
    target: "owner_name",
    default: "unset",
    values: "unset | env (the value of LAB_OWNER_NAME)",
    check: oneOf("unset", "env"),
    secret: true,
    doc: "The owner name, the first term of the meeting bias. The name comes from the environment only.",
  },
  {
    name: "vocabulary",
    apply: "db-vocabulary",
    target: "vocabulary",
    default: "corpus",
    values: "corpus | none",
    check: oneOf("corpus", "none"),
    doc: "corpus = the vocabulary rows frozen in the corpus; none = an empty vocabulary.",
  },
  {
    name: "languages",
    apply: "db-setting",
    target: "languages",
    default: "corpus",
    values: 'corpus | unset | a JSON list of codes, for example ["en","pt"]',
    check: (v) =>
      v === "corpus" || v === "unset" || LANGS.test(v)
        ? null
        : 'must be corpus, unset or a JSON list like ["en","pt"]',
    doc: "The transcription languages setting.",
  },
  {
    name: "attendees",
    apply: "db-meetings",
    target: "calendar_attendees",
    default: "corpus",
    values: "corpus | none",
    check: oneOf("corpus", "none"),
    doc: "corpus = the calendar attendees frozen in the corpus; none = no attendees (no attendee names in the bias).",
  },
  {
    name: "context",
    apply: "db-meetings",
    target: "context",
    default: "corpus",
    values: "corpus | none",
    check: oneOf("corpus", "none"),
    doc: "corpus = the free-text meeting context frozen in the corpus; none = no context terms.",
  },
  {
    name: "diarization",
    apply: "run",
    target: "meeting_diarization_enabled",
    default: "on",
    values: "on | off",
    check: oneOf("on", "off"),
    doc: "The diarization setting (run-baseline.mjs sets it from the run name).",
  },
  {
    name: "asr_context",
    apply: "run",
    target: "meeting_asr_context",
    default: "off",
    values: "off | on",
    check: oneOf("off", "on"),
    doc: "The previous-chunk context of the ASR prompt (run-baseline.mjs sets it from the run name).",
  },
  {
    name: "max_attendee_names",
    apply: "env",
    target: "OPENSTYLE_ASR_MAX_ATTENDEE_NAMES",
    default: "20",
    values: "a whole number from 0 to 200 (20 = the app default)",
    check: (v) =>
      /^\d{1,3}$/.test(v) && Number(v) <= 200
        ? null
        : "must be a whole number from 0 to 200",
    doc: "The most attendee names in the meeting bias (bias-terms.ts). A server without the env override ignores it.",
  },
];

/** Inputs that are constants in the code: they need an app change first. */
export const NOT_KNOBS: { name: string; where: string }[] = [
  {
    name: "prompt char budget (900)",
    where: "apps/server/src/lib/vocabulary-bias.ts PROMPT_CHAR_BUDGET",
  },
  {
    name: "context terms cap (30)",
    where: "apps/server/src/lib/meetings/context-terms.ts CONTEXT_TERMS_MAX",
  },
  {
    name: "min bias duration (3000 ms)",
    where: "apps/server/src/lib/meetings/transcriber.ts MIN_BIAS_DURATION_MS",
  },
  {
    name: "context gap (30000 ms)",
    where: "apps/server/src/lib/meetings/transcriber.ts CONTEXT_GAP_MAX_MS",
  },
  {
    name: "silence gate (6 dB) and mic voiced minimum (60 ms)",
    where:
      "apps/server/src/lib/meetings/segmenter.ts SILENCE_GATE_DB, MIN_MIC_VOICED_MS",
  },
  {
    name: "segmenter cut constants",
    where:
      "apps/server/src/lib/meetings/segmenter.ts FLICKER_MS, SHORT_PART_MS, SNAP_WINDOW_MS",
  },
  {
    name: "echo and loop filters",
    where:
      "apps/server/src/lib/meetings/merge.ts ECHO_*, REPEAT_MIN_RUN, LOOP_MAX_*",
  },
  {
    name: "ASR decoding (temperature, repetition penalty)",
    where: "scripts/mlx_asr_server.py (no env override on this branch)",
  },
];

export const knobByName = new Map(KNOBS.map((k) => [k.name, k]));

/** A full knob setting: every knob has a string value. */
export type KnobValues = Record<string, string>;

/** A grid value as a string (JSON numbers and booleans are allowed). */
export function knobString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  throw new Error(`knob value ${JSON.stringify(v)} is not a string`);
}

/**
 * The full knob values of a cell: the defaults, then `set`. Throws on an
 * unknown knob or a value that is not allowed.
 */
export function resolveKnobs(set: Record<string, unknown>): KnobValues {
  const out: KnobValues = {};
  for (const k of KNOBS) out[k.name] = k.default;
  for (const [name, raw] of Object.entries(set)) {
    const k = knobByName.get(name);
    if (!k) throw new Error(`unknown knob ${name} (pnpm lab knobs)`);
    const v = knobString(raw);
    const bad = k.check(v);
    if (bad) throw new Error(`knob ${name}=${v}: ${bad}`);
    out[name] = v;
  }
  return out;
}

/** The run name of run-baseline.mjs for the run knobs. */
export function runName(kv: KnobValues): string {
  const d = kv.diarization === "on";
  const c = kv.asr_context === "on";
  if (d && !c) return "R0d";
  if (!d && !c) return "R0";
  if (d && c) return "R7base";
  return "R3c-on";
}
