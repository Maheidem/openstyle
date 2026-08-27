import type {
  CleanupSampling,
  LlmParameterPreset,
  LlmTaskAssignment,
  LlmTaskAssignments,
  LlmTaskId,
} from "@openstyle/validations";
import {
  parseCleanupSampling,
  parseLlmTaskAssignments,
} from "@openstyle/validations";
import { getClient } from "@renderer/lib/api";
import type {
  AvailableModel,
  MlxAsrStatus,
  VoiceItem,
  WhisperStatus,
} from "@renderer/lib/models";
import { IS_MAC } from "@renderer/lib/platform";
import {
  availableModelsQueryOptions,
  queryKeys,
  settingsQueryOptions,
} from "@renderer/lib/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SETTINGS_KEYS } from "../../../../shared/settings-keys";
import { DEFAULT_MLX_KEEP_ALIVE_MINUTES } from "./constants";
import type { ApiKeyEntry, ConfiguredModel } from "./types";
import type {
  EndpointConnectConfig,
  EndpointConnectState,
} from "./use-endpoint-connect";
import { useEndpointConnect } from "./use-endpoint-connect";
import {
  buildSettingsVoiceItems,
  clampMlxKeepAliveMinutes,
  groupByProvider,
} from "./utils";

export type { EndpointConnectState } from "./use-endpoint-connect";

// Query keys for the models page, all sourced from the shared registry.
// `queryKeys.models.all` (`["models"]`) is a family so a single invalidate
// refreshes both available + configured.
const MODELS_KEYS = {
  all: queryKeys.models.all,
  available: queryKeys.models.available,
  configured: queryKeys.models.configured,
  keys: queryKeys.apiKeys,
  settings: queryKeys.settings,
  whisper: queryKeys.whisperStatus,
  mlx: queryKeys.mlxStatus,
};

// Stable empty fallbacks so derived useMemo deps don't change identity while a
// query is still loading.
const EMPTY_AVAILABLE: AvailableModel[] = [];
const EMPTY_CONFIGURED: ConfiguredModel[] = [];
const EMPTY_KEYS: ApiKeyEntry[] = [];

/** True while any local model is downloading or verifying. */
function hasActiveDownload(
  models: { status: string }[] | undefined | null,
): boolean {
  return !!models?.some(
    (m) => m.status === "downloading" || m.status === "verifying",
  );
}

export interface UseModels {
  loading: boolean;
  available: AvailableModel[];
  configured: ConfiguredModel[];
  apiKeys: ApiKeyEntry[];
  whisperStatus: WhisperStatus | null;
  mlxStatus: MlxAsrStatus | null;
  llmCleanup: boolean;
  /** True once the editable form state has been seeded from persisted settings. */
  settingsSeeded: boolean;
  mlxKeepAliveMinutes: number;
  /** The retired global sampling blob (`cleanup_sampling`) — read-only here,
   *  kept only so `TaskProfilesSection` can show the "migrated from your old
   *  Sampling parameters" note per the §12.7 read-time fallback (no writer
   *  remains: the dialog that used to write this is deleted, §10). */
  cleanupSampling: CleanupSampling;
  /** Per-task sampling assignments (specs/llm-task-profiles.md §5). */
  taskAssignments: LlmTaskAssignments;
  /** User-created parameter presets, stored (built-ins are merged in by the
   *  section component, never stored here — §4.2). */
  userPresets: LlmParameterPreset[];

  /** Local models with an in-flight delete, keyed `${engine ?? "whisper"}:${defId}`. */
  deletingKeys: Set<string>;
  /** Providers with an in-flight key/model delete. */
  deletingProviders: Set<string>;

  // Derived
  keyProviders: Set<string>;
  defaultVoice: ConfiguredModel | undefined;
  defaultLlm: ConfiguredModel | undefined;
  voiceItems: VoiceItem[];
  llmModelsByProvider: Map<
    string,
    { providerName: string; models: AvailableModel[] }
  >;

  localLlm: EndpointConnectState;
  openaiStt: EndpointConnectState;
  omlx: EndpointConnectState;

