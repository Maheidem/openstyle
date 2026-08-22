import { cn } from "@renderer/lib/utils";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export function UpdateBanner({
  className,
}: {
  className?: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    const removeAvail = window.api?.onUpdateAvailable((info) => {
      setUpdateAvailable(info.version);
    });
    const removeDownloaded = window.api?.onUpdateDownloaded(() => {
      setUpdateDownloaded(true);
    });
    const removeError = window.api?.onUpdateError((info) => {
      setUpdateError(info.message);
    });
    window.api
      ?.checkForUpdate()
      .then((result) => {
        if (result) {
          setUpdateAvailable(result.version);
          if (result.downloadState === "downloaded") {
            setUpdateDownloaded(true);
          }
        }
      })
      .catch(() => {});

    return () => {
      removeAvail?.();
      removeDownloaded?.();
      removeError?.();
    };
  }, []);

  if (!updateAvailable) return null;

  return (
    <div
      className={cn(
        "border-primary/30 bg-primary/5 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Download className="text-primary h-4 w-4" />
        <span className="min-w-0 text-sm">
          {updateDownloaded
            ? t("settings.updateReady", { version: updateAvailable })
            : t("settings.updateAvailable", { version: updateAvailable })}
        </span>
      </div>
      {updateDownloaded ? (
        <button
          type="button"
          onClick={() => window.api?.installUpdate()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded px-3 py-1 text-xs font-medium"
        >
          {t("common.restartAndUpdate")}
        </button>
      ) : (
        <button
          type="button"
          // downloadUpdate() fires the updater:download IPC message, which the
          // main process now handles by opening the GitHub releases page —
          // ad-hoc-signed builds can't auto-install, so there is no in-app
          // download to show progress for.
          onClick={() => window.api?.downloadUpdate()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded px-3 py-1 text-xs font-medium"
        >
          {t("common.viewRelease")}
        </button>
      )}
      {updateError && (
        <span className="text-destructive w-full text-xs">{updateError}</span>
      )}
    </div>
  );
}
