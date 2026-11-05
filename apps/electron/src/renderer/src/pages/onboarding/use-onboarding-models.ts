import { SERVER_PROVIDER_ID } from "@openstyle/validations";
import { getClient } from "@renderer/lib/api";
import {
  buildLocalLlmItems,
  buildVoiceItems,
  type ConfiguredModel,
  type LocalLlmItem,
  MLX_LLM_PROVIDER_ID,
  type VoiceItem,
} from "@renderer/lib/models";
import {
  type DownloadPlan,
  type DownloadSummary,
  languageOutsideQwen,
  lowDisk,
  ONBOARDING_VOICE_MODELS,
  planDownload,
  recommendText,
  recommendVoice,
  type SystemProfile,
  summarizeDownloads,
  textLine,
  type VoicePick,
  voiceLine,
} from "@renderer/lib/onboarding";
import {
  availableModelsQueryOptions,
  configuredModelsQueryOptions,
  mlxLlmStatusQueryOptions,
  mlxStatusQueryOptions,
  queryKeys,
  systemProfileQueryOptions,
  whisperStatusQueryOptions,
} from "@renderer/lib/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OnboardingDraft } from "../../../../shared/onboarding";
import { type UseServers, useServers } from "../models/use-servers";
import {
  cloudModelFor,
  type RemoteSource,
  useRemoteSource,
} from "./use-remote-source";

/** Cloud providers that the first run lists, per role, in this order. */
export const VOICE_CLOUD_PROVIDERS = [
  "groq",
  "openai",
  "deepgram",
  "elevenlabs",
  "soniox",
];
export const TEXT_CLOUD_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "mistral",
];

export type Source = "mac" | "server" | "cloud";

/** The model that a download step makes the default. */
interface SavedModel {
  provider: string;
  modelId: string;
  modelName: string;
}

export interface OnboardingModels {
  loading: boolean;
  profile: SystemProfile | undefined;
  servers: UseServers;
  /** The voice models of "Choose another", in list order. */
  voiceItems: VoiceItem[];
  /** The text models of the catalog (empty when this Mac cannot run MLX). */
  llmItems: LocalLlmItem[];
  qwenLanguages: string[] | null;
  recommendedVoice: VoiceItem | undefined;
  recommendedText: LocalLlmItem | null;

  voiceSource: Source | "later";
  setVoiceSource: (source: Source | "later") => void;
  voicePick: VoicePick | null;
  pickVoice: (pick: VoicePick) => void;
  textSource: Source;
  setTextSource: (source: Source) => void;
  /** A catalog id, "none" for "Not now", or null for the recommendation. */
  textPick: string | "none" | null;
  pickText: (pick: string | "none") => void;
  voiceRemote: RemoteSource;
  textRemote: RemoteSource;
  voiceProviders: string[];
  textProviders: string[];
  /** Back to the recommendation of the main view. */
  useRecommendation: () => void;

  /** The local voice and text model that the user chose now. */
  chosenVoice: VoiceItem | null;
  chosenText: LocalLlmItem | null;
  plan: DownloadPlan;
  diskWarning: { need: number; have: number } | null;
  qwenWarning: boolean;
  /** True while the form misses what the button needs. */
  blocked: boolean;

  /** Save the choice and start the downloads. Returns an error text, or null. */
  commit: () => Promise<string | null>;
  committing: boolean;

  /** Footer: the downloads of the saved default models. */
  downloads: DownloadSummary;
  /** Save the recommended text model as the default and start its download (the Enhance step). */
  startRecommendedText: () => Promise<void>;
  /** Start the stopped downloads of the saved default models again. */
  retryDownloads: () => Promise<void>;
  /** Remove the saved default voice model (the user chose "Decide later"). */
  clearVoiceDefault: () => Promise<void>;
  defaultVoice: ConfiguredModel | undefined;
  defaultLlm: ConfiguredModel | undefined;
  /** The local voice model that is the default, when the default is local. */
  defaultVoiceItem: VoiceItem | undefined;
  defaultTextItem: LocalLlmItem | undefined;
  toDraft: () => OnboardingDraft;
}

