import { Button } from "@renderer/components/ui/button";
import { useFileDrop } from "@renderer/hooks/use-file-drop";
import { getClient } from "@renderer/lib/api";
import {
  importExtensionOf,
  isImportableFile,
} from "@renderer/lib/import-audio";
import { queryKeys } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { AudioLines, RefreshCw, Upload } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

// ---------------------------------------------------------------------------
// Import (specs/meeting-import.md §4.5): both layouts expose the same
// click→picker / drag-drop affordance backed by IPC
// (`window.api.pickMeetingAudioFile` / `importMeetingAudio`). One import in
// flight at a time; errors render inline and non-destructively.
// ---------------------------------------------------------------------------

export type MeetingImportState =
  | { status: "idle" }
  | { status: "importing" }
  | { status: "error"; message: string; detail?: string };

export function useMeetingImport(onImported: (id: string) => void): {
  state: MeetingImportState;
  importing: boolean;
  handleFile: (file: File) => void;
  handlePick: () => Promise<void>;
} {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [state, setState] = useState<MeetingImportState>({ status: "idle" });

  const submit = useCallback(
    async (path: string) => {
      setState({ status: "importing" });
      let result: Awaited<ReturnType<typeof window.api.importMeetingAudio>>;
      try {
        result = await window.api.importMeetingAudio(path);
      } catch (err) {
        setState({
          status: "error",
          message: t("meetings.importFailed"),
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (result.ok) {
        setState({ status: "idle" });
        // Success: refresh list+details, let the page select the new meeting
        // (explicit selection wins over the default rail selection), then
        // auto-fire the async transcribe job (§4.5): the imported meeting
        // immediately goes `transcribing` and the existing polling/detail UI
        // takes over. A fresh import can't hit the server's 409s; provider
        // failures surface through the detail view's existing error banner,
        // never the import affordance — so any non-2xx is swallowed.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.meetings.all,
        });
        onImported(result.meeting.id);
        void getClient()
          .api.meetings[":id"].transcribe.$post({
            param: { id: result.meeting.id },
          })
          .catch(() => {})
          .finally(() => {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.meetings.all,
            });
          });
        return;
      }
      setState({
        status: "error",
        message: t("meetings.importFailed"),
        detail:
          [result.error, result.detail].filter(Boolean).join(" — ") ||
          undefined,
      });
    },
    [onImported, queryClient, t],
  );

  const busy = state.status === "importing";

  const handleFile = useCallback(
    (file: File) => {
      if (busy) return;
      if (!isImportableFile(file.name)) {
        const ext = importExtensionOf(file.name) ?? "";
        setState({
          status: "error",
          message: t("meetings.importUnsupported", { ext }),
        });
        return;
      }
      // Resolve the on-disk path in preload (webUtils.getPathForFile) —
      // same pattern as pages/import.tsx; the bytes never live in the
      // renderer.
      const path = window.api.getPathForFile(file);
      if (!path) {
        setState({ status: "error", message: t("meetings.importNoAccess") });
        return;
      }
      void submit(path);
    },
    [busy, submit, t],
  );

  const handlePick = useCallback(async () => {
    if (busy) return;
    const path = await window.api.pickMeetingAudioFile();
    if (!path) return; // canceled
    const name = path.split(/[/\\]/).pop() ?? path;
    if (!isImportableFile(name)) {
      const ext = importExtensionOf(name) ?? "";
      setState({
        status: "error",
        message: t("meetings.importUnsupported", { ext }),
      });
      return;
    }
    void submit(path);
  }, [busy, submit, t]);

  return { state, importing: busy, handleFile, handlePick };
}

export function MeetingImportError({
  error,
}: {
  error: { message: string; detail?: string };
}): React.JSX.Element {
  return (
    <div
      data-testid="meetings-import-error"
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive mx-auto mt-4 max-w-[480px] rounded-lg border px-3.5 py-2.5 text-left text-[12px]"
    >
      <p className="font-medium">{error.message}</p>
      {error.detail && (
        <p className="text-destructive/80 mt-0.5 break-words text-[11px]">
          {error.detail}
        </p>
      )}
    </div>
  );
}

