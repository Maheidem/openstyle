import { DragSpacer } from "@renderer/components/drag-spacer";
import { Button } from "@renderer/components/ui/button";
import { Card } from "@renderer/components/ui/card";
import {
  classifyImportError,
  type ImportErrorKind,
  importExtensionOf,
  isImportableFile,
} from "@renderer/lib/import-audio";
import { formatBytes } from "@renderer/lib/models";
import { queryKeys } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, FileAudio, RefreshCw, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type ImportFile = { name: string; size: number };
type ImportAudioResult = Awaited<ReturnType<typeof window.api.importAudioFile>>;

/** A staged file awaiting the user's go-ahead (UX-A3 review step). */
type SelectedFile = ImportFile & {
  path: string;
  /** Known for dropped files (Audio metadata); null when not derivable. */
  durationMs: number | null;
};

type ImportState =
  | { status: "idle" }
  | { status: "selected"; file: SelectedFile }
  | {
      status: "uploading";
      file: SelectedFile;
      jobId: string;
      startedAt: number;
    }
  | {
      status: "done";
      file: ImportFile;
      result: Extract<ImportAudioResult, { ok: true }>;
    }
  | {
      status: "error";
      file?: ImportFile;
      error: { kind: ImportErrorKind; message: string; detail?: string };
    };

/** UX-A3 threshold: past this weight the review card warns about the wait. */
const SLOW_IMPORT_DURATION_MS = 30 * 60_000;
const SLOW_IMPORT_BYTES = 300_000_000;

/** Locale-neutral clock format (h:)mm:ss, like the meetings page. */
function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "0:00";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Cheap client-side duration probe for a dropped File: an Audio element over
 * an object URL reads metadata without decoding the whole file. Resolves null
 * on error or timeout — the review card then shows size-only honest copy.
 */
function probeAudioDurationMs(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    const finish = (value: number | null): void => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 3_000);
    audio.onloadedmetadata = () =>
      finish(
        Number.isFinite(audio.duration) && audio.duration > 0
          ? Math.round(audio.duration * 1000)
          : null,
      );
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}

function errorTitleKey(kind: ImportErrorKind): string {
  switch (kind) {
    case "unsupported_format":
      return "import.error.unsupportedFormat";
    case "too_large":
      return "import.error.tooLarge";
    case "decode":
      return "import.error.decode";
    case "config":
      return "import.error.config";
    case "transcription":
      return "import.error.transcription";
    case "network":
      return "import.error.network";
    case "not_found":
      return "import.error.notFound";
    default:
      return "import.error.unknown";
  }
}

