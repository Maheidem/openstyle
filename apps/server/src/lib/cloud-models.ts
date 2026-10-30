/**
 * The cloud model line-up of the app: which cloud models the picker shows by
 * default, which ids a provider retired, and which ids are legacy.
 *
 * Checked against the provider documentation on 2026-10-30:
 * - Anthropic: platform.claude.com/docs/en/about-claude/models/overview and
 *   .../about-claude/model-deprecations
 * - OpenAI: platform.openai.com/docs/models and /docs/deprecations
 * - Google: ai.google.dev/gemini-api/docs/models and /docs/deprecations
 * - Groq: console.groq.com/docs/models and /docs/deprecations
 * - Mistral: docs.mistral.ai/models (models overview)
 *
 * The LLM list in the picker still comes from the models.dev registry. This
 * file adds the curated line-up on top of it, so a new model shows up when the
 * registry is late or offline. Prices are USD per 1M tokens, from the provider
 * pages above.
 */
import { createAppLogger } from "@openstyle/utils";
import { getDb } from "./db.js";
import { stripModelPrefix } from "./model-id.js";

const log = createAppLogger("cloud-models");

type LineupRole = "capable" | "fast" | "more";

interface CloudLlmEntry {
  providerId: string;
  providerName: string;
  /** The id the provider API takes, without a provider prefix. */
  id: string;
  name: string;
  family: string;
  /** capable: newest capable model. fast: cheaper and faster. more: others. */
  role: LineupRole;
  costInput: number;
  costOutput: number;
}

/** The cloud LLM line-up. Order: capable, fast, more, per provider. */
export const CLOUD_LLM_LINEUP: readonly CloudLlmEntry[] = [
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    family: "claude-sonnet",
    role: "capable",
    costInput: 2,
    costOutput: 10,
  },
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    family: "claude-haiku",
    role: "fast",
    costInput: 0.1,
    costOutput: 0.5,
  },
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    family: "claude-opus",
    role: "more",
    costInput: 4,
    costOutput: 20,
  },
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    family: "claude-fable",
    role: "more",
    costInput: 10,
    costOutput: 50,
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    family: "gpt",
    role: "capable",
    costInput: 2,
    costOutput: 10,
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    family: "gpt",
    role: "fast",
    costInput: 0.1,
    costOutput: 0.5,
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    id: "gpt-6.1-terra",
    name: "GPT-6.1 Terra",
    family: "gpt",
    role: "more",
    costInput: 1,
    costOutput: 5,
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    family: "gpt",
    role: "more",
    costInput: 10,
    costOutput: 50,
  },
  {
    providerId: "google",
    providerName: "Google",
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    family: "gemini-flash",
    role: "capable",
    costInput: 0.75,
    costOutput: 3.75,
  },
  {
    providerId: "google",
    providerName: "Google",
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash-Lite",
    family: "gemini-flash-lite",
    role: "fast",
    costInput: 0.3,
    costOutput: 2.5,
  },
  {
    providerId: "google",
    providerName: "Google",
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    family: "gemini",
    role: "more",
    costInput: 2,
    costOutput: 10,
  },
  {
    providerId: "groq",
    providerName: "Groq",
    id: "openai/gpt-oss-120b",
    name: "GPT OSS 120B",
    family: "gpt-oss",
    role: "capable",
    costInput: 0.15,
    costOutput: 0.6,
  },
  {
    providerId: "groq",
    providerName: "Groq",
    id: "openai/gpt-oss-20b",
    name: "GPT OSS 20B",
    family: "gpt-oss",
    role: "fast",
    costInput: 0.075,
    costOutput: 0.3,
  },
  {
    providerId: "mistral",
    providerName: "Mistral",
    id: "mistral-large-4",
    name: "Mistral Large 4",
    family: "mistral-large",
    role: "capable",
    costInput: 0.7,
    costOutput: 2.1,
  },
  {
    providerId: "mistral",
    providerName: "Mistral",
    id: "mistral-small-latest",
    name: "Mistral Small 4",
    family: "mistral-small",
    role: "fast",
    costInput: 0.15,
    costOutput: 0.6,
  },
];

/** The `provider/model` keys of the models the picker shows by default. */
export const CURATED_LLM_IDS: ReadonlySet<string> = new Set(
  CLOUD_LLM_LINEUP.map((m) => `${m.providerId}/${m.id}`),
);

/** True when the line-up holds this cloud LLM, with or without the prefix. */
export function isLineupCloudLlm(providerId: string, modelId: string): boolean {
  return CURATED_LLM_IDS.has(
    `${providerId}/${stripModelPrefix(providerId, modelId)}`,
  );
}

interface CloudVoiceEntry {
  providerId: string;
  providerName: string;
  /** The `provider/model` id the app stores. */
  modelId: string;
  name: string;
  family: string;
}

