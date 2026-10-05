import { KNOWN_NOTIFICATION_KEYS } from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import { useDismissible } from "@renderer/hooks/use-dismissible";
import { useVoiceCannotTranscribe } from "@renderer/pages/models/use-servers";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

/**
 * One-time notice on the Today page: the default transcription model runs on
 * an own server and cannot transcribe (specs/model-picker-groups.md section
 * 6.3). The app never switches the model. It points to the Models page.
 */
export function ServerVoiceNotice(): React.JSX.Element | null {
  const { t } = useTranslation();
  const cannotTranscribe = useVoiceCannotTranscribe();
  const { ready, dismissed, dismiss } = useDismissible(
    KNOWN_NOTIFICATION_KEYS.SERVER_VOICE_NOTICE,
  );
  if (!cannotTranscribe || !ready || dismissed) return null;

  return (
    <div className="border-yellow-500/35 bg-yellow-300/15 mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-yellow-950 dark:border-yellow-300/35 dark:bg-yellow-400/15 dark:text-yellow-100">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold">
          {t("models.servers.noticeTitle")}
        </div>
        <p className="mt-0.5 text-[12px] leading-snug opacity-80">
          {t("models.servers.noticeDesc")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button asChild variant="outline" size="sm" onClick={dismiss}>
          <Link to="/settings/models">{t("models.servers.noticeAction")}</Link>
        </Button>
        <Button variant="ghost" size="sm" onClick={dismiss}>
          {t("models.servers.noticeDismiss")}
        </Button>
      </div>
    </div>
  );
}
