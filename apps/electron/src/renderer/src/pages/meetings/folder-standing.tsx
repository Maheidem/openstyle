import {
  type FolderStandingErrorCode,
  type FolderStandingState,
  folderStandingErrorSchema,
  folderStandingStateSchema,
} from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import { getClient } from "@renderer/lib/api";
import { formatTimestamp } from "@renderer/lib/format";
import { queryKeys } from "@renderer/lib/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// "Where things stand" of a folder (issue #374, specs/folder-project-page.md
// 6). The text is saved on the server. The page shows it and never waits for
// it: the Overview below does not depend on this card. The button writes a
// new text with one model call.

const ERROR_KEYS: Record<FolderStandingErrorCode, string> = {
  folder_not_found: "meetings.folders.notFound",
  no_content: "meetings.folderStanding.noContent",
  no_llm: "meetings.folderStanding.noModel",
  llm_failed: "meetings.folderStanding.failed",
};

export function standingErrorKey(body: unknown): string {
  const parsed = folderStandingErrorSchema.safeParse(body);
  return parsed.success
    ? ERROR_KEYS[parsed.data.code]
    : "meetings.folderStanding.failed";
}

export function FolderStandingCard({ folderId }: { folderId: string }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.meetings.folderStanding(folderId);
  const { data } = useQuery({
    queryKey,
    queryFn: async (): Promise<FolderStandingState> => {
      const res = await getClient().api.meetings.folders[":id"].standing.$get({
        param: { id: folderId },
      });
      if (!res.ok) throw new Error("standing_failed");
      return folderStandingStateSchema.parse(await res.json());
    },
  });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  // Leaving the page stops the request, so the server stops the model.
  useEffect(() => () => controller.current?.abort(), []);

  const write = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setError(null);
    try {
      const res = await getClient().api.meetings.folders[":id"].standing.$post(
        { param: { id: folderId } },
        { init: { signal: abort.signal } },
      );
      const body: unknown = await res.json();
      if (abort.signal.aborted) return;
      if (res.ok) await queryClient.invalidateQueries({ queryKey });
      else setError(t(standingErrorKey(body)));
    } catch {
      if (!abort.signal.aborted) setError(t("meetings.folderStanding.failed"));
    } finally {
      if (!abort.signal.aborted) setRunning(false);
    }
  };

  const standing = data?.standing ?? null;
  const canWrite = data?.can_generate ?? false;
  return (
    <section
      data-testid="folder-standing"
      aria-label={t("meetings.folderStanding.title")}
      className="border-border bg-card mb-6 rounded-lg border px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="eyebrow">{t("meetings.folderStanding.title")}</h3>
        {data && (canWrite || standing) && (
          <Button
            variant="outline"
            size="xs"
            data-testid="folder-standing-write"
            disabled={running || !canWrite}
            onClick={() => void write()}
            title={t("meetings.folderStanding.hint")}
          >
            {running ? <RefreshCw className="animate-spin" /> : <Sparkles />}
            {t(
              running
                ? "meetings.folderStanding.running"
                : standing
                  ? "meetings.folderStanding.refresh"
                  : "meetings.folderStanding.write",
            )}
          </Button>
        )}
      </div>
      {standing ? (
        <>
          <ul
            data-testid="folder-standing-bullets"
            className="mt-2 list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed"
          >
            {standing.bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-2 text-[11px]">
            {t("meetings.folderStanding.generatedAt", {
              date: formatTimestamp(standing.generated_at, i18n.language),
            })}
            {standing.stale && (
              <span data-testid="folder-standing-stale">
                {" · "}
                {t("meetings.folderStanding.stale")}
              </span>
            )}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground mt-2 text-[12.5px]">
          {t(
            data && !canWrite
              ? "meetings.folderStanding.noContent"
              : "meetings.folderStanding.empty",
          )}
        </p>
      )}
      {error && (
        <p className="text-destructive mt-2 text-xs" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
