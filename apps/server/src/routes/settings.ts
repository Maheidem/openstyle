import { zValidator } from "@hono/zod-validator";
import { SETTINGS_KEYS, settingValueSchema } from "@openstyle/validations";
import { Hono } from "hono";
import { getDb, writeSetting } from "../lib/db.js";
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

// ---------------------------------------------------------------------------
// Credential redaction — GET /api/settings dumps the whole settings table,
// which can include credentials alongside ordinary preferences. Mask anything
// credential-shaped there so a casual read of the bulk listing never returns a secret in the clear.
//
// A plain substring match on "key" would also catch `hotkey` / `hotkey_mode`
// / `remix_hotkey` — real, non-secret settings the Settings UI displays
// directly (settings.tsx reads `s[SETTINGS_KEYS.hotkey]` straight off this
// endpoint) — and redacting those would show a placeholder instead of the
// user's configured hotkey. Matching whole underscore-delimited segments
// instead avoids that false positive while still catching every current
// credential key (a name that ends in a bare `key` segment, such as the old
// `local_llm_api_key`) and any future one shaped the same way.
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
 * truthy on purpose: a client that seeds a form field from GET /api/settings
 * must not read an empty string as "no key configured". The PUT handler
 * recognizes the placeholder and routes around it, so it never persists the
 * literal placeholder text.
 */
const REDACTED_VALUE = "••••••••";

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

    writeSetting(key, String(body.value));

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
  });

export default settings;
