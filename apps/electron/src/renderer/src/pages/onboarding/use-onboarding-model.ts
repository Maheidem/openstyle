import { getClient } from "@renderer/lib/api";
import { buildVoiceItems, type VoiceItem } from "@renderer/lib/models";
import { IS_MAC } from "@renderer/lib/platform";
import {
  mlxStatusQueryOptions,
  queryKeys,
  whisperStatusQueryOptions,
} from "@renderer/lib/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

// The opinionated on-device pick, in order of preference. Qwen3 ASR (MLX)
// is the hero when the machine can run it; whisper.cpp's Balanced model is
// the universal fallback (it builds its own binary, no Python required).
// It downloads in the background while the user picks a language and a
// hotkey — first-time users never choose a model.
const RECOMMENDED_MLX_DEF = "qwen3-0.6b-8bit";
const RECOMMENDED_WHISPER_DEF = "small-q5_1";

// The on-device model setup for onboarding: auto-pick, pre-warm and the
// background download. The steps only read the result.
export function useOnboardingModel(): {
  localModel: VoiceItem | undefined;
  blockedReason: "downloading" | "notReady" | null;
  download: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  // The on-device model the user picked (auto-picked at first).
  const [picked, setPicked] = useState<{
    defId: string;
    engine: "whisper" | "mlx";
  } | null>(null);
  const autoPicked = useRef(false);
  const warmed = useRef(false);

  // Whisper / MLX status via React Query. refetchInterval replaces the manual
  // 500ms setInterval polling: it polls only while a download/verify is active
  // and stops automatically once everything settles.
  const whisperQuery = useQuery(whisperStatusQueryOptions());
  const mlxQuery = useQuery(mlxStatusQueryOptions());

  const whisperStatus = whisperQuery.data ?? null;
  const mlxStatus = mlxQuery.data ?? null;
  // True once we know whether MLX can run — the auto-pick waits for the
  // Qwen-vs-Whisper decision instead of settling on Whisper Base while the MLX
  // probe is in flight. Non-Mac has nothing to wait for.
  const mlxResolved = !IS_MAC || mlxQuery.isFetched;

  // Onboarding shows on-device models only, so there are no cloud rows.
  const allVoiceItems = buildVoiceItems([], whisperStatus, mlxStatus, {
    selectedProvider:
      picked?.engine === "mlx"
        ? "local-mlx"
        : picked
          ? "local-whisper"
          : undefined,
    selectedWhisperModelId:
      picked?.engine === "whisper" ? picked.defId : undefined,
    selectedMlxModelId: picked?.engine === "mlx" ? picked.defId : undefined,
    keyProviders: new Set(),
  });

  // Resolve the opinionated recommendation: Qwen3 on-device when MLX can run,
  // otherwise whisper.cpp Base (universal).
  const mlxQwen = allVoiceItems.find(
    (v) => v.localEngine === "mlx" && v.defId === RECOMMENDED_MLX_DEF,
  );
  const whisperBase = allVoiceItems.find(
    (v) => v.localEngine === "whisper" && v.defId === RECOMMENDED_WHISPER_DEF,
  );
  const recommended: VoiceItem | undefined =
    mlxQwen && mlxStatus?.canRun ? mlxQwen : (whisperBase ?? mlxQwen);

  // Auto-setup: once the MLX capability check settles, commit a default
  // on-device model. Download starts from the setup panel when the user taps
  // Download.
  useEffect(() => {
    if (
      autoPicked.current ||
      !mlxResolved ||
      !recommended?.defId ||
      !recommended.localEngine
    )
      return;
    autoPicked.current = true;
    const { defId, localEngine } = recommended;
    setPicked({ defId, engine: localEngine });
    const provider = localEngine === "mlx" ? "local-mlx" : "local-whisper";
    getClient()
      .api.models.configured.$post({
        json: {
          provider,
          model_id: `${provider}/${defId}`,
          model_name: recommended.name,
          type: "voice",
          is_default: true,
        },
      })
      .catch(() => {});
  }, [recommended, mlxResolved]);

  // The model the setup panel shows: the pick, falling back to the
  // recommendation before the auto-pick runs.
  const localSetupModel = allVoiceItems.find((v) => v.selected) ?? recommended;

  // Pre-warm the local engine the moment its download lands, so the first
  // dictation in the tutorial is fast.
  useEffect(() => {
    if (
      warmed.current ||
      localSetupModel?.status !== "ready" ||
      !localSetupModel.defId
    )
      return;
    warmed.current = true;
    if (localSetupModel.localEngine === "mlx") {
      getClient()
        .api["mlx-asr"].server.start.$post({
          json: { modelId: localSetupModel.defId },
        })
        .catch(() => {});
    } else {
      getClient()
        .api.whisper.server.start.$post({
          json: { modelId: localSetupModel.defId },
        })
        .catch(() => {});
    }
  }, [localSetupModel]);

  const mustHaveLocalReady =
    !!localSetupModel && localSetupModel.status !== "ready";
  const localSetupActive =
    localSetupModel?.status === "downloading" ||
    localSetupModel?.status === "verifying" ||
    localSetupModel?.state?.phase === "building_binary";
  // Why the draft step cannot continue. null means it can. E2E runs skip
  // the wait.
  const blockedReason: "downloading" | "notReady" | null =
    mustHaveLocalReady && !window.api?.isE2E
      ? localSetupActive
        ? "downloading"
        : "notReady"
      : null;

  const download = useCallback(async () => {
    if (!localSetupModel?.defId || window.api?.isE2E) return;
    if (localSetupModel.localEngine === "mlx") {
      await getClient().api["mlx-asr"].models[":model"].download.$post({
        param: { model: localSetupModel.defId },
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mlxStatus });
    } else {
      await getClient().api.whisper.models[":model"].download.$post({
        param: { model: localSetupModel.defId },
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.whisperStatus });
    }
  }, [localSetupModel, queryClient]);

  return { localModel: localSetupModel, blockedReason, download };
}