/**
 * The curated cloud speech-to-text models. The models.dev registry is not
 * merged for voice (untested model noise). Newest first, per provider.
 */
export const CLOUD_VOICE_LINEUP: readonly CloudVoiceEntry[] = [
  {
    providerId: "openai",
    providerName: "OpenAI",
    modelId: "openai/gpt-live-transcribe",
    name: "OpenAI Live Transcribe",
    family: "whisper",
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    modelId: "openai/gpt-transcribe",
    name: "OpenAI Transcribe",
    family: "whisper",
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    modelId: "openai/gpt-4o-transcribe",
    name: "OpenAI GPT-4o Transcribe",
    family: "whisper",
  },
  {
    providerId: "groq",
    providerName: "Groq",
    modelId: "groq/whisper-large-v3-turbo",
    name: "Groq Whisper Turbo",
    family: "whisper",
  },
  {
    providerId: "groq",
    providerName: "Groq",
    modelId: "groq/whisper-large-v3",
    name: "Groq Whisper Large v3",
    family: "whisper",
  },
  {
    providerId: "deepgram",
    providerName: "Deepgram",
    modelId: "deepgram/nova-3",
    name: "Deepgram Nova 3",
    family: "deepgram",
  },
  {
    providerId: "elevenlabs",
    providerName: "ElevenLabs",
    modelId: "elevenlabs/scribe_v2_realtime",
    name: "ElevenLabs Scribe",
    family: "elevenlabs",
  },
  {
    providerId: "soniox",
    providerName: "Soniox",
    modelId: "soniox/stt-rt-v5",
    name: "Soniox Realtime v5",
    family: "soniox",
  },
];

interface Lifecycle {
  /**
   * retired: the provider says the id no longer works. A saved selection moves
   * to `replacement`. legacy: the id works but the provider plans to remove it.
   */
  status: "retired" | "legacy";
  /** The date the provider shuts the id down (ISO), when known. */
  shutdown?: string;
  /** The model that replaces it. Always an id of the same provider. */
  replacement?: string;
}

const retired = (shutdown: string, replacement: string): Lifecycle => ({
  status: "retired",
  shutdown,
  replacement,
});
const legacy = (
  shutdown: string | undefined,
  replacement: string,
): Lifecycle => ({
  status: "legacy",
  ...(shutdown ? { shutdown } : {}),
  replacement,
});

/**
 * Lifecycle of cloud model ids, keyed `provider/model`. Dates are the shutdown
 * dates of the provider pages. The replacement is the same tier in the line-up.
 */
