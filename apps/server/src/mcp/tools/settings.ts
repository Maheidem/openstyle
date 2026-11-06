// MCP tools for the settings and the models. Each tool calls a route of
// routes/settings.ts, routes/system.ts, routes/models.ts or routes/mlx-llm.ts.
// The settings tools see only the keys of the catalog (../settings-catalog.ts).
// The app-shell settings live in the Electron main process (specs/mcp.md 6.4).
import { SETTINGS_KEYS } from "@openstyle/validations";
import { z } from "zod";
import { getMlxLlmModel } from "../../lib/mlx-llm/constants.js";
import { checkSettingValue, SETTINGS_CATALOG } from "../settings-catalog.js";
import { defineTool, expectOk, seg, ToolError } from "./define.js";

const modelId = z
  .string()
  .min(1)
  .describe(
    "The id of a built-in local model (from list_models, builtin.models[].model).",
  );

interface MlxLlmStatus {
  platformSupported: boolean;
  blockedReason: string | null;
  models: { model: string }[];
}

const listSettings = defineTool({
  name: "list_settings",
  description:
    "List the app settings that you can change, with the type, the allowed values, a description and the current value. value null means the default.",
  kind: "read",
  idempotent: true,
  input: z.object({}),
  run: async (_args, { api }) => {
    const stored = expectOk(await api("GET", "/api/settings")) as Record<
      string,
      string
    >;
    return {
      data: Object.entries(SETTINGS_CATALOG).map(([key, entry]) => ({
        key,
        type: entry.type,
        ...(entry.values ? { values: entry.values } : {}),
        description: entry.description,
        value: stored[key] ?? null,
      })),
    };
  },
});

const setSetting = defineTool({
  name: "set_setting",
  description:
    'Change one app setting. The key must come from list_settings. Give the value as text: "true"/"false" for a boolean, digits for an integer, JSON text for a json setting.',
  kind: "write",
  idempotent: true,
  input: z.object({
    key: z.string().min(1).describe("The setting key (from list_settings)."),
    value: z.string().describe("The new value, as text."),
  }),
  run: async ({ key, value }, { api }) => {
    const entry = Object.hasOwn(SETTINGS_CATALOG, key)
      ? SETTINGS_CATALOG[key]
      : undefined;
    if (!entry) {
      throw new ToolError(
        `Unknown or protected setting: ${key}. Call list_settings for the keys you can change.`,
      );
    }
    const problem = checkSettingValue(entry, value);
    if (problem) throw new ToolError(`Invalid value for ${key}: ${problem}`);
    const data = expectOk(
      await api("PUT", `/api/settings/${seg(key)}`, { value }),
    );
    return { data, change: { kind: "setting", keys: [key] } };
  },
});

const getAppSettings = defineTool({
  name: "get_app_settings",
  description:
    "Get the app-shell settings of the Openstyle app: pill_position, auto_update, update_channel and launch_at_login. They need the running app.",
  kind: "read",
  idempotent: true,
  input: z.object({}),
  run: async (_args, { api }) => ({
    data: expectOk(await api("GET", "/api/system/app-settings")),
  }),
});

const setAppSettings = defineTool({
  name: "set_app_settings",
  description:
    "Change app-shell settings of the Openstyle app. Give at least one field. A switch of update_channel to stable on a Dev (alpha) build installs the Stable version at once. The answer holds all four values after the change.",
  kind: "write",
  idempotent: true,
  input: z.object({
    pill_position: z
      .enum(["top-center", "top-right", "bottom-center", "bottom-right"])
      .optional()
      .describe("Where the dictation pill shows on the screen."),
    auto_update: z
      .boolean()
      .optional()
      .describe("true: the app looks for updates by itself."),
    update_channel: z
      .enum(["stable", "dev"])
      .optional()
      .describe("The update channel."),
    launch_at_login: z
      .boolean()
      .optional()
      .describe("true: the app starts when the user logs in."),
  }),
  run: async (patch, { api }) => {
    const keys = Object.keys(patch).filter(
      (k) => patch[k as keyof typeof patch] !== undefined,
    );
    if (keys.length === 0) {
      throw new ToolError(
        "Give at least one of pill_position, auto_update, update_channel, launch_at_login.",
      );
    }
    const data = expectOk(await api("PUT", "/api/system/app-settings", patch));
    return { data, change: { kind: "app-setting", keys } };
  },
});

const listModels = defineTool({
  name: "list_models",
  description:
    "List the models: configured (the speech and LLM models set up in the app), builtin (the local MLX LLMs with download state) and task_assignments (which model each LLM task uses).",
  kind: "read",
  idempotent: true,
  input: z.object({}),
  run: async (_args, { api }) => {
    const configured = expectOk(await api("GET", "/api/models/configured"));
    const builtin = expectOk(await api("GET", "/api/mlx-llm/status"));
    const assignments = await api(
      "GET",
      `/api/settings/${SETTINGS_KEYS.llmTaskAssignments}`,
    );
    const value = assignments.ok
      ? (assignments.data as { value: string }).value
      : null;
    let taskAssignments: unknown = null;
    try {
      taskAssignments = value ? JSON.parse(value) : null;
    } catch {
      taskAssignments = value;
    }
    return {
      data: { configured, builtin, task_assignments: taskAssignments },
    };
  },
});

const downloadModel = defineTool({
  name: "download_model",
  description:
    "Start the download of a built-in local LLM. It runs in the background. Follow it with get_download_status.",
  kind: "write",
  idempotent: true,
  input: z.object({ model_id: modelId }),
  run: async ({ model_id }, { api }) => {
    const data = expectOk(
      await api("POST", `/api/mlx-llm/models/${seg(model_id)}/download`),
    );
    return { data, change: { kind: "model", ids: [model_id] } };
  },
});

const getDownloadStatus = defineTool({
  name: "get_download_status",
  description:
    "Get the download state of a built-in local LLM: status, progress and error.",
  kind: "read",
  idempotent: true,
  input: z.object({ model_id: modelId }),
  run: async ({ model_id }, { api }) => {
    if (!getMlxLlmModel(model_id)) {
      throw new ToolError(
        `Unknown built-in model: ${model_id}. Call list_models for the ids.`,
      );
    }
    const status = expectOk(
      await api("GET", "/api/mlx-llm/status"),
    ) as MlxLlmStatus;
    if (!status.platformSupported) {
      throw new ToolError(
        status.blockedReason ?? "This computer cannot run built-in models",
      );
    }
    const model = status.models.find((m) => m.model === model_id);
    if (!model) throw new ToolError(`Unknown built-in model: ${model_id}`);
    return { data: model };
  },
});

export const settingsTools = [
  listSettings,
  setSetting,
  getAppSettings,
  setAppSettings,
  listModels,
  downloadModel,
  getDownloadStatus,
];
