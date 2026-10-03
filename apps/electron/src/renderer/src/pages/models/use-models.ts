import type {
  CleanupSampling,
  LlmParameterPreset,
  LlmTaskAssignment,
  LlmTaskAssignments,
  LlmTaskId,
} from "@openstyle/validations";
import {
  clampMlxKeepAliveMinutes,
  MLX_KEEP_ALIVE_DEFAULT_MINUTES,
  parseCleanupSampling,
  parseLlmTaskAssignments,
} from "@openstyle/validations";
import { getClient } from "@renderer/lib/api";
import type { ApiKeyEntry, ConfiguredModel } from "@renderer/lib/models";
import {
  type AvailableModel,
  buildVoiceItems,
  hasActiveDownload,
  type MlxAsrStatus,
  type VoiceItem,
  type WhisperStatus,
} from "@renderer/lib/models";
import {
  availableModelsQueryOptions,
  mlxStatusQueryOptions,
  queryKeys,
  settingsQueryOptions,
  whisperStatusQueryOptions,
} from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SETTINGS_KEYS } from "../../../../shared/settings-keys";
import {
  checkPresetWrite,
  duplicatePreset,
  makePresetId,
  removePresetAndReassign,
  upsertPreset,
} from "./preset-ops";
import type {
  EndpointConnectConfig,
  EndpointConnectState,
} from "./use-endpoint-connect";
import { useEndpointConnect } from "./use-endpoint-connect";
import { groupByProvider } from "./utils";

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