const LIFECYCLE: Readonly<Record<string, Lifecycle>> = {
  // Anthropic: model-deprecations page.
  "anthropic/claude-opus-4-1-20250805": retired(
    "2026-08-05",
    "claude-opus-5-5",
  ),
  "anthropic/claude-opus-4-20250514": retired("2026-06-15", "claude-opus-5-5"),
  "anthropic/claude-sonnet-4-20250514": retired(
    "2026-06-15",
    "claude-sonnet-5-5",
  ),
  "anthropic/claude-3-7-sonnet-20250219": retired(
    "2026-02-19",
    "claude-sonnet-5-5",
  ),
  "anthropic/claude-3-5-haiku-20241022": retired(
    "2026-02-19",
    "claude-haiku-5-5",
  ),
  "anthropic/claude-3-haiku-20240307": retired(
    "2026-04-20",
    "claude-haiku-5-5",
  ),
  "anthropic/claude-3-5-sonnet-20241022": retired(
    "2025-10-28",
    "claude-sonnet-5-5",
  ),
  "anthropic/claude-3-5-sonnet-20240620": retired(
    "2025-10-28",
    "claude-sonnet-5-5",
  ),
  "anthropic/claude-3-opus-20240229": retired("2026-01-05", "claude-opus-5-5"),
  "anthropic/claude-sonnet-4-5-20250929": legacy(
    "2026-11-30",
    "claude-sonnet-5-5",
  ),
  "anthropic/claude-sonnet-4-5": legacy("2026-11-30", "claude-sonnet-5-5"),
  "anthropic/claude-haiku-4-5-20251001": legacy(undefined, "claude-haiku-5-5"),
  "anthropic/claude-haiku-4-5": legacy(undefined, "claude-haiku-5-5"),
  "anthropic/claude-opus-4-5-20251101": legacy(undefined, "claude-opus-5-5"),
  "anthropic/claude-opus-4-5": legacy(undefined, "claude-opus-5-5"),

  // OpenAI: deprecations page.
  "openai/gpt-4o": legacy("2027-01-14", "gpt-6-luna"),
  "openai/gpt-4o-mini": legacy("2027-01-14", "gpt-6-luna"),
  "openai/gpt-4.1": legacy("2027-01-14", "gpt-6-luna"),
  "openai/gpt-4.1-mini": legacy("2027-01-14", "gpt-6-luna"),
  "openai/gpt-5": legacy("2026-12-11", "gpt-6.1-sol"),
  "openai/gpt-5-mini": legacy("2026-12-11", "gpt-6.1-terra"),
  "openai/gpt-5-nano": legacy("2026-12-11", "gpt-6-luna"),
  "openai/gpt-5.1": legacy("2027-04-01", "gpt-6.1-sol"),
  "openai/gpt-5.4-nano": legacy("2027-04-01", "gpt-6-luna"),
  "openai/o3": legacy("2026-12-11", "gpt-6.1-sol"),
  // OpenAI speech-to-text: removal on 2027-02-26.
  "openai/gpt-4o-transcribe": legacy("2027-02-26", "gpt-live-transcribe"),
  "openai/gpt-4o-mini-transcribe": legacy("2027-02-26", "gpt-live-transcribe"),
  "openai/whisper-1": legacy("2027-02-26", "gpt-live-transcribe"),

  // Google: deprecations page. Gemini 2.5 stays served for existing users.
  "google/gemini-3-pro-preview": retired(
    "2026-03-09",
    "gemini-3.1-pro-preview",
  ),
  "google/gemini-3.1-flash-lite-preview": retired(
    "2026-05-25",
    "gemini-3.1-flash-lite",
  ),
  "google/gemini-2.0-flash": retired("2026-06-01", "gemini-3.8-flash"),
  "google/gemini-2.0-flash-001": retired("2026-06-01", "gemini-3.8-flash"),
  "google/gemini-2.0-flash-lite": retired(
    "2026-06-01",
    "gemini-3.5-flash-lite",
  ),
  "google/gemini-2.0-flash-lite-001": retired(
    "2026-06-01",
    "gemini-3.5-flash-lite",
  ),
  "google/gemini-2.5-flash-preview-05-20": retired(
    "2025-11-18",
    "gemini-3.8-flash",
  ),
  "google/gemini-2.5-flash-preview-09-25": retired(
    "2026-02-17",
    "gemini-3.8-flash",
  ),
  "google/gemini-2.5-flash-lite-preview-09-2025": retired(
    "2026-03-31",
    "gemini-3.5-flash-lite",
  ),
  "google/gemini-3.1-flash-lite": legacy("2027-05-07", "gemini-3.5-flash-lite"),
  "google/gemini-2.5-flash": legacy(undefined, "gemini-3.8-flash"),
  "google/gemini-2.5-flash-lite": legacy(undefined, "gemini-3.5-flash-lite"),
  "google/gemini-2.5-pro": legacy(undefined, "gemini-3.8-flash"),

  // Groq: deprecations page. Llama 3.1 8B and Llama 3.3 70B are listed only
  // for Enterprise customers on the models page, so they stay legacy.
  "groq/mistral-saba-24b": retired("2025-07-30", "openai/gpt-oss-120b"),
  "groq/qwen/qwen3-32b": retired("2026-07-17", "openai/gpt-oss-120b"),
  "groq/qwen-qwq-32b": retired("2025-07-14", "openai/gpt-oss-120b"),
  "groq/qwen/qwen3.6-27b": retired("2026-09-14", "qwen/qwen3.8-27b"),
  "groq/meta-llama/llama-4-scout-17b-16e-instruct": retired(
    "2026-07-17",
    "openai/gpt-oss-120b",
  ),
  "groq/meta-llama/llama-4-maverick-17b-128e-instruct": retired(
    "2026-03-09",
    "openai/gpt-oss-120b",
  ),
  "groq/moonshotai/kimi-k2-instruct-0905": retired(
    "2026-04-15",
    "openai/gpt-oss-120b",
  ),
  "groq/moonshotai/kimi-k2-instruct": retired(
    "2025-10-10",
    "openai/gpt-oss-120b",
  ),
  "groq/gemma2-9b-it": retired("2025-10-08", "openai/gpt-oss-20b"),
  "groq/deepseek-r1-distill-llama-70b": retired(
    "2025-10-02",
    "openai/gpt-oss-120b",
  ),
  "groq/llama3-70b-8192": retired("2025-08-30", "openai/gpt-oss-120b"),
  "groq/llama3-8b-8192": retired("2025-08-30", "openai/gpt-oss-20b"),
  "groq/llama-3.1-8b-instant": legacy("2026-08-16", "openai/gpt-oss-20b"),
  "groq/llama-3.3-70b-versatile": legacy("2026-08-16", "openai/gpt-oss-120b"),

  // Mistral: models overview, "Deprecated and retired models".
  "mistral/mistral-saba-2502": retired("2025-09-30", "mistral-small-latest"),
  "mistral/mistral-small-2503": retired("2025-11-30", "mistral-small-latest"),
  "mistral/mistral-small-2501": retired("2025-11-30", "mistral-small-latest"),
  "mistral/mistral-small-2409": retired("2025-11-30", "mistral-small-latest"),
  "mistral/codestral-2501": retired("2025-11-30", "mistral-small-latest"),
  "mistral/magistral-small-2507": retired("2025-11-30", "mistral-small-latest"),
  "mistral/magistral-small-2506": retired("2025-11-30", "mistral-small-latest"),
  "mistral/magistral-medium-2507": retired("2025-11-30", "mistral-large-4"),
  "mistral/magistral-medium-2506": retired("2025-11-30", "mistral-large-4"),
  "mistral/mistral-medium-3-5": legacy("2027-04-30", "mistral-large-4"),
  "mistral/mistral-medium-latest": legacy("2027-04-30", "mistral-large-4"),
  "mistral/mistral-large-2512": legacy("2027-04-30", "mistral-large-4"),
  "mistral/mistral-small-2506": legacy("2026-07-31", "mistral-small-latest"),
};

