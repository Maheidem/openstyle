import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Pause and resume of the running meeting recording. `busy` is true while the
 * main process closes or opens the capture. `error` holds a message in the
 * app language after a failure, else null. The recording stays paused after
 * a failed resume, so the user can try again or stop it.
 */
export function useMeetingPause(): {
  busy: boolean;
  error: string | null;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
} {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (kind: "pause" | "resume") => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const result =
          kind === "pause"
            ? await window.api.pauseMeetingRecording()
            : await window.api.resumeMeetingRecording();
        if (!result.ok) {
          setError(
            t(
              kind === "pause"
                ? "meetings.pauseFailed"
                : "meetings.resumeFailed",
            ),
          );
        }
      } catch {
        setError(
          t(
            kind === "pause" ? "meetings.pauseFailed" : "meetings.resumeFailed",
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, t],
  );

  return {
    busy,
    error,
    pause: useCallback(() => run("pause"), [run]),
    resume: useCallback(() => run("resume"), [run]),
  };
}