  // Actions — each refetches as needed
  configureModel: (
    model: AvailableModel,
    type: "voice" | "llm",
  ) => Promise<void>;
  saveKey: (provider: string, key: string) => Promise<string | null>;
  selectLocalVoice: (
    defId: string,
    name: string,
    engine?: "whisper" | "mlx",
  ) => Promise<void>;
  retryLocalMlx: (defId: string) => Promise<void>;
  downloadLocal: (defId: string, engine?: "whisper" | "mlx") => void;
  cancelLocal: (defId: string, engine?: "whisper" | "mlx") => void;
  deleteLocal: (defId: string, engine?: "whisper" | "mlx") => Promise<void>;
  selectLocalLlmModel: (modelName: string) => Promise<void>;
  selectOmlxModel: (modelName: string) => Promise<void>;
  setCleanup: (next: boolean) => void;
  saveMlxKeepAliveMinutes: (minutes: number) => void;
  saveTaskAssignment: (
    taskId: LlmTaskId,
    assignment: LlmTaskAssignment,
  ) => void;
  resetTaskAssignment: (taskId: LlmTaskId) => void;
  saveUserPreset: (preset: LlmParameterPreset) => void;
  deleteProvider: (provider: string) => Promise<void>;
  reload: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Endpoint connect configs — static, defined once at module level so the
// probe callback references are stable across renders.
// ---------------------------------------------------------------------------

const LOCAL_LLM_CONFIG: EndpointConnectConfig = {
  urlKey: SETTINGS_KEYS.localLlmUrl,
  apiKeyKey: SETTINGS_KEYS.localLlmApiKey,
  defaultUrl: "http://localhost:11434",
  clearUrlWhenEmpty: false,
  probe: (client, body) =>
    client.api.settings["local-llm"].test.$post({ json: body }),
};

const OPENAI_STT_CONFIG: EndpointConnectConfig = {
  urlKey: SETTINGS_KEYS.openaiSttBaseUrl,
  apiKeyKey: SETTINGS_KEYS.openaiSttApiKey,
  defaultUrl: "",
  clearUrlWhenEmpty: true,
  probe: (client, body) =>
    client.api.settings["openai-stt"].test.$post({ json: body }),
};

const OMLX_CONFIG: EndpointConnectConfig = {
  urlKey: SETTINGS_KEYS.omlxBaseUrl,
  apiKeyKey: SETTINGS_KEYS.omlxApiKey,
  defaultUrl: "http://127.0.0.1:8123",
  clearUrlWhenEmpty: true,
  probe: (client, body) => client.api.settings.omlx.test.$post({ json: body }),
};

export function useModels(): UseModels {
  const queryClient = useQueryClient();

  // -------------------------------------------------------------------------
  // Server data (React Query)
  // -------------------------------------------------------------------------

  const availableQuery = useQuery(availableModelsQueryOptions());

  const configuredQuery = useQuery({
    queryKey: MODELS_KEYS.configured,
    queryFn: async () => {
      const res = await getClient().api.models.configured.$get();
      if (!res.ok) throw new Error("Failed to load configured models");
      return (await res.json()) as ConfiguredModel[];
    },
  });

  const keysQuery = useQuery({
    queryKey: MODELS_KEYS.keys,
    queryFn: async () => {
      const res = await getClient().api.keys.$get();
      if (!res.ok) throw new Error("Failed to load API keys");
      return (await res.json()) as ApiKeyEntry[];
    },
  });

  const settingsQuery = useQuery(settingsQueryOptions());

  const whisperQuery = useQuery({
    queryKey: MODELS_KEYS.whisper,
    queryFn: async () => {
      const res = await getClient().api.whisper.status.$get();
      if (!res.ok) throw new Error("Failed to load whisper status");
      return (await res.json()) as WhisperStatus;
    },
    // Poll every 500ms while a download/verify is active, then stop.
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && (d.binaryDownloading || hasActiveDownload(d.models))
        ? 500
        : false;
    },
    // Status is volatile during downloads — always treat as stale.
    staleTime: 0,
  });