function lifecycleOf(providerId: string, modelId: string): Lifecycle | null {
  return (
    LIFECYCLE[`${providerId}/${stripModelPrefix(providerId, modelId)}`] ?? null
  );
}

/** The model that replaces a retired cloud model, or null when it is not retired. */
export function retiredReplacement(
  providerId: string,
  modelId: string,
): { modelId: string; message: string } | null {
  const entry = lifecycleOf(providerId, modelId);
  if (entry?.status !== "retired" || !entry.replacement) return null;
  const short = stripModelPrefix(providerId, modelId);
  return {
    modelId: entry.replacement,
    message: `${providerId} retired the model "${short}"${
      entry.shutdown ? ` on ${entry.shutdown}` : ""
    }. Openstyle uses "${entry.replacement}" instead. Pick a model again under Models to change it.`,
  };
}

/** A short note for a legacy model (shown in the picker), or null. */
export function legacyNotice(
  providerId: string,
  modelId: string,
): string | null {
  const entry = lifecycleOf(providerId, modelId);
  if (entry?.status !== "legacy") return null;
  const when = entry.shutdown
    ? `${providerId} removes it on ${entry.shutdown}`
    : `${providerId} no longer updates it`;
  return `Legacy: ${when}. Use ${entry.replacement ?? "a newer model"}.`;
}

/** Display name of a model the line-up knows, else the id. */
function displayNameOf(providerId: string, modelId: string): string {
  const short = stripModelPrefix(providerId, modelId);
  return (
    CLOUD_LLM_LINEUP.find((m) => m.providerId === providerId && m.id === short)
      ?.name ?? short
  );
}

const warned = new Set<string>();

/** Log the retired-model message once for each model and process. */
export function warnRetiredOnce(
  providerId: string,
  modelId: string,
  message: string,
): void {
  const key = `${providerId}/${modelId}`;
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(message);
}

/**
 * Move saved LLM selections that name a retired cloud model to the
 * replacement. A call to a retired id fails at the provider, so the saved row
 * would break every cleanup call. Returns the number of rows that changed.
 */
export function reconcileRetiredCloudLlmModels(): number {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, provider, model_id, is_default FROM model_configs WHERE type = 'llm'",
    )
    .all() as {
    id: number;
    provider: string;
    model_id: string;
    is_default: number;
  }[];
  let changed = 0;
  for (const row of rows) {
    const next = retiredReplacement(row.provider, row.model_id);
    if (!next) continue;
    warnRetiredOnce(row.provider, row.model_id, next.message);
    // Keep the id style of the saved row: with or without the provider prefix.
    const storedId = row.model_id.startsWith(`${row.provider}/`)
      ? `${row.provider}/${next.modelId}`
      : next.modelId;
    // The replacement row may exist. Keep one row, and keep the default flag.
    const existing = db
      .prepare(
        "SELECT id FROM model_configs WHERE type = 'llm' AND provider = ? AND model_id = ?",
      )
      .get(row.provider, storedId) as { id: number } | undefined;
    if (existing) {
      if (row.is_default) {
        db.prepare("UPDATE model_configs SET is_default = 1 WHERE id = ?").run(
          existing.id,
        );
      }
      db.prepare("DELETE FROM model_configs WHERE id = ?").run(row.id);
    } else {
      db.prepare(
        "UPDATE model_configs SET model_id = ?, model_name = ? WHERE id = ?",
      ).run(storedId, displayNameOf(row.provider, next.modelId), row.id);
    }
    changed++;
  }
  return changed;
}
