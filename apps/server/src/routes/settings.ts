import { zValidator } from "@hono/zod-validator";
import {
  localLlmConfigSchema,
  normalizeOmlxRoot,
  omlxConfigSchema,
  omlxModelsUrl,
  omlxTranscribeUrl,
  openaiSttConfigSchema,
  SETTINGS_KEYS,
  settingValueSchema,
} from "@openstyle/validations";
import { Hono } from "hono";
import { getDb } from "../lib/db.js";
import {
  HISTORY_RETENTION_SETTING_KEY,
  purgeExpiredHistory,
} from "../lib/history-store.js";
import { applyMlxAsrRetentionPolicy } from "../lib/mlx-asr/server.js";
import {
  CA_CERT_PATH_SETTING,
  configureNetwork,
  PROXY_URL_SETTING,
} from "../lib/network.js";
import { validateSetting } from "../lib/setting-validators.js";
import { applyWhisperRetentionPolicy } from "../lib/whisper/server.js";

/**
 * Normalize an OpenAI-compatible base URL for the `/v1/models` probe.
 *
 * Strips any trailing slashes and a trailing OpenAI path segment so that a
 * user who pastes a specific endpoint (e.g. `.../v1/audio/transcriptions`) or
 * the versioned base (`.../v1`) still resolves to the true base. The probe
 * then appends `/v1/models`.
 */