/** Saves a model as the default for its type. */
function postDefaultModel(
  provider: string,
  modelId: string,
  modelName: string,
  type: "voice" | "llm",
) {
  return getClient().api.models.configured.$post({
    json: {
      provider,
      model_id: modelId,
      model_name: modelName,
      type,
      is_default: true,
    },
  });
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
  /** Create or overwrite one preset. Resolves `false` when the write was
   *  refused (a client-side §4.3 pre-check, or a failed PUT) — local state
   *  then reflects the pre-mutation array, never the refused one. */
  saveUserPreset: (preset: LlmParameterPreset) => Promise<boolean>;
  /** Copy a preset (built-in or the user's own) into a new `user_*` preset.
   *  Resolves the copy, or `null` when the write was refused. Does NOT change
   *  any task's assignment — see `duplicateUserPreset`'s comment for why. */
  duplicateUserPreset: (
    source: LlmParameterPreset,
    copyName: string,
  ) => Promise<LlmParameterPreset | null>;
  /** Delete one preset and re-point every task that used it at `auto`.
   *  Assignments are written FIRST, so a dangling `presetId` is structurally
   *  impossible (§11); a failed assignments PUT aborts the delete. Resolves
   *  `false` (state unchanged) on any failure. */
  deleteUserPreset: (presetId: string) => Promise<boolean>;
  deleteProvider: (provider: string) => Promise<void>;
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

  const whisperQuery = useQuery(whisperStatusQueryOptions());
  const mlxQuery = useQuery(mlxStatusQueryOptions());

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
    MLX_KEEP_ALIVE_DEFAULT_MINUTES,
  );
  const [cleanupSampling, setCleanupSampling] = useState<CleanupSampling>({});
  const [taskAssignments, setTaskAssignments] = useState<LlmTaskAssignments>(
    {},
  );
  const [userPresets, setUserPresets] = useState<LlmParameterPreset[]>([]);

  // Mirror refs of the two settings blobs the preset actions rewrite. The
  // write path below must read the CURRENT list and then await, so a closure
  // over render-time state would be a frame stale by the time the PUT
  // resolves — and `deleteUserPreset` derives both the new presets array and
  // the rollback array from what it reads.
  const presetsRef = useRef<LlmParameterPreset[]>(userPresets);
  const assignmentsRef = useRef<LlmTaskAssignments>(taskAssignments);
  useEffect(() => {
    presetsRef.current = userPresets;
  }, [userPresets]);
  useEffect(() => {
    assignmentsRef.current = taskAssignments;
  }, [taskAssignments]);

  // Keep the settings query honest after a write. The seed effect is one-shot,
  // so a later remount of this page seeds local state from whatever this cache
  // holds — leave a stale blob in it and a deleted preset reappears as live
  // UI while the server no longer has it. Invalidating AFTER the PUT resolves
  // means the refetch returns what the server actually stored; the one-shot
  // guard still protects in-flight edits from being re-seeded away.
  const refreshSettingsCache = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: MODELS_KEYS.settings });
  }, [queryClient]);

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
  const settingsSeededRef = useRef(false);
  const keepAliveSeededRef = useRef(false);
  useEffect(() => {
    const s = settingsQuery.data;
    if (!s || settingsSeededRef.current) return;
    settingsSeededRef.current = true;
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
        keepAliveSeededRef.current = true;
        setMlxKeepAliveMinutes(clampMlxKeepAliveMinutes(minutes));
      }
    }
  }, [settingsQuery.data]);

  useEffect(() => {
    const d = mlxQuery.data;
    if (!d || keepAliveSeededRef.current) return;
    keepAliveSeededRef.current = true;
    if (Number.isFinite(d.keepAliveMinutes)) {
      setMlxKeepAliveMinutes(clampMlxKeepAliveMinutes(d.keepAliveMinutes));
    }
  }, [mlxQuery.data]);

  // -------------------------------------------------------------------------
  // Reloaders (invalidate the relevant queries; polling is driven by
  // refetchInterval on the whisper/mlx queries above)
  // -------------------------------------------------------------------------

  const loadData = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: MODELS_KEYS.all }),
      queryClient.invalidateQueries({ queryKey: MODELS_KEYS.keys }),
      queryClient.invalidateQueries({ queryKey: MODELS_KEYS.settings }),
    ]);
  }, [queryClient]);

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
      buildVoiceItems(available, whisperStatus, mlxStatus, {
        selectedModelId: defaultVoice?.model_id,
        selectedProvider: defaultVoice?.provider,
        keyProviders,
      }),
    [available, whisperStatus, mlxStatus, defaultVoice, keyProviders],
  );

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const configureModel = useCallback(
    async (model: AvailableModel, type: "voice" | "llm") => {
      await postDefaultModel(
        model.provider_id,
        model.model_id,
        model.model_name,
        type,
      );
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
      await postDefaultModel(provider, `${provider}/${defId}`, name, "voice");
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
      await postDefaultModel(
        "local-llm",
        `local-llm/${modelName}`,
        modelName,
        "llm",
      );
      await loadData();
    },
    [loadData],
  );

  const selectOmlxModel = useCallback(
    async (modelName: string) => {
      await postDefaultModel("omlx", `omlx/${modelName}`, modelName, "voice");
      await loadData();
    },
    [loadData],
  );

  const setCleanup = useCallback((next: boolean) => {
    setLlmCleanup(next);
    putSetting(SETTINGS_KEYS.llmCleanup, String(next))
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
    putSetting(SETTINGS_KEYS.mlxAsrKeepAliveMinutes, String(next))
      .then(() => {
        if (next !== 0) return;
        return getClient().api["mlx-asr"].server.stop.$post();
      })
      .catch((err) => console.error("Failed to save MLX ASR keep-alive:", err));
  }, []);

  // Persist one task's sampling assignment. The whole `llm_task_assignments`
  // blob is stored under one setting key (§5.1), so every write rewrites the
  // full map — mirrors `cleanup_sampling`'s old one-blob-per-PUT shape.
  // Optimistic, with a revert if the PUT is refused.
  const putTaskAssignments = useCallback(
    (next: LlmTaskAssignments): Promise<boolean> => {
      const prev = assignmentsRef.current;
      setTaskAssignments(next);
      return putSetting(
        SETTINGS_KEYS.llmTaskAssignments,
        JSON.stringify(next),
      ).then((ok) => {
        if (!ok) setTaskAssignments(prev);
        else refreshSettingsCache();
        return ok;
      });
    },
    [refreshSettingsCache],
  );

  // Built from `assignmentsRef.current`, not render-time state: `writePreset`
  // chains a preset PUT and this assignment PUT across an `await`, so a
  // closure over `taskAssignments` could rewrite the blob from a snapshot
  // taken before a concurrent edit to a DIFFERENT task — same discipline as
  // `deleteUserPreset`'s use of the refs above.
  const saveTaskAssignment = useCallback(
    (taskId: LlmTaskId, assignment: LlmTaskAssignment) => {
      void putTaskAssignments({
        ...assignmentsRef.current,
        [taskId]: assignment,
      });
    },
    [putTaskAssignments],
  );

  // Reset clears the task's assignment entirely (back to `{ mode: "auto" }`)
  // rather than writing "safe" defaults — an absent/auto entry is the only
  // true escape from a bad combination, and is byte-for-byte today's
  // pre-feature behavior (§3.2).
  const resetTaskAssignment = useCallback(
    (taskId: LlmTaskId) => saveTaskAssignment(taskId, { mode: "auto" }),
    [saveTaskAssignment],
  );

  // -------------------------------------------------------------------------
  // Parameter preset persistence (§4, §9.3)
  //
  // `persistPresets` is the single low-level write: the PUT happens OUTSIDE
  // any React state updater (the shape it replaced fired the PUT from inside
  // `setUserPresets(prev => …)`, where StrictMode can run the updater twice,
  // and swallowed the failure with a `console.error` that left the UI
  // advertising a preset that was never stored), it awaits, and it resolves
  // `false` rather than rejecting. Every caller owns its own revert.
  //
  // There is deliberately no `DELETE` call: `DELETE /api/settings/:key`
  // drops the WHOLE key, so removing one preset is a PUT of the array minus
  // that entry through the same route (§4.3). No server change, no new
  // surface.
  // -------------------------------------------------------------------------

  const persistPresets = useCallback(
    async (next: LlmParameterPreset[]): Promise<boolean> => {
      // Client mirror of the route's §4.3 rules (id/name/count/params-bytes)
      // so a refused write shows an inline message instead of a bare 400.
      if (checkPresetWrite(next)) return false;
      const ok = await putSetting(
        SETTINGS_KEYS.llmParameterPresets,
        JSON.stringify({ presets: next }),
      );
      if (ok) refreshSettingsCache();
      return ok;
    },
    [refreshSettingsCache],
  );

  // Save (create or overwrite) one named user preset. Built-ins are never
  // written here (§4.2) — the id regex (`/^user_/`) is enforced server-side,
  // and `checkPresetWrite` refuses the same shape before we ever send it.
  // `updatedAt` is stamped HERE because the server persists the blob verbatim
  // and never writes that field: a write path that omits it silently lies.
  // An existing preset's `createdAt` survives an edit.
  const saveUserPreset = useCallback(
    async (preset: LlmParameterPreset): Promise<boolean> => {
      const prev = presetsRef.current;
      const now = new Date().toISOString();
      const existing = prev.find((p) => p.id === preset.id);
      const stamped: LlmParameterPreset = {
        ...preset,
        createdAt: existing?.createdAt ?? preset.createdAt ?? now,
        updatedAt: now,
      };
      const next = upsertPreset(prev, stamped);
      setUserPresets(next);
      const ok = await persistPresets(next);
      // Revert to the pre-mutation snapshot on failure. The ref makes `prev`
      // the list this call started from; preset editors in this panel are
      // serialised (one open at a time), so there is no concurrent write to
      // clobber.
      if (!ok) setUserPresets(prev);
      return ok;
    },
    [persistPresets],
  );

  // Copy a preset into a new `user_*` preset the user then owns. Deliberately
  // does NOT re-point any task assignment: a duplicate's params are identical
  // to its source's, so re-pointing would silently swap which row a task is
  // pinned to for no behavioural gain — and `NewPresetEditor`'s re-point
  // (§9.3) is a different case, there the new preset is the draft the user
  // just typed and leaving it unselected would make their edit invisible.
  // The user selects the copy in the Params track when they want it live.
  const duplicateUserPreset = useCallback(
    async (
      source: LlmParameterPreset,
      copyName: string,
    ): Promise<LlmParameterPreset | null> => {
      const prev = presetsRef.current;
      const { presets: next, copy } = duplicatePreset(
        prev,
        source,
        makePresetId(crypto.randomUUID()),
        { now: new Date().toISOString(), copyName },
      );
      setUserPresets(next);
      const ok = await persistPresets(next);
      if (!ok) {
        setUserPresets(prev);
        return null;
      }
      return copy;
    },
    [persistPresets],
  );

  // Delete one preset (§9.3, decision: confirm first, then the affected tasks
  // fall back to Auto). ORDERING IS THE POINT: `llm_task_assignments` is
  // written FIRST and only then the presets array, so at no instant does a
  // stored assignment name a preset that isn't stored — the dangling id the
  // server tolerates with a warn + auto fallback (§11, §8.3) never exists to
  // begin with. If the assignments PUT fails we abort and the preset stays.
  // If the presets PUT fails after the assignments one succeeded, the
  // assignments rollback restores the tasks; if THAT fails too the residue is
  // tasks-on-auto pointing at nothing — unused, not dangling.
  //
  // `setUserPresets` is load-bearing here, not a nicety: the Params track's
  // options ARE `userPresets` (`task-profiles-section.tsx` builds
  // `segmentedOptions` from `[...BUILTIN_LLM_PRESETS, ...userPresets]`), and
  // the settings seed effect is one-shot (`settingsSeededRef`, above), so
  // `refreshSettingsCache()`'s invalidation repopulates the react-query cache
  // but NEVER re-seeds this state. A delete that wrote both blobs and skipped
  // this call therefore kept the dead preset as a permanently deselectable
  // option for the life of the mount (the v2.7.0 evidence run, step 09).
  // Same optimistic-set-and-revert shape as `saveUserPreset` /
  // `duplicateUserPreset`, in the same ORDER as the writes: the task leaves
  // the preset first, the option disappears second, so the track is never
  // left with a value that resolves to nothing.
  const deleteUserPreset = useCallback(
    async (presetId: string): Promise<boolean> => {
      const prevPresets = presetsRef.current;
      const prevAssignments = assignmentsRef.current;
      const plan = removePresetAndReassign(
        prevPresets,
        prevAssignments,
        presetId,
      );
      if (plan.presets.length === prevPresets.length) return false;

      if (!(await putTaskAssignments(plan.assignments))) return false;

      setUserPresets(plan.presets);

      if (!(await persistPresets(plan.presets))) {
        // Roll back in the reverse order: the option goes back BEFORE the
        // tasks are re-pointed at it, so no render ever shows an assignment
        // whose option is missing (the dangling badge flicker).
        setUserPresets(prevPresets);
        await putTaskAssignments(prevAssignments);
        return false;
      }
      return true;
    },
    [persistPresets, putTaskAssignments],
  );

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
    duplicateUserPreset,
    deleteUserPreset,
    deleteProvider,
  };
}