function parsePick(value: string | undefined): VoicePick | null {
  if (!value) return null;
  const [engine, defId] = value.split(":");
  return (engine === "mlx" || engine === "whisper") && defId
    ? { engine, defId }
    : null;
}

export function useOnboardingModels(
  languages: string[],
  initial: OnboardingDraft,
  downloadStarted: boolean,
): OnboardingModels {
  const queryClient = useQueryClient();
  const servers = useServers();
  const whisperQuery = useQuery(whisperStatusQueryOptions());
  const mlxQuery = useQuery(mlxStatusQueryOptions());
  const llmQuery = useQuery(mlxLlmStatusQueryOptions());
  const profileQuery = useQuery(systemProfileQueryOptions());
  const availableQuery = useQuery(availableModelsQueryOptions());
  const configuredQuery = useQuery(configuredModelsQueryOptions());

  const [voiceSource, setVoiceSourceState] = useState<Source | "later">(
    initial.voiceSource ?? "mac",
  );
  const [voicePick, setVoicePick] = useState<VoicePick | null>(
    initial.voiceSource === "mac" || !initial.voiceSource
      ? parsePick(initial.voiceModel)
      : null,
  );
  const [textSource, setTextSourceState] = useState<Source>(
    initial.textSource === "server" || initial.textSource === "cloud"
      ? initial.textSource
      : "mac",
  );
  const [textPick, setTextPick] = useState<string | null>(
    initial.textSource === "none"
      ? "none"
      : initial.textSource === "mac" || !initial.textSource
        ? (initial.textModel ?? null)
        : null,
  );
  const [committing, setCommitting] = useState(false);

  const available = availableQuery.data ?? [];
  const voiceProviders = VOICE_CLOUD_PROVIDERS.filter((p) =>
    cloudModelFor(available, "voice", p),
  );
  const textProviders = TEXT_CLOUD_PROVIDERS.filter((p) =>
    cloudModelFor(available, "llm", p),
  );
  const voiceRemote = useRemoteSource(
    "voice",
    servers,
    { serverUrl: initial.voiceServerUrl, provider: initial.voiceProvider },
    VOICE_CLOUD_PROVIDERS[0],
  );
  const textRemote = useRemoteSource(
    "llm",
    servers,
    { serverUrl: initial.textServerUrl, provider: initial.textProvider },
    TEXT_CLOUD_PROVIDERS[0],
  );

  const profile = profileQuery.data;
  const whisperStatus = whisperQuery.data ?? null;
  const mlxStatus = mlxQuery.data ?? null;
  const configured = configuredQuery.data ?? [];
  const defaultVoice = configured.find(
    (m) => m.type === "voice" && m.is_default === 1,
  );
  const defaultLlm = configured.find(
    (m) => m.type === "llm" && m.is_default === 1,
  );

  const allVoiceItems = useMemo(
    () =>
      buildVoiceItems([], whisperStatus, mlxStatus, {
        selectedModelId: defaultVoice?.model_id,
        selectedProvider: defaultVoice?.provider,
        keyProviders: new Set(),
      }),
    [whisperStatus, mlxStatus, defaultVoice],
  );
  const voiceItems = useMemo(
    () =>
      ONBOARDING_VOICE_MODELS.map((m) =>
        allVoiceItems.find(
          (v) => v.localEngine === m.engine && v.defId === m.defId,
        ),
      ).filter((v): v is VoiceItem => !!v),
    [allVoiceItems],
  );
  const llmItems = useMemo(
    () => buildLocalLlmItems(llmQuery.data ?? null, defaultLlm),
    [llmQuery.data, defaultLlm],
  );

  const qwenDef = mlxStatus?.modelDefinitions.find(
    (d) => d.id === "qwen3-0.6b-8bit",
  ) as { languages?: string[] } | undefined;
  const qwenLanguages = qwenDef?.languages ?? null;
  // MLX is usable on this Mac when it runs now or the worker can be installed.
  const mlxUsable =
    !!profile?.appleSilicon &&
    !!mlxStatus &&
    (mlxStatus.canRun || !!mlxStatus.runtime?.url);

  const recVoicePick = recommendVoice({
    languages,
    appleSilicon: mlxUsable,
    ramBytes: profile?.ramBytes ?? null,
    qwenLanguages,
  });
  const recommendedVoice = voiceItems.find(
    (v) =>
      v.localEngine === recVoicePick.engine && v.defId === recVoicePick.defId,
  );
  const recommendedText = recommendText(llmItems);

  const chosenVoice =
    voiceSource === "mac"
      ? (voiceItems.find(
          (v) =>
            v.localEngine === (voicePick ?? recVoicePick).engine &&
            v.defId === (voicePick ?? recVoicePick).defId,
        ) ?? null)
      : null;
  const chosenText =
    textSource === "mac" && textPick !== "none"
      ? (llmItems.find(
          (i) => i.defId === (textPick ?? recommendedText?.defId),
        ) ?? null)
      : null;

  const plan = planDownload({
    voice: chosenVoice
      ? {
          engine: chosenVoice.localEngine === "mlx" ? "mlx" : "whisper",
          sizeBytes: chosenVoice.sizeBytes ?? 0,
          ready: chosenVoice.status === "ready",
        }
      : null,
    text: chosenText
      ? {
          sizeBytes: chosenText.sizeBytes,
          ready: chosenText.status === "ready",
        }
      : null,
    mlxWorkerBytes: profile?.mlxWorkerBytes ?? 0,
  });
  const diskWarning = lowDisk(plan, profile?.freeDiskBytes ?? null);
  const qwenWarning = languageOutsideQwen({
    pick: voiceSource === "mac" ? (voicePick ?? recVoicePick) : null,
    languages,
    qwenLanguages,
  });

  const needsKey = (r: RemoteSource): boolean =>
    r.cloudKey.trim() === "" ||
    r.keyTest.state === "testing" ||
    r.keyTest.state === "refused";
  const needsServer = (r: RemoteSource): boolean =>
    r.serverTest.state !== "ok" || !r.serverModel;
  const blocked =
    (voiceSource === "mac" && !chosenVoice) ||
    (voiceSource === "server" && needsServer(voiceRemote)) ||
    (voiceSource === "cloud" && needsKey(voiceRemote)) ||
    (textSource === "server" && needsServer(textRemote)) ||
    (textSource === "cloud" && needsKey(textRemote));

  // ---- Downloads of the saved default models -----------------------------
  const defaultVoiceItem =
    defaultVoice?.provider === "local-mlx" ||
    defaultVoice?.provider === "local-whisper"
      ? allVoiceItems.find((v) => v.modelId === defaultVoice.model_id)
      : undefined;
  const defaultTextItem =
    defaultLlm?.provider === MLX_LLM_PROVIDER_ID
      ? llmItems.find((i) => i.key === defaultLlm.model_id)
      : undefined;
  const lines = [
    ...(defaultVoiceItem ? [voiceLine(defaultVoiceItem)] : []),
    ...(defaultTextItem ? [textLine(defaultTextItem)] : []),
  ];
  const downloads = summarizeDownloads(lines, downloadStarted);

  const refreshStatuses = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.mlxStatus }),
      queryClient.invalidateQueries({ queryKey: queryKeys.whisperStatus }),
      queryClient.invalidateQueries({ queryKey: queryKeys.mlxLlmStatus }),
      queryClient.invalidateQueries({ queryKey: queryKeys.models.all }),
    ]);
  }, [queryClient]);

  const startDownload = useCallback(
    async (kind: "mlx" | "whisper" | "llm", defId: string) => {
      const client = getClient();
      if (kind === "mlx") {
        await client.api["mlx-asr"].models[":model"].download.$post({
          param: { model: defId },
        });
      } else if (kind === "whisper") {
        await client.api.whisper.models[":model"].download.$post({
          param: { model: defId },
        });
      } else {
        await client.api["mlx-llm"].models[":model"].download.$post({
          param: { model: defId },
        });
      }
    },
    [],
  );

  const saveDefault = useCallback(
    async (model: SavedModel, type: "voice" | "llm") => {
      const res = await getClient().api.models.configured.$post({
        json: {
          provider: model.provider,
          model_id: model.modelId,
          model_name: model.modelName,
          type,
          is_default: true,
        },
      });
      if (!res.ok) throw new Error("save");
    },
    [],
  );

  const commit = useCallback(async (): Promise<string | null> => {
    setCommitting(true);
    try {
      const client = getClient();
      // Voice.
      if (voiceSource === "mac" && chosenVoice?.defId) {
        const provider =
          chosenVoice.localEngine === "mlx" ? "local-mlx" : "local-whisper";
        await saveDefault(
          {
            provider,
            modelId: `${provider}/${chosenVoice.defId}`,
            modelName: chosenVoice.name,
          },
          "voice",
        );
        if (chosenVoice.status !== "ready") {
          await startDownload(
            chosenVoice.localEngine === "mlx" ? "mlx" : "whisper",
            chosenVoice.defId,
          );
        }
      } else if (voiceSource === "server") {
        const server =
          voiceRemote.serverTest.state === "ok"
            ? voiceRemote.serverTest.server
            : null;
        if (!server || !voiceRemote.serverModel) return "voice-server";
        await saveDefault(
          {
            provider: SERVER_PROVIDER_ID,
            modelId: `server/${server.id}/${voiceRemote.serverModel}`,
            modelName: voiceRemote.serverModel,
          },
          "voice",
        );
      } else if (voiceSource === "cloud") {
        const model = cloudModelFor(available, "voice", voiceRemote.provider);
        if (!model) return "voice-cloud";
        await client.api.keys.$post({
          json: {
            provider: voiceRemote.provider,
            key: voiceRemote.cloudKey.trim(),
          },
        });
        await saveDefault(
          {
            provider: model.provider_id,
            modelId: model.model_id,
            modelName: model.model_name,
          },
          "voice",
        );
      }
      // Text.
      if (textSource === "mac" && chosenText) {
        await saveDefault(
          {
            provider: MLX_LLM_PROVIDER_ID,
            modelId: `${MLX_LLM_PROVIDER_ID}/${chosenText.defId}`,
            modelName: chosenText.name,
          },
          "llm",
        );
        if (chosenText.status !== "ready") {
          await startDownload("llm", chosenText.defId);
        }
      } else if (textSource === "server") {
        const server =
          textRemote.serverTest.state === "ok"
            ? textRemote.serverTest.server
            : null;
        if (!server || !textRemote.serverModel) return "text-server";
        await saveDefault(
          {
            provider: SERVER_PROVIDER_ID,
            modelId: `server/${server.id}/${textRemote.serverModel}`,
            modelName: textRemote.serverModel,
          },
          "llm",
        );
      } else if (textSource === "cloud") {
        const model = cloudModelFor(available, "llm", textRemote.provider);
        if (!model) return "text-cloud";
        await client.api.keys.$post({
          json: {
            provider: textRemote.provider,
            key: textRemote.cloudKey.trim(),
          },
        });
        await saveDefault(
          {
            provider: model.provider_id,
            modelId: model.model_id,
            modelName: model.model_name,
          },
          "llm",
        );
      }
      await refreshStatuses();
      return null;
    } catch {
      return "failed";
    } finally {
      setCommitting(false);
    }
  }, [
    available,
    chosenText,
    chosenVoice,
    refreshStatuses,
    saveDefault,
    startDownload,
    textRemote,
    textSource,
    voiceRemote,
    voiceSource,
  ]);

  const startRecommendedText = useCallback(async () => {
    if (!recommendedText) return;
    await saveDefault(
      {
        provider: MLX_LLM_PROVIDER_ID,
        modelId: `${MLX_LLM_PROVIDER_ID}/${recommendedText.defId}`,
        modelName: recommendedText.name,
      },
      "llm",
    );
    if (recommendedText.status !== "ready") {
      await startDownload("llm", recommendedText.defId);
    }
    await refreshStatuses();
  }, [recommendedText, refreshStatuses, saveDefault, startDownload]);

  const retryDownloads = useCallback(async () => {
    const tasks: Promise<void>[] = [];
    if (defaultVoiceItem?.defId && defaultVoiceItem.status !== "ready") {
      tasks.push(
        startDownload(
          defaultVoiceItem.localEngine === "mlx" ? "mlx" : "whisper",
          defaultVoiceItem.defId,
        ),
      );
    }
    if (defaultTextItem && defaultTextItem.status !== "ready") {
      tasks.push(startDownload("llm", defaultTextItem.defId));
    }
    await Promise.allSettled(tasks);
    await refreshStatuses();
  }, [defaultTextItem, defaultVoiceItem, refreshStatuses, startDownload]);

  const clearVoiceDefault = useCallback(async () => {
    if (defaultVoice) {
      await getClient().api.models.configured[":id"].$delete({
        param: { id: String(defaultVoice.id) },
      });
    }
    await refreshStatuses();
  }, [defaultVoice, refreshStatuses]);

  // Pre-warm the local voice engine once its download lands, so the first
  // dictation of "Try it" is fast.
  const warmed = useRef(false);
  useEffect(() => {
    if (
      warmed.current ||
      defaultVoiceItem?.status !== "ready" ||
      !defaultVoiceItem.defId
    ) {
      return;
    }
    warmed.current = true;
    const client = getClient();
    const start =
      defaultVoiceItem.localEngine === "mlx"
        ? client.api["mlx-asr"].server.start
        : client.api.whisper.server.start;
    start.$post({ json: { modelId: defaultVoiceItem.defId } }).catch(() => {});
  }, [defaultVoiceItem]);

  const setVoiceSource = useCallback(
    (source: Source | "later") => {
      setVoiceSourceState(source);
      voiceRemote.reset();
    },
    [voiceRemote],
  );
  const setTextSource = useCallback(
    (source: Source) => {
      setTextSourceState(source);
      textRemote.reset();
    },
    [textRemote],
  );

  const useRecommendation = useCallback(() => {
    setVoiceSourceState("mac");
    setVoicePick(null);
    setTextSourceState("mac");
    setTextPick(null);
  }, []);

  const toDraft = useCallback((): OnboardingDraft => {
    const voicePickNow = voicePick ?? recVoicePick;
    return {
      voiceSource,
      voiceModel:
        voiceSource === "mac"
          ? `${voicePickNow.engine}:${voicePickNow.defId}`
          : voiceSource === "server"
            ? (voiceRemote.serverModel ?? undefined)
            : undefined,
      textSource:
        textSource === "mac" && textPick === "none" ? "none" : textSource,
      textModel:
        textSource === "mac" && textPick !== "none"
          ? (textPick ?? recommendedText?.defId)
          : undefined,
      voiceServerUrl: voiceRemote.serverUrl || undefined,
      textServerUrl: textRemote.serverUrl || undefined,
      voiceProvider: voiceRemote.provider,
      textProvider: textRemote.provider,
    };
  }, [
    recVoicePick,
    recommendedText,
    textPick,
    textRemote,
    textSource,
    voicePick,
    voiceRemote,
    voiceSource,
  ]);

  return {
    loading:
      !profile ||
      !whisperStatus ||
      (!mlxStatus && mlxQuery.fetchStatus !== "idle") ||
      (!llmQuery.data && llmQuery.fetchStatus !== "idle") ||
      !availableQuery.data,
    profile,
    servers,
    voiceItems,
    llmItems,
    qwenLanguages,
    recommendedVoice,
    recommendedText,
    voiceSource,
    setVoiceSource,
    voicePick,
    pickVoice: setVoicePick,
    textSource,
    setTextSource,
    textPick,
    pickText: setTextPick,
    voiceRemote,
    textRemote,
    voiceProviders,
    textProviders,
    useRecommendation,
    chosenVoice,
    chosenText,
    plan,
    diskWarning,
    qwenWarning,
    blocked,
    commit,
    committing,
    downloads,
    startRecommendedText,
    retryDownloads,
    clearVoiceDefault,
    defaultVoice,
    defaultLlm,
    defaultVoiceItem,
    defaultTextItem,
    toDraft,
  };
}