function normalizeOpenaiBaseUrl(input: string): string {
  return input.replace(/\/+$/, "").replace(/\/v1(?:\/[^?#]*)?$/, "");
}

// ---------------------------------------------------------------------------
// Credential redaction — GET /api/settings dumps the whole settings table,
// which includes BYOK credentials (oMLX / local-LLM / custom-STT API keys)
// alongside ordinary preferences. Mask anything credential-shaped there so a
// casual read of the bulk listing never returns a secret in the clear.
//
// A plain substring match on "key" would also catch `hotkey` / `hotkey_mode`
// / `remix_hotkey` — real, non-secret settings the Settings UI displays
// directly (settings.tsx reads `s[SETTINGS_KEYS.hotkey]` straight off this
// endpoint) — and redacting those would show a placeholder instead of the
// user's configured hotkey. Matching whole underscore-delimited segments
// instead avoids that false positive while still catching every current
// credential key (`local_llm_api_key`, `omlx_api_key`, `openai_stt_api_key`
// each end in a bare `key` segment) and any future one shaped the same way.
// ---------------------------------------------------------------------------

const CREDENTIAL_SEGMENTS = new Set([
  "key",
  "token",
  "secret",
  "password",
  "apikey",
]);

function isCredentialKey(key: string): boolean {
  return key
    .split("_")
    .some((segment) => CREDENTIAL_SEGMENTS.has(segment.toLowerCase()));
}

/**
 * Placeholder returned in place of a credential-shaped value. Non-empty and
 * truthy on purpose: the Settings UI seeds its API-key form fields straight
 * from GET /api/settings (see `useEndpointConnect`'s `initialApiKey`), and an
 * empty string there would look like "no key configured" and delete the real
 * one on the next unrelated save. A distinctive non-empty placeholder instead
 * round-trips safely — see the PUT handler and the `/test` probes below,
 * which both recognize it and route around it rather than persisting or
 * transmitting the literal placeholder text.
 */
const REDACTED_VALUE = "••••••••";

/** Raw stored value for one setting, straight from the DB (never redacted). */
function readStoredSetting(key: string): string | undefined {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * The Settings UI's connection-test forms (local LLM / oMLX / custom STT)
 * seed their API-key field from the (now redacted) bulk listing and resend
 * whatever's in that field on every Test click, even when the user only
 * edited the URL. If that resend is the untouched placeholder, use the real
 * stored key for the outbound probe instead of literally sending
 * "••••••••" to the third-party endpoint as a bearer token.
 */
function resolveTestApiKey(
  settingsKey: string,
  provided: string | undefined,
): string | undefined {
  return provided === REDACTED_VALUE
    ? readStoredSetting(settingsKey)
    : provided;
}

/** Run after a successful PUT of the key. */
const SETTING_SIDE_EFFECTS: ReadonlyMap<string, () => void> = new Map([
  [SETTINGS_KEYS.mlxAsrKeepAliveMinutes, applyMlxAsrRetentionPolicy],
  [SETTINGS_KEYS.whisperKeepAliveMinutes, applyWhisperRetentionPolicy],
  [HISTORY_RETENTION_SETTING_KEY, purgeExpiredHistory],
]);

/** PUT and DELETE of these keys must reset the global network dispatcher. */
function isNetworkSetting(key: string): boolean {
  return key === PROXY_URL_SETTING || key === CA_CERT_PATH_SETTING;
}

const settings = new Hono()
  .get("/", (c) => {
    const db = getDb();
    const rows = db.prepare("SELECT key, value FROM settings").all() as {
      key: string;
      value: string;
    }[];

    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = isCredentialKey(row.key) ? REDACTED_VALUE : row.value;
    }
    return c.json(result);
  })
  .get("/:key", (c) => {
    const db = getDb();
    const key = c.req.param("key");
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;

    if (!row) {
      return c.json({ error: "Setting not found" }, 404);
    }
    return c.json({ key, value: row.value });
  })
  .put("/:key", zValidator("json", settingValueSchema), async (c) => {
    const db = getDb();
    const key = c.req.param("key");
    const body = c.req.valid("json");

    // The settings UI seeds credential-shaped fields from the (redacted) GET
    // above and resends that value on every save, including ones that never
    // touched the key field. Treat an untouched resend of the placeholder as
    // a no-op — leave the real stored value alone — instead of overwriting a
    // real secret with the literal placeholder text.
    if (isCredentialKey(key) && body.value === REDACTED_VALUE) {
      return c.json({ key, value: REDACTED_VALUE });
    }

    // Key-specific validation for settings with constrained value shapes.
    const validationError = validateSetting(key, body.value);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(key, String(body.value));

    SETTING_SIDE_EFFECTS.get(key)?.();
    // Re-install the global dispatcher so proxy/CA changes take effect for the
    // next download without an app restart.
    if (isNetworkSetting(key)) {
      configureNetwork();
    }

    // Never echo a real credential value back in a response body — mask it
    // here too, consistent with the GET listing above.
    return c.json({
      key,
      value: isCredentialKey(key) ? REDACTED_VALUE : body.value,
    });
  })
  .delete("/:key", (c) => {
    const db = getDb();
    const key = c.req.param("key");
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    // Deleting the proxy/CA key must also reset the global dispatcher, mirroring
    // the PUT path — otherwise a stale proxy/CA lingers until the next restart.
    if (isNetworkSetting(key)) {
      configureNetwork();
    }
    return c.json({ ok: true });
  })
  .post(
    "/local-llm/test",
    zValidator("json", localLlmConfigSchema),
    async (c) => {
      const body = c.req.valid("json");
      const url = normalizeOpenaiBaseUrl(body.url);
      const apiKey = resolveTestApiKey(
        SETTINGS_KEYS.localLlmApiKey,
        body.api_key,
      );

      try {
        const res = await fetch(`${url}/v1/models`, {
          headers: {
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) {
          return c.json(
            { error: `Server returned ${res.status}: ${res.statusText}` },
            502,
          );
        }

        const data = (await res.json()) as {
          data?: { id: string }[];
        };

        let models: string[] = [];
        if (data.data && Array.isArray(data.data)) {
          models = data.data.map((m) => m.id);
        }

        return c.json({ ok: true, models });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to connect";
        return c.json({ error: message }, 502);
      }
    },
  )
  .post(
    "/openai-stt/test",
    zValidator("json", openaiSttConfigSchema),
    async (c) => {
      const body = c.req.valid("json");
      const url = normalizeOpenaiBaseUrl(body.url);
      const apiKey = resolveTestApiKey(
        SETTINGS_KEYS.openaiSttApiKey,
        body.api_key,
      );

      try {
        const res = await fetch(`${url}/v1/models`, {
          headers: {
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) {
          return c.json(
            { error: `Server returned ${res.status}: ${res.statusText}` },
            502,
          );
        }

        const data = (await res.json()) as {
          data?: { id: string }[];
        };

        let models: string[] = [];
        if (data.data && Array.isArray(data.data)) {
          models = data.data.map((m) => m.id);
        }

        return c.json({ ok: true, models });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to connect";
        return c.json({ error: message }, 502);
      }
    },
  )
  .post("/omlx/test", zValidator("json", omlxConfigSchema), async (c) => {
    const body = c.req.valid("json");
    // One normalizer for both URLs, so the probe can never report a server the
    // transcription request then 404s on.
    const root = normalizeOmlxRoot(body.url);
    const transcribeUrl = omlxTranscribeUrl(root);
    const apiKey = resolveTestApiKey(SETTINGS_KEYS.omlxApiKey, body.api_key);
    const auth: Record<string, string> = apiKey
      ? { Authorization: `Bearer ${apiKey}` }
      : {};

    try {
      const res = await fetch(omlxModelsUrl(root), {
        headers: auth,
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        return c.json(
          { error: `Server returned ${res.status}: ${res.statusText}` },
          502,
        );
      }

      const data = (await res.json()) as {
        data?: { id: string }[];
      };

      // Every id is listed — oMLX reports no modality, and the user knows
      // which of their models is the ASR one.
      let models: string[] = [];
      if (data.data && Array.isArray(data.data)) {
        models = data.data.map((m) => m.id);
      }

      // Prove the transcription route exists too. A field-less POST gets a
      // validation error (oMLX answers 422) when the route is mounted, and a
      // 404 when it is not — no audio needs to be sent either way.
      const probe = await fetch(transcribeUrl, {
        method: "POST",
        headers: auth,
        signal: AbortSignal.timeout(5000),
      });
      if (probe.status === 404) {
        return c.json(
          { error: `No transcription endpoint at ${transcribeUrl}` },
          502,
        );
      }

      return c.json({ ok: true, models, transcribeUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect";
      return c.json({ error: message }, 502);
    }
  });

export default settings;
