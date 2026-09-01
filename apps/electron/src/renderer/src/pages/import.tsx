import { DragSpacer } from "@renderer/components/drag-spacer";
import { Button } from "@renderer/components/ui/button";
import { Card } from "@renderer/components/ui/card";
import {
  classifyImportError,
  type ImportErrorKind,
  importExtensionOf,
  isImportableFile,
} from "@renderer/lib/import-audio";
import { queryKeys } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Upload } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

type ImportFile = { name: string; size: number };
type ImportAudioResult = Awaited<ReturnType<typeof window.api.importAudioFile>>;

type ImportState =
  | { status: "idle" }
  | { status: "uploading"; file: ImportFile }
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

  const uploading = state.status === "uploading";

  const submit = useCallback(
    async (path: string, file: ImportFile) => {
      setState({ status: "uploading", file });
      let result: ImportAudioResult;
      try {
        result = await window.api.importAudioFile(path);
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
      } else {
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
      }
    },
    [queryClient, t],
  );

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
      void submit(path, { name: file.name, size: file.size });
    },
    [rejectUnsupported, submit, t],
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
    if (uploading) return;
    const path = await window.api.pickImportFile();
    if (!path) return;
    const name = path.split(/[/\\]/).pop() ?? path;
    if (!isImportableFile(name)) {
      rejectUnsupported(name);
      return;
    }
    void submit(path, { name, size: 0 });
  }, [rejectUnsupported, submit, uploading]);

  const reset = useCallback(() => setState({ status: "idle" }), []);

  const copyTranscript = useCallback(async () => {
    if (state.status !== "done") return;
    await navigator.clipboard.writeText(state.result.cleaned);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [state]);

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

          {state.status !== "done" && (
            <Card
              data-testid="import-dropzone"
              onDragOver={(e) => {
                e.preventDefault();
                if (!uploading) setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              className={cn(
                "flex flex-col items-center gap-3 border-2 border-dashed py-10 text-center transition-colors",
                dragActive && !uploading
                  ? "border-primary bg-primary/5"
                  : "border-border",
                uploading && "pointer-events-none opacity-60",
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
                disabled={uploading}
              >
                {t("import.chooseFile")}
              </Button>
            </Card>
          )}

          {uploading && (
            <p
              data-testid="import-status"
              className="text-muted-foreground mt-4 text-sm"
            >
              {t("import.transcribing")}
            </p>
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
