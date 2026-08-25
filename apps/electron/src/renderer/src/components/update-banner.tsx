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
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);

  useEffect(() => {
    const removeAvail = window.api?.onUpdateAvailable((info) => {
      setUpdateAvailable(info.version);
    });
    const removeDownloading = window.api?.onUpdateDownloading((progress) => {
      setUpdateError(null);
      setDownloadPercent(progress.percent >= 0 ? progress.percent : null);
    });
    const removeDownloaded = window.api?.onUpdateDownloaded(() => {
      setUpdateDownloaded(true);
      setDownloadPercent(null);
    });
    const removeError = window.api?.onUpdateError((info) => {
      setUpdateError(info.message);
      setDownloadPercent(null);
    });
    window.api
      ?.checkForUpdate()
      .then((result) => {
        if (result) {
          setUpdateAvailable(result.version);
          if (result.downloadState === "downloaded") {
            setUpdateDownloaded(true);
          } else if (result.downloadState === "downloading") {
            setDownloadPercent(0);
          }
        }
      })
      .catch(() => {});

    return () => {
      removeAvail?.();
      removeDownloading?.();
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
      ) : downloadPercent !== null ? (
        <span className="text-muted-foreground text-xs">
          {downloadPercent > 0
            ? `${Math.round(downloadPercent)}%`
            : t("common.downloading")}
        </span>
      ) : (
        <button
          type="button"
          // downloadUpdate() fires the updater:download IPC message. On a
          // packaged macOS build the main process downloads, verifies, and
          // installs the update itself (see self-updater.ts) — ad-hoc
          // signing makes Squirrel.Mac's own download+install path reject
          // the result, so we replace it entirely there. Anywhere self-update
          // can't run (dev builds, other platforms, or after it errors out)
          // the same click instead opens the GitHub releases page for a
          // manual download, which is why the label switches to "View
          // Release" once updateError is set.
          onClick={() => window.api?.downloadUpdate()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded px-3 py-1 text-xs font-medium"
        >
          {updateError ? t("common.viewRelease") : t("common.downloadUpdate")}
        </button>
      )}
      {updateError && (
        <span className="text-destructive w-full text-xs">{updateError}</span>
      )}
    </div>
  );
}
