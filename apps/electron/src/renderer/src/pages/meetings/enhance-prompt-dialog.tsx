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
 * The scope label the auto-Enhance prompt names for the default LLM
 * (specs/meeting-transcription-v2.md §3.2): "local" for the on-device MLX
 * provider, "your own server" for a user-run server, "cloud" for anything
 * else. `null` means no default LLM is configured at all.
 */
export function llmScopeLabel(provider: string | undefined): string | null {
  if (provider === "local-mlx") return "local";
  if (provider === "server") return "your own server";
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
      setBusy(true);
      try {
        if (turnOn) {
          await putSetting(SETTINGS_KEYS.meetingEnhanceAutoRun, "true");
        }
        // The seen flag is written in BOTH cases, so the dialog is one-time.
        await putSetting(SETTINGS_KEYS.meetingEnhancePromptSeen, "true");
        await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
        setOpen(false);
      } finally {
        setBusy(false);
      }
    },
    [queryClient],
  );

  return (
    // Deliberately un-dismissible without a choice: closing via overlay or
    // Escape is refused (the controlled `open` only turns off through the
    // buttons below), so the seen flag always lands before the dialog goes.
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("meetings.enhancePromptTitle")}</DialogTitle>
          <DialogDescription>
            {defaultLlm && scope
              ? t("meetings.enhancePromptDesc", {
                  model: defaultLlm.model_name,
                  scope,
                })
              : t("meetings.enhancePromptNoLlm")}
          </DialogDescription>
        </DialogHeader>
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