export default function ImportPage(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [state, setState] = useState<ImportState>({ status: "idle" });
  const [dragActive, setDragActive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Guards the async duration probe: a slow metadata read must not patch a
  // state the user has already moved on from.
  const selectedPathRef = useRef<string | null>(null);

  const uploading = state.status === "uploading";

  // Elapsed-seconds ticker for the progress card (UX-04) — same family as the
  // pill's readout, driven from the upload's start time.
  const startedAt = state.status === "uploading" ? state.startedAt : null;
  useEffect(() => {
    if (startedAt === null) return;
    setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const submit = useCallback(
    async (file: SelectedFile) => {
      const jobId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `import-${Date.now()}`;
      setState({
        status: "uploading",
        file,
        jobId,
        startedAt: Date.now(),
      });
      setCancelRequested(false);
      let result: ImportAudioResult;
      try {
        result = await window.api.importAudioFile(file.path, { id: jobId });
      } catch (err) {
        setState({
          status: "error",
          file,
          error: {
            kind: "unknown",
            message: t(errorTitleKey("unknown")),
            detail: err instanceof Error ? err.message : String(err),
          },
        });
        return;
      }
      if (result.ok) {
        setState({ status: "done", file, result });
        void queryClient.invalidateQueries({ queryKey: queryKeys.history.all });
        return;
      }
      if (result.code === "CANCELLED") {
        // A cancel is not an error: nothing was produced, so return to the
        // empty dropzone rather than an error card.
        setState({ status: "idle" });
        return;
      }
      const kind = classifyImportError(result);
      setState({
        status: "error",
        file,
        error: {
          kind,
          message: t(errorTitleKey(kind), {
            ext: file.name.includes(".") ? importExtensionOf(file.name) : "",
          }),
          detail: result.detail,
        },
      });
    },
    [queryClient, t],
  );

  const stageSelected = useCallback((file: SelectedFile) => {
    selectedPathRef.current = file.path;
    setState({ status: "selected", file });
  }, []);

  const rejectUnsupported = useCallback(
    (name: string) => {
      const ext = importExtensionOf(name) ?? "";
      setState({
        status: "error",
        error: {
          kind: "unsupported_format",
          message: t("import.error.unsupportedFormat", { ext }),
        },
      });
    },
    [t],
  );

  const handleFile = useCallback(
    (file: File) => {
      if (!isImportableFile(file.name)) {
        rejectUnsupported(file.name);
        return;
      }
      const path = window.api.getPathForFile(file);
      if (!path) {
        setState({
          status: "error",
          error: {
            kind: "unknown",
            message: t("import.error.noAccess"),
          },
        });
        return;
      }
      // UX-A3: stage the file for review with its expected weight before any
      // upload begins. Duration arrives asynchronously; size is immediate.
      stageSelected({
        path,
        name: file.name,
        size: file.size,
        durationMs: null,
      });
      void probeAudioDurationMs(file).then((durationMs) => {
        if (durationMs === null || selectedPathRef.current !== path) return;
        setState((prev) =>
          (prev.status === "selected" || prev.status === "uploading") &&
          prev.file.path === path
            ? { ...prev, file: { ...prev.file, durationMs } }
            : prev,
        );
      });
    },
    [rejectUnsupported, stageSelected, t],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      if (uploading) return;
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile, uploading],
  );

  const handleChoose = useCallback(async () => {
    if (uploading || state.status === "selected") return;
    const picked = await window.api.pickImportFile();
    if (!picked) return;
    const name = picked.path.split(/[/\\]/).pop() ?? picked.path;
    if (!isImportableFile(name)) {
      rejectUnsupported(name);
      return;
    }
    // No File object on the picker path, so duration isn't derivable
    // client-side — the review card shows the stat(2)-ed size with honest
    // copy instead.
    stageSelected({
      path: picked.path,
      name,
      size: picked.size,
      durationMs: null,
    });
  }, [rejectUnsupported, stageSelected, state.status, uploading]);

  const cancelImport = useCallback(() => {
    if (state.status !== "uploading" || cancelRequested) return;
    setCancelRequested(true);
    window.api.abortJob(state.jobId);
  }, [cancelRequested, state]);

  const reset = useCallback(() => {
    selectedPathRef.current = null;
    setState({ status: "idle" });
  }, []);

  const copyTranscript = useCallback(async () => {
    if (state.status !== "done") return;
    await navigator.clipboard.writeText(state.result.cleaned);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [state]);

  const weightLine = useCallback(
    (file: { size: number; durationMs: number | null }): string => {
      if (file.durationMs !== null) {
        return t("import.review.weightWithDuration", {
          duration: formatDuration(file.durationMs),
          size: formatBytes(file.size),
        });
      }
      if (file.size > 0) {
        return t("import.review.sizeOnly", { size: formatBytes(file.size) });
      }
      return "";
    },
    [t],
  );

  const isSlow = (file: { size: number; durationMs: number | null }): boolean =>
    (file.durationMs ?? 0) >= SLOW_IMPORT_DURATION_MS ||
    file.size >= SLOW_IMPORT_BYTES;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DragSpacer />
      <div
        className="responsive-page-scroll flex-1 overflow-auto pt-5"
        style={{ scrollbarWidth: "none" } as React.CSSProperties}
      >
        <div className="mx-auto max-w-[760px]">
          <h1 className="display text-foreground m-0 text-[32px] font-medium leading-tight tracking-[-0.02em]">
            {t("import.title")}
          </h1>
          <p className="text-muted-foreground mb-6 max-w-[480px] text-[13px] leading-[1.5]">
            {t("import.subtitle")}
          </p>

          {(state.status === "idle" || state.status === "error") && (
            <Card
              data-testid="import-dropzone"
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              className={cn(
                "flex flex-col items-center gap-3 border-2 border-dashed py-10 text-center transition-colors",
                dragActive ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              <Upload className="text-muted-foreground size-6" />
              <div>
                <p className="text-foreground text-sm font-medium">
                  {t("import.dropzone.title")}
                </p>
                <p className="text-muted-foreground text-sm">
                  {t("import.dropzone.subtitle")}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t("import.dropzone.formats")}
                </p>
              </div>
              <Button
                data-testid="import-choose-file"
                variant="outline"
                onClick={handleChoose}
              >
                {t("import.chooseFile")}
              </Button>
            </Card>
          )}

          {/* UX-A3 review step: the expected weight of what's about to be
              uploaded, before the upload begins — the one honest moment to
              say "this may take a while". */}
          {state.status === "selected" && (
            <Card data-testid="import-review" className="mt-4 p-4">
              <div className="flex items-center gap-3">
                <FileAudio className="text-muted-foreground h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p
                    data-testid="import-review-name"
                    className="text-foreground truncate text-sm font-medium"
                  >
                    {state.file.name}
                  </p>
                  <p
                    data-testid="import-review-weight"
                    className="text-muted-foreground mt-0.5 text-xs"
                  >
                    {weightLine(state.file)}
                  </p>
                  {isSlow(state.file) && (
                    <p
                      data-testid="import-review-slow"
                      className="text-muted-foreground mt-0.5 text-xs"
                    >
                      {t("import.review.slow")}
                    </p>
                  )}
                </div>
                <Button
                  data-testid="import-review-reset"
                  variant="outline"
                  size="sm"
                  onClick={reset}
                >
                  {t("import.review.chooseAnother")}
                </Button>
                <Button
                  data-testid="import-start"
                  size="sm"
                  onClick={() => void submit(state.file)}
                >
                  {t("import.review.transcribe")}
                </Button>
              </div>
            </Card>
          )}

          {/* UX-04: the same progress-card family as the meetings transcribe
              card — spinner, elapsed seconds, and a Cancel that severs the
              upload — replacing the old static "Transcribing…" line. */}
          {uploading && (
            <Card data-testid="import-progress" className="mt-4 p-4">
              <div className="flex items-center gap-3">
                <RefreshCw className="text-primary h-3.5 w-3.5 animate-spin" />
                <div className="min-w-0 flex-1">
                  <div
                    data-testid="import-status"
                    className="text-foreground text-[12.5px]"
                  >
                    {cancelRequested
                      ? t("import.cancelling")
                      : t("import.transcribing")}
                  </div>
                  <div className="text-muted-foreground mt-0.5 truncate text-xs">
                    {state.file.name}
                    {weightLine(state.file) && ` · ${weightLine(state.file)}`}
                  </div>
                </div>
                <span
                  data-testid="import-elapsed"
                  className="mono text-muted-foreground text-[10px] tabular-nums"
                >
                  {t("import.progress.elapsed", { seconds: elapsedSeconds })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="import-cancel"
                  onClick={cancelImport}
                  disabled={cancelRequested}
                >
                  {t("import.cancel")}
                </Button>
              </div>
            </Card>
          )}

          {state.status === "error" && (
            <div
              data-testid="import-error"
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive mt-4 rounded-lg border p-4 text-sm"
            >
              <p className="font-medium">{state.error.message}</p>
              {state.error.detail && (
                <p className="text-destructive/80 mt-1 text-xs">
                  {state.error.detail}
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={reset}
              >
                {t("import.tryAnother")}
              </Button>
            </div>
          )}

          {state.status === "done" && (
            <Card data-testid="import-transcript" className="mt-4">
              <div className="flex items-center justify-between gap-3 px-4">
                <h2 className="text-foreground text-sm font-medium">
                  {t("import.transcriptTitle")}
                </h2>
                <Button
                  data-testid="import-copy"
                  variant="ghost"
                  size="icon-xs"
                  onClick={copyTranscript}
                  title={t("import.copy")}
                  aria-label={t("import.copy")}
                >
                  {copied ? <Check className="text-primary" /> : <Copy />}
                </Button>
              </div>
              <p className="text-foreground select-text whitespace-pre-wrap px-4 text-sm">
                {state.result.cleaned}
              </p>
              <div className="text-muted-foreground px-4 text-xs">
                {state.result.model}
              </div>
              <div className="px-4">
                <Button
                  data-testid="import-reset"
                  variant="outline"
                  size="sm"
                  onClick={reset}
                >
                  {t("import.importAnother")}
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
