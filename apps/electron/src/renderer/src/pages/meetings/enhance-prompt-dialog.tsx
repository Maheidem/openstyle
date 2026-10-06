import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { getClient } from "@renderer/lib/api";
import type { ConfiguredModel } from "@renderer/lib/models";
import { queryKeys } from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { SETTINGS_KEYS } from "../../../../shared/settings-keys";

/**
 * The scope key the auto-Enhance prompt names for the default LLM
 * (specs/meeting-transcription-v2.md §3.2): `"local"` for the on-device MLX
 * provider, `"server"` for a user-run server, `"cloud"` for anything else.
 * `null` means no default LLM is configured at all. Callers render the
 * human string via the `meetings.enhancePromptScope.*` locale keys.
 */
export function llmScopeLabel(
  provider: string | undefined,
): "local" | "server" | "cloud" | null {
  if (provider === "local-mlx") return "local";
  if (provider === "server") return "server";
  return provider ? "cloud" : null;
}

/**
 * One-time auto-Enhance prompt for existing users
 * (specs/meeting-transcription-v2.md §3.2). The Meetings page renders it
 * only when at least one meeting is transcribed or summarized, no
 * `meeting_enhance_auto_run` row exists, and `meeting_enhance_prompt_seen`
 * is not "true". It must be answered, not dismissed: both buttons write the
 * seen flag (turn on writes the flag and turns the setting on), so the
 * dialog can never show twice.
 */
export function EnhancePromptDialog(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  // A refused/failed settings write: keep the dialog open so the choice can
  // be retried (closing on a failed write would silently lose the prompt).
  const [saveError, setSaveError] = useState(false);

  const { data: models } = useQuery({
    queryKey: queryKeys.models.configured,
    queryFn: async (): Promise<ConfiguredModel[]> => {
      const res = await getClient().api.models.configured.$get();
      if (!res.ok) throw new Error("Failed to load configured models");
      return (await res.json()) as ConfiguredModel[];
    },
  });
  const defaultLlm = (models ?? []).find(
    (m) => m.type === "llm" && m.is_default === 1,
  );
  const scope = llmScopeLabel(defaultLlm?.provider);

  const choose = useCallback(
    async (turnOn: boolean) => {
      if (busy) return;
      setBusy(true);
      setSaveError(false);
      try {
        // `putSetting` resolves to a boolean (never rejects). A false means
        // the server refused the write — in that case keep the dialog open
        // and surface an error instead of closing on a choice that didn't
        // land.
        let saved = true;
        if (turnOn) {
          saved =
            (await putSetting(SETTINGS_KEYS.meetingEnhanceAutoRun, "true")) &&
            saved;
        }
        // The seen flag is written in BOTH cases, so the dialog is one-time.
        saved =
          (await putSetting(SETTINGS_KEYS.meetingEnhancePromptSeen, "true")) &&
          saved;
        if (!saved) {
          setSaveError(true);
          return;
        }
        await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
        setOpen(false);
      } finally {
        setBusy(false);
      }
    },
    [busy, queryClient],
  );

  return (
    // Escape and an outside click count as "Not now": they write only the
    // seen flag (the same as the outline button), so the dialog is always
    // answered one way or another and never shows twice.
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else if (!busy) void choose(false);
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("meetings.enhancePromptTitle")}</DialogTitle>
          <DialogDescription>
            {defaultLlm && scope
              ? t("meetings.enhancePromptDesc", {
                  model: defaultLlm.model_name,
                  scope: t(`meetings.enhancePromptScope.${scope}`),
                })
              : t("meetings.enhancePromptNoLlm")}
          </DialogDescription>
        </DialogHeader>
        {saveError && (
          <p role="alert" className="text-destructive m-0 text-[13px]">
            {t("meetings.enhancePromptSaveFailed")}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => void choose(false)}
            disabled={busy}
            data-testid="enhance-prompt-not-now"
          >
            {t("meetings.enhancePromptNotNow")}
          </Button>
          <Button
            variant="ink"
            onClick={() => void choose(true)}
            disabled={busy}
            data-testid="enhance-prompt-turn-on"
          >
            {t("meetings.enhancePromptTurnOn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
