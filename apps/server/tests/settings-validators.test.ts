import { beforeEach, describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({
  mlx: vi.fn(),
  whisper: vi.fn(),
  purge: vi.fn(),
  network: vi.fn(),
}));

vi.mock("../src/lib/mlx-asr/server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mlx-asr/server.js")>()),
  applyMlxAsrRetentionPolicy: effects.mlx,
}));
vi.mock("../src/lib/whisper/server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/whisper/server.js")>()),
  applyWhisperRetentionPolicy: effects.whisper,
}));
vi.mock("../src/lib/history-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/history-store.js")>()),
  purgeExpiredHistory: effects.purge,
}));
vi.mock("../src/lib/network.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/network.js")>()),
  configureNetwork: effects.network,
}));

import createApp from "../src/index.js";
import { getDb } from "../src/lib/db.js";

const app = createApp();

function put(key: string, value: string) {
  return app.request(`/api/settings/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

function stored(key: string): string | undefined {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

const preset = (name: string, params: Record<string, unknown>) => ({
  id: "user_1",
  name,
  params,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const URL_PROXY =
  "Proxy must be a valid http://, https:// or socks:// URL (or empty to disable)";
const RETENTION =
  "Retention must be a whole number of days between 1 and 3650 (or empty to disable)";
const TIMEOUT =
  "Timeout must be a whole number of seconds between 30 and 3600 (or empty for 600)";
const MEETING_STT_MODEL =
  "Meeting transcription model must be a JSON object with provider and model_id (or empty to use the dictation model)";

// Each row records what the old if/else chain answered: key, value, status
// and the exact error text (null for a 200).
const rows: [string, string, number, string | null][] = [
  ["cleanup_intensity", "low", 200, null],
  ["cleanup_intensity", "bogus", 400, "Invalid cleanup intensity"],
  ["cleanup_custom_prompt", "hello", 200, null],
  [
    "cleanup_custom_prompt",
    "x".repeat(20001),
    400,
    "Custom prompt is too long",
  ],
  ["meeting_summary_instructions", "hello", 200, null],
  [
    "meeting_summary_instructions",
    "x".repeat(4001),
    400,
    "Summary instructions are too long",
  ],
  ["cleanup_personal_tone", "casual", 200, null],
  ["cleanup_personal_tone", "bogus", 400, "Invalid personal tone"],
  ["cleanup_work_tone", "direct", 200, null],
  ["cleanup_work_tone", "bogus", 400, "Invalid work tone"],
  ["cleanup_email_tone", "warm", 200, null],
  ["cleanup_email_tone", "bogus", 400, "Invalid email tone"],
  ["cleanup_overall_tone", "neutral", 200, null],
  ["cleanup_overall_tone", "bogus", 400, "Invalid overall tone"],
  ["cleanup_app_assignments", "[]", 200, null],
  [
    "cleanup_app_assignments",
    "not json",
    400,
    "Invalid app assignments setting",
  ],
  [
    "cleanup_app_assignments",
    '{"a":1}',
    400,
    "Invalid app assignments setting",
  ],
  [
    "llm_parameter_presets",
    JSON.stringify({ presets: [preset("A", { t: 1 })] }),
    200,
    null,
  ],
  [
    "llm_parameter_presets",
    "not json",
    400,
    "Invalid parameter presets setting",
  ],
  [
    "llm_parameter_presets",
    '{"presets":"x"}',
    400,
    "Invalid parameter presets setting",
  ],
  [
    "llm_parameter_presets",
    JSON.stringify({ presets: [preset("Big", { blob: "x".repeat(9000) })] }),
    400,
    'Preset "Big" is too large',
  ],
  ["llm_task_assignments", '{"cleanup":{"mode":"auto"},"other":5}', 200, null],
  ["llm_task_assignments", "not json", 400, "Invalid task assignments setting"],
  ["llm_task_assignments", "[]", 400, "Invalid task assignments setting"],
  ["llm_task_assignments", "null", 400, "Invalid task assignments setting"],
  ["llm_task_assignments", '"str"', 400, "Invalid task assignments setting"],
  [
    "llm_task_assignments",
    '{"remix":{"mode":"nope"}}',
    400,
    'Invalid assignment for task "remix"',
  ],
  ["network_proxy_url", "http://proxy:3128", 200, null],
  ["network_proxy_url", "nonsense", 400, URL_PROXY],
  ["network_ca_cert_path", "/etc/ca.pem", 200, null],
  [
    "network_ca_cert_path",
    "x".repeat(4097),
    400,
    "Invalid CA certificate path",
  ],
  ["history_retention_days", "30", 200, null],
  ["history_retention_days", "", 200, null],
  ["history_retention_days", "0", 400, RETENTION],
  ["meeting_summary_timeout_seconds", "60", 200, null],
  ["meeting_summary_timeout_seconds", "5", 400, TIMEOUT],
  ["meeting_enhance_timeout_seconds", "60", 200, null],
  ["meeting_enhance_timeout_seconds", "99999", 400, TIMEOUT],
  // I3 (specs/meeting-transcription-v2.md §3.3): JSON model pair; empty
  // string is valid and means "use the dictation model".
  ["meeting_stt_model", "", 200, null],
  [
    "meeting_stt_model",
    JSON.stringify({
      provider: "server",
      model_id: "server/s1/qwen3-asr",
      model_name: "Qwen3-ASR",
    }),
    200,
    null,
  ],
  ["meeting_stt_model", "not json", 400, MEETING_STT_MODEL],
  [
    "meeting_stt_model",
    JSON.stringify({ provider: "server", model_id: "" }),
    400,
    MEETING_STT_MODEL,
  ],
  [
    "meeting_stt_model",
    JSON.stringify(["server", "qwen3-asr"]),
    400,
    MEETING_STT_MODEL,
  ],
  // Keys without a validator stay open, including names that exist on Object.prototype.
  ["hotkey", "anything at all", 200, null],
  ["constructor", "anything", 200, null],
  ["__proto__", "anything", 200, null],
  ["toString", "anything", 200, null],
];

describe("PUT /api/settings/:key validation", () => {
  beforeEach(() => {
    for (const fn of Object.values(effects)) fn.mockClear();
  });

  it.each(rows)("%s = %j -> %i", async (key, value, status, error) => {
    const before = stored(key);
    const res = await put(key, value);
    expect(res.status).toBe(status);
    const body = (await res.json()) as {
      error?: string;
      key?: string;
      value?: string;
    };
    if (error === null) {
      expect(body).toEqual({ key, value });
      expect(stored(key)).toBe(value);
    } else {
      expect(body).toEqual({ error });
      expect(stored(key)).toBe(before);
    }
  });

  it("keeps the redaction guard ahead of validation", async () => {
    const res = await put("custom_api_key", "••••••••");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      key: "custom_api_key",
      value: "••••••••",
    });
  });

  it("runs side effects only after a successful write", async () => {
    await put("mlx_asr_keep_alive_minutes", "5");
    expect(effects.mlx).toHaveBeenCalledTimes(1);
    await put("whisper_keep_alive_minutes", "5");
    expect(effects.whisper).toHaveBeenCalledTimes(1);
    await put("history_retention_days", "30");
    expect(effects.purge).toHaveBeenCalledTimes(1);
    await put("network_proxy_url", "http://proxy:3128");
    await put("network_ca_cert_path", "/etc/ca.pem");
    expect(effects.network).toHaveBeenCalledTimes(2);

    await put("history_retention_days", "0");
    await put("network_proxy_url", "nonsense");
    expect(effects.purge).toHaveBeenCalledTimes(1);
    expect(effects.network).toHaveBeenCalledTimes(2);
  });

  it("DELETE runs only the network effect", async () => {
    for (const key of [
      "mlx_asr_keep_alive_minutes",
      "whisper_keep_alive_minutes",
      "history_retention_days",
    ]) {
      await app.request(`/api/settings/${key}`, { method: "DELETE" });
    }
    expect(effects.mlx).not.toHaveBeenCalled();
    expect(effects.whisper).not.toHaveBeenCalled();
    expect(effects.purge).not.toHaveBeenCalled();
    expect(effects.network).not.toHaveBeenCalled();
    await app.request("/api/settings/network_proxy_url", { method: "DELETE" });
    await app.request("/api/settings/network_ca_cert_path", {
      method: "DELETE",
    });
    expect(effects.network).toHaveBeenCalledTimes(2);
  });
});