export function ImportButton({
  onPick,
  importing,
  size,
  testId,
}: {
  onPick: () => void;
  importing: boolean;
  size: "xs" | "sm";
  testId: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Button
      data-testid={testId}
      variant="outline"
      size={size}
      onClick={onPick}
      disabled={importing}
    >
      {importing ? (
        <RefreshCw data-icon="inline-start" className="animate-spin" />
      ) : (
        <Upload data-icon="inline-start" />
      )}
      {importing ? t("meetings.importing") : t("meetings.importAction")}
    </Button>
  );
}

export function MeetingsEmptyState({
  onFile,
  onPick,
  importing,
  error,
}: {
  onFile: (file: File) => void;
  onPick: () => void;
  importing: boolean;
  error: { message: string; detail?: string } | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  // The whole dashed first-run card is the drop zone (specs/meeting-import.md
  // §4.5); the import section adds the picker affordance + hint copy.
  const { dragActive, handlers } = useFileDrop(onFile, importing);
  return (
    <div
      data-testid="meetings-import-dropzone"
      {...handlers}
      className={cn(
        "border-border bg-card rounded-lg border border-dashed px-9 py-[52px] text-center transition-colors",
        dragActive && !importing && "border-primary bg-primary/5",
        importing && "pointer-events-none opacity-60",
      )}
    >
      <div className="bg-accent mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl">
        <AudioLines className="text-primary h-6 w-6" />
      </div>
      <h2 className="display text-foreground m-0 text-[26px] font-medium leading-none">
        {t("meetings.emptyTitle")}
      </h2>
      <p className="text-muted-foreground mx-auto mt-2.5 max-w-[420px] text-[13px] leading-[1.55]">
        {t("meetings.emptyDesc")}
      </p>
      <div className="border-border/70 mt-7 flex flex-col items-center gap-2 border-t pt-6">
        <p className="text-foreground text-[13px] font-medium">
          {t("meetings.importTitle")}
        </p>
        <p className="text-muted-foreground max-w-[420px] text-[12px] leading-[1.5]">
          {t("meetings.importDesc")}
        </p>
        <div className="mt-1.5">
          <ImportButton
            testId="meetings-import-choose-file"
            onPick={onPick}
            importing={importing}
            size="sm"
          />
        </div>
        <p className="text-muted-foreground/80 text-[11px]">
          {t("meetings.importHint")}
        </p>
      </div>
      {error && <MeetingImportError error={error} />}
    </div>
  );
}

/**
 * Master-detail rail affordance (spec §4.5): a compact Import button beside
 * the compact RecordingCard — the wrapping row is the drop target.
 */
export function MeetingImportRail({
  onFile,
  onPick,
  importing,
  error,
  children,
}: {
  onFile: (file: File) => void;
  onPick: () => void;
  importing: boolean;
  error: { message: string; detail?: string } | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const { dragActive, handlers } = useFileDrop(onFile, importing);
  return (
    <div
      {...handlers}
      className={cn(
        "rounded-[9px] transition-colors",
        dragActive && !importing && "bg-card/60",
        importing && "opacity-60",
      )}
    >
      {children}
      <div className="mb-4 flex min-w-0 items-center gap-2">
        <ImportButton
          testId="meetings-import-choose-file"
          onPick={onPick}
          importing={importing}
          size="xs"
        />
      </div>
      {error && (
        <div className="mb-4">
          <p
            data-testid="meetings-import-error"
            role="alert"
            className="text-destructive text-[10.5px] leading-[1.4]"
          >
            {error.message}
            {error.detail && (
              <span className="text-destructive/70"> · {error.detail}</span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