  const mlxQuery = useQuery({
    queryKey: MODELS_KEYS.mlx,
    enabled: IS_MAC,
    queryFn: async () => {
      const res = await getClient().api["mlx-asr"].status.$get();
      if (!res.ok) throw new Error("Failed to load MLX ASR status");
      return (await res.json()) as MlxAsrStatus;
    },
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && hasActiveDownload(d.models) ? 500 : false;
    },
    staleTime: 0,
  });

  const available = availableQuery.data ?? EMPTY_AVAILABLE;
  const configured = configuredQuery.data ?? EMPTY_CONFIGURED;
  const apiKeys = keysQuery.data ?? EMPTY_KEYS;
  const whisperStatus = whisperQuery.data ?? null;
  const mlxStatus = mlxQuery.data ?? null;
  const loading =
    availableQuery.isLoading ||
    configuredQuery.isLoading ||
    keysQuery.isLoading ||
    settingsQuery.isLoading;

  // -------------------------------------------------------------------------
  // Editable form state (seeded from persisted settings)
  // -------------------------------------------------------------------------

  const [llmCleanup, setLlmCleanup] = useState(false);
  const [mlxKeepAliveMinutes, setMlxKeepAliveMinutes] = useState(
    DEFAULT_MLX_KEEP_ALIVE_MINUTES,
  );
  const [cleanupSampling, setCleanupSampling] = useState<CleanupSampling>({});
  const [taskAssignments, setTaskAssignments] = useState<LlmTaskAssignments>(
    {},
  );
  const [userPresets, setUserPresets] = useState<LlmParameterPreset[]>([]);

  // In-flight deletes — drive spinners on the delete buttons since deletion has
  // no server-reported status the way downloads do.
  const [deletingKeys, setDeletingKeys] = useState<Set<string>>(new Set());
  const [deletingProviders, setDeletingProviders] = useState<Set<string>>(
    new Set(),
  );

  // Seed editable state from persisted settings once, when the settings query
  // first resolves. Mutations update this local state directly, so we don't
  // re-seed on later invalidations (which would clobber in-progress edits).
  // keepAlive falls back to the MLX status report when the setting is unset.
  // `settingsSeeded` is state (not a ref) so consumers can wait for the seed
  // before acting on `llmCleanup` — reading it too early sees the initial
  // `false` and can trigger spurious re-configuration.
  const [settingsSeeded, setSettingsSeeded] = useState(false);
  const seededRef = useRef({ keepAlive: false });
  useEffect(() => {
    const s = settingsQuery.data;
    if (!s || settingsSeeded) return;
    setSettingsSeeded(true);
    const cleanup = s[SETTINGS_KEYS.llmCleanup];
    if (cleanup) setLlmCleanup(cleanup === "true");
    setCleanupSampling(parseCleanupSampling(s[SETTINGS_KEYS.cleanupSampling]));
    setTaskAssignments(
      parseLlmTaskAssignments(s[SETTINGS_KEYS.llmTaskAssignments]),
    );
    try {
      const rawPresets = s[SETTINGS_KEYS.llmParameterPresets];
      const parsed = rawPresets ? JSON.parse(rawPresets) : null;
      setUserPresets(
        parsed && Array.isArray(parsed.presets) ? parsed.presets : [],
      );
    } catch {
      setUserPresets([]);
    }
    const rawMinutes = s[SETTINGS_KEYS.mlxAsrKeepAliveMinutes];
    if (rawMinutes) {
      const minutes = Number(rawMinutes);
      if (Number.isFinite(minutes)) {
        seededRef.current.keepAlive = true;
        setMlxKeepAliveMinutes(clampMlxKeepAliveMinutes(minutes));
      }
    }
  }, [settingsQuery.data, settingsSeeded]);

  useEffect(() => {
    const d = mlxQuery.data;
    if (!d || seededRef.current.keepAlive) return;
    seededRef.current.keepAlive = true;
    if (Number.isFinite(d.keepAliveMinutes)) {
      setMlxKeepAliveMinutes(clampMlxKeepAliveMinutes(d.keepAliveMinutes));
    }
  }, [mlxQuery.data]);

  // -------------------------------------------------------------------------
  // Reloaders (invalidate the relevant queries; polling is driven by
  // refetchInterval on the whisper/mlx queries above)
  // -------------------------------------------------------------------------

  const reload = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: MODELS_KEYS.all }),
      queryClient.invalidateQueries({ queryKey: MODELS_KEYS.keys }),
      queryClient.invalidateQueries({ queryKey: MODELS_KEYS.settings }),
    ]);
  }, [queryClient]);
  const loadData = reload;

  // -------------------------------------------------------------------------
  // Endpoint connections (local LLM + custom STT)
  // -------------------------------------------------------------------------

  const localLlm = useEndpointConnect(
    LOCAL_LLM_CONFIG,
    settingsQuery.data,
    loadData,
  );
  const openaiStt = useEndpointConnect(
    OPENAI_STT_CONFIG,
    settingsQuery.data,
    loadData,
  );
  const omlx = useEndpointConnect(OMLX_CONFIG, settingsQuery.data, loadData);

  const loadWhisperStatus = useCallback(
    () => queryClient.invalidateQueries({ queryKey: MODELS_KEYS.whisper }),
    [queryClient],
  );

  // MLX retry needs the fresh status synchronously, so this fetches directly
  // and primes the query cache rather than just invalidating.
  const loadMlxStatus = useCallback(
    async (refresh = false): Promise<MlxAsrStatus | null> => {
      try {
        const res = refresh
          ? await getClient().api["mlx-asr"].status.$get({
              query: { refresh: "1" },
            })
          : await getClient().api["mlx-asr"].status.$get();
        if (!res.ok) return null;
        const data = (await res.json()) as MlxAsrStatus;
        queryClient.setQueryData(MODELS_KEYS.mlx, data);
        return data;
      } catch (err) {
        console.error("Failed to load MLX ASR status:", err);
        return null;
      }
    },
    [queryClient],
  );

  // When an active download/verify transitions to done, refresh the model
  // lists (a freshly downloaded local model becomes selectable).
  const whisperActive =
    !!whisperStatus &&
    (whisperStatus.binaryDownloading ||
      hasActiveDownload(whisperStatus.models));
  const prevWhisperActive = useRef(false);
  useEffect(() => {
    if (prevWhisperActive.current && !whisperActive) {
      void queryClient.invalidateQueries({ queryKey: MODELS_KEYS.all });
    }
    prevWhisperActive.current = whisperActive;
  }, [whisperActive, queryClient]);

  const mlxActive = hasActiveDownload(mlxStatus?.models);
  const prevMlxActive = useRef(false);
  useEffect(() => {
    if (prevMlxActive.current && !mlxActive) {
      void queryClient.invalidateQueries({ queryKey: MODELS_KEYS.all });
    }
    prevMlxActive.current = mlxActive;
  }, [mlxActive, queryClient]);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const keyProviders = useMemo(
    () => new Set(apiKeys.map((k) => k.provider)),
    [apiKeys],
  );
  const defaultVoice = useMemo(
    () => configured.find((m) => m.type === "voice" && m.is_default === 1),
    [configured],
  );
  const defaultLlm = useMemo(
    () => configured.find((m) => m.type === "llm" && m.is_default === 1),
    [configured],
  );
  const llmModelsByProvider = useMemo(
    () => groupByProvider(available, "llm"),
    [available],
  );
  const voiceItems = useMemo(
    () =>
      buildSettingsVoiceItems(available, whisperStatus, mlxStatus, {
        defaultVoice,
        keyProviders,
      }),
    [available, whisperStatus, mlxStatus, defaultVoice, keyProviders],
  );

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const configureModel = useCallback(
    async (model: AvailableModel, type: "voice" | "llm") => {
      await getClient().api.models.configured.$post({
        json: {
          provider: model.provider_id,
          model_id: model.model_id,
          model_name: model.model_name,
          type,
          is_default: true,
        },
      });
      await loadData();
    },
    [loadData],
  );

  // Validate, then persist. Returns an error string, or null on success.
  const saveKey = useCallback(
    async (provider: string, key: string): Promise<string | null> => {
      try {
        const client = getClient();
        const valRes = await client.api.keys.validate.$post({
          json: { provider, key },
        });
        if (valRes.ok) {
          const body = await valRes.json();
          if ("valid" in body && body.valid === false) {
            return (
              ("error" in body && typeof body.error === "string"
                ? body.error
                : null) ?? "API key is not valid."
            );
          }
        }
        await client.api.keys.$post({ json: { provider, key } });
        await loadData();
        return null;
      } catch {
        return "Failed to validate key. Please try again.";
      }
    },
    [loadData],
  );

  const selectLocalVoice = useCallback(
    async (defId: string, name: string, engine?: "whisper" | "mlx") => {
      const provider = engine === "mlx" ? "local-mlx" : "local-whisper";
      await getClient().api.models.configured.$post({
        json: {
          provider,
          model_id: `${provider}/${defId}`,
          model_name: name,
          type: "voice",
          is_default: true,
        },
      });
      if (engine === "mlx") {
        getClient()
          .api["mlx-asr"].server.start.$post({ json: { modelId: defId } })
          .catch(() => {});
      } else {
        getClient()
          .api.whisper.server.start.$post({ json: { modelId: defId } })
          .catch(() => {});
      }
      await loadData();
    },
    [loadData],
  );

  const downloadLocal = useCallback(
    (defId: string, engine?: "whisper" | "mlx") => {
      if (engine === "mlx") {
        void getClient()
          .api["mlx-asr"].models[":model"].download.$post({
            param: { model: defId },
          })
          .then(() => loadMlxStatus());
      } else {
        void getClient()
          .api.whisper.models[":model"].download.$post({
            param: { model: defId },
          })
          .then(() => loadWhisperStatus());
      }
    },
    [loadMlxStatus, loadWhisperStatus],
  );

  const cancelLocal = useCallback(
    (defId: string, engine?: "whisper" | "mlx") => {
      if (engine === "mlx") {
        void getClient()
          .api["mlx-asr"].models[":model"].cancel.$post({
            param: { model: defId },
          })
          .then(() => loadMlxStatus());
      } else {
        void getClient()
          .api.whisper.models[":model"].cancel.$post({
            param: { model: defId },
          })
          .then(() => loadWhisperStatus());
      }
    },
    [loadMlxStatus, loadWhisperStatus],
  );

  const deleteLocal = useCallback(
    async (defId: string, engine?: "whisper" | "mlx") => {
      const deletingKey = `${engine ?? "whisper"}:${defId}`;
      setDeletingKeys((prev) => new Set(prev).add(deletingKey));
      try {
        if (engine === "mlx") {
          await getClient().api["mlx-asr"].models[":model"].$delete({
            param: { model: defId },
          });
          await loadMlxStatus();
        } else {
          await getClient().api.whisper.models[":model"].$delete({
            param: { model: defId },
          });
          await loadWhisperStatus();
        }
        await loadData();
      } finally {
        setDeletingKeys((prev) => {
          const next = new Set(prev);
          next.delete(deletingKey);
          return next;
        });
      }
    },
    [loadMlxStatus, loadWhisperStatus, loadData],
  );

  const retryLocalMlx = useCallback(
    async (defId: string) => {
      const data = await loadMlxStatus(true);
      if (!data?.canRun) return;
      const status = data.models?.find((m) => m.model === defId);
      if (status?.status !== "ready") {
        downloadLocal(defId, "mlx");
        return;
      }
      const name =
        data.modelDefinitions.find((m) => m.id === defId)?.displayName ?? defId;
      await selectLocalVoice(defId, name, "mlx");
    },
    [loadMlxStatus, downloadLocal, selectLocalVoice],
  );

  const selectLocalLlmModel = useCallback(
    async (modelName: string) => {
      await getClient().api.models.configured.$post({
        json: {
          provider: "local-llm",
          model_id: `local-llm/${modelName}`,
          model_name: modelName,
          type: "llm",
          is_default: true,
        },
      });
      await loadData();
    },
    [loadData],
  );

  const selectOmlxModel = useCallback(
    async (modelName: string) => {
      await getClient().api.models.configured.$post({
        json: {
          provider: "omlx",
          model_id: `omlx/${modelName}`,
          model_name: modelName,
          type: "voice",
          is_default: true,
        },
      });
      await loadData();
    },
    [loadData],
  );

  const setCleanup = useCallback((next: boolean) => {
    setLlmCleanup(next);
    getClient()
      .api.settings[":key"].$put({
        param: { key: SETTINGS_KEYS.llmCleanup },
        json: { value: String(next) },
      })
      .then(() => {
        // Toggling cleanup changes whether the pill needs the frontmost app for
        // routing — notify it to refresh its cached decision.
        window.api?.sendCleanupContextChanged();
      })
      .catch((err) => console.error("Failed to save LLM cleanup:", err));
  }, []);

  // Persist the MLX keep-alive window. At 0 ("cold start") also stop the
  // running server so the model unloads immediately.
  const saveMlxKeepAliveMinutes = useCallback((minutes: number) => {
    const next = clampMlxKeepAliveMinutes(minutes);
    setMlxKeepAliveMinutes(next);
    getClient()
      .api.settings[":key"].$put({
        param: { key: SETTINGS_KEYS.mlxAsrKeepAliveMinutes },
        json: { value: String(next) },
      })
      .then(() => {
        if (next !== 0) return;
        return getClient().api["mlx-asr"].server.stop.$post();
      })
      .catch((err) => console.error("Failed to save MLX ASR keep-alive:", err));
  }, []);

  // Persist one task's sampling assignment. The whole `llm_task_assignments`
  // blob is stored under one setting key (§5.1), so every write rewrites the
  // full map — mirrors `cleanup_sampling`'s old one-blob-per-PUT shape.
  const putTaskAssignments = useCallback((next: LlmTaskAssignments) => {
    setTaskAssignments(next);
    getClient()
      .api.settings[":key"].$put({
        param: { key: SETTINGS_KEYS.llmTaskAssignments },
        json: { value: JSON.stringify(next) },
      })
      .catch((err) => console.error("Failed to save task assignments:", err));
  }, []);

  const saveTaskAssignment = useCallback(
    (taskId: LlmTaskId, assignment: LlmTaskAssignment) => {
      putTaskAssignments({ ...taskAssignments, [taskId]: assignment });
    },
    [putTaskAssignments, taskAssignments],
  );

  // Reset clears the task's assignment entirely (back to `{ mode: "auto" }`)
  // rather than writing "safe" defaults — an absent/auto entry is the only
  // true escape from a bad combination, and is byte-for-byte today's
  // pre-feature behavior (§3.2).
  const resetTaskAssignment = useCallback(
    (taskId: LlmTaskId) => saveTaskAssignment(taskId, { mode: "auto" }),
    [saveTaskAssignment],
  );

  // Save (create or overwrite) one named user preset. Built-ins are never
  // written here (§4.2) — the id regex (`/^user_/`) is enforced server-side.
  const saveUserPreset = useCallback((preset: LlmParameterPreset) => {
    setUserPresets((prev) => {
      const next = [...prev.filter((p) => p.id !== preset.id), preset];
      getClient()
        .api.settings[":key"].$put({
          param: { key: SETTINGS_KEYS.llmParameterPresets },
          json: { value: JSON.stringify({ presets: next }) },
        })
        .catch((err) => console.error("Failed to save parameter preset:", err));
      return next;
    });
  }, []);

  const deleteProvider = useCallback(
    async (provider: string) => {
      setDeletingProviders((prev) => new Set(prev).add(provider));
      try {
        const client = getClient();
        await client.api.keys[":provider"].$delete({ param: { provider } });
        const providerModels = configured.filter(
          (m) => m.provider === provider,
        );
        await Promise.all(
          providerModels.map((m) =>
            client.api.models.configured[":id"].$delete({
              param: { id: String(m.id) },
            }),
          ),
        );
        await loadData();
      } finally {
        setDeletingProviders((prev) => {
          const next = new Set(prev);
          next.delete(provider);
          return next;
        });
      }
    },
    [configured, loadData],
  );

  return {
    loading,
    available,
    configured,
    apiKeys,
    whisperStatus,
    mlxStatus,
    llmCleanup,
    settingsSeeded,
    mlxKeepAliveMinutes,
    deletingKeys,
    deletingProviders,
    keyProviders,
    defaultVoice,
    defaultLlm,
    voiceItems,
    llmModelsByProvider,
    localLlm,
    openaiStt,
    omlx,
    configureModel,
    saveKey,
    selectLocalVoice,
    retryLocalMlx,
    downloadLocal,
    cancelLocal,
    deleteLocal,
    selectLocalLlmModel,
    selectOmlxModel,
    setCleanup,
    saveMlxKeepAliveMinutes,
    cleanupSampling,
    taskAssignments,
    userPresets,
    saveTaskAssignment,
    resetTaskAssignment,
    saveUserPreset,
    deleteProvider,
    reload: loadData,
  };
}
