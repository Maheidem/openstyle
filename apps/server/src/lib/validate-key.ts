/**
 * Per-provider API key validation using free, read-only endpoints.
 *
 * Each check hits a lightweight endpoint (e.g. list-models) that
 * authenticates the key without incurring usage charges.
 */

const TIMEOUT_MS = 10_000;

interface ValidationResult {
  valid: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Format pre-checks
// ---------------------------------------------------------------------------

const FORMAT_HINTS: Record<string, { prefix: string; hint: string }> = {
  openai: {
    prefix: "sk-",
    hint: 'OpenAI keys start with "sk-".',
  },
  groq: {
    prefix: "gsk_",
    hint: 'Groq keys start with "gsk_".',
  },
  openrouter: {
    prefix: "sk-or-",
    hint: 'OpenRouter keys start with "sk-or-".',
  },
};

function checkFormat(provider: string, key: string): string | null {
  const rule = FORMAT_HINTS[provider];
  if (!rule) return null;
  if (!key.startsWith(rule.prefix)) return rule.hint;
  return null;
}

// ---------------------------------------------------------------------------
// Live checks — one table entry per provider
// ---------------------------------------------------------------------------

const INVALID_KEY = "Invalid API key. Please check and try again.";

interface ProviderCheck {
  label: string;
  url: (key: string) => string;
  headers?: (key: string) => Record<string, string>;
  /** HTTP status → error message. Any other failed status gives a generic message. */
  rejected: Record<number, string>;
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

const PROVIDER_CHECKS: Record<string, ProviderCheck> = {
  openai: {
    label: "OpenAI",
    url: () => "https://api.openai.com/v1/models?limit=1",
    headers: bearer,
    rejected: {
      401: INVALID_KEY,
      403: "API key lacks permission. Check your OpenAI project settings.",
    },
  },
  groq: {
    label: "Groq",
    url: () => "https://api.groq.com/openai/v1/models",
    headers: bearer,
    rejected: { 401: INVALID_KEY },
  },
  deepgram: {
    label: "Deepgram",
    url: () => "https://api.deepgram.com/v1/projects",
    headers: (key) => ({ Authorization: `Token ${key}` }),
    rejected: { 401: INVALID_KEY },
  },
  // Use /v1/models, which a Speech-to-Text-scoped key can reach. /v1/user
  // requires the user_read permission, so a valid STT-only key would 401 there
  // and be wrongly rejected.
  elevenlabs: {
    label: "ElevenLabs",
    url: () => "https://api.elevenlabs.io/v1/models",
    headers: (key) => ({ "xi-api-key": key }),
    rejected: { 401: INVALID_KEY },
  },
  anthropic: {
    label: "Anthropic",
    url: () => "https://api.anthropic.com/v1/models",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    }),
    rejected: { 401: INVALID_KEY, 403: "API key lacks permission." },
  },
  google: {
    label: "Google",
    url: (key) =>
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`,
    rejected: { 400: INVALID_KEY, 403: INVALID_KEY },
  },
  mistral: {
    label: "Mistral",
    url: () => "https://api.mistral.ai/v1/models",
    headers: bearer,
    rejected: { 401: INVALID_KEY },
  },
  openrouter: {
    label: "OpenRouter",
    url: () => "https://openrouter.ai/api/v1/key",
    headers: bearer,
    rejected: { 401: INVALID_KEY },
  },
  vercel: {
    label: "Vercel",
    url: () => "https://ai-gateway.vercel.sh/v1/models",
    headers: bearer,
    rejected: { 401: INVALID_KEY, 403: INVALID_KEY },
  },
};

async function runCheck(
  check: ProviderCheck,
  apiKey: string,
): Promise<ValidationResult> {
  const res = await fetch(check.url(apiKey), {
    headers: check.headers?.(apiKey),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) return { valid: true };
  return {
    valid: false,
    error:
      check.rejected[res.status] ??
      `${check.label} returned HTTP ${res.status}.`,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function validateApiKey(
  provider: string,
  key: string,
): Promise<ValidationResult> {
  // 1. Format pre-check
  const formatError = checkFormat(provider, key);
  if (formatError) return { valid: false, error: formatError };

  // 2. Live check
  const check = PROVIDER_CHECKS[provider];
  if (!check) {
    // Unknown provider — skip live check, accept the key
    return { valid: true };
  }

  try {
    return await runCheck(check, key);
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return {
        valid: false,
        error: "Validation timed out. Check your network and try again.",
      };
    }
    return {
      valid: false,
      error: `Could not reach ${provider} API. Check your network and try again.`,
    };
  }
}
