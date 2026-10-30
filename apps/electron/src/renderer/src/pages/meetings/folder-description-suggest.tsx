import {
  type FolderDescriptionSuggestErrorCode,
  folderDescriptionSuggestErrorSchema,
  folderDescriptionSuggestionSchema,
} from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import { getClient } from "@renderer/lib/api";
import { RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// The "Suggest" button of the folder description (issue #373). The server
// writes a suggestion from the stored summaries of the folder's meetings. The
// button only fills the text field: the user edits the text and saves it.

const ERROR_KEYS: Record<FolderDescriptionSuggestErrorCode, string> = {
  folder_not_found: "meetings.folders.notFound",
  no_summaries: "meetings.folderSuggest.noSummaries",
  no_llm: "meetings.folderSuggest.noModel",
  llm_failed: "meetings.folderSuggest.failed",
};

export function suggestErrorKey(body: unknown): string {
  const parsed = folderDescriptionSuggestErrorSchema.safeParse(body);
  return parsed.success
    ? ERROR_KEYS[parsed.data.code]
    : "meetings.folderSuggest.failed";
}

export function SuggestDescriptionButton({
  folderId,
  disabled,
  onRunning,
  onSuggestion,
}: {
  folderId: string;
  disabled: boolean;
  onRunning: (running: boolean) => void;
  onSuggestion: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  // Closing the editor stops the request, so the server stops the model.
  useEffect(() => () => controller.current?.abort(), []);

  const suggest = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    onRunning(true);
    setError(null);
    try {
      const res = await getClient().api.meetings.folders[":id"][
        "suggest-description"
      ].$post({ param: { id: folderId } }, { init: { signal: abort.signal } });
      const body: unknown = await res.json();
      if (abort.signal.aborted) return;
      if (res.ok) {
        onSuggestion(folderDescriptionSuggestionSchema.parse(body).description);
      } else setError(t(suggestErrorKey(body)));
    } catch {
      if (!abort.signal.aborted) setError(t("meetings.folderSuggest.failed"));
    } finally {
      if (!abort.signal.aborted) {
        setRunning(false);
        onRunning(false);
      }
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="xs"
        disabled={disabled || running}
        onClick={() => void suggest()}
        title={t("meetings.folderSuggest.hint")}
      >
        {running ? <RefreshCw className="animate-spin" /> : <Sparkles />}
        {t(
          running
            ? "meetings.folderSuggest.running"
            : "meetings.folderSuggest.suggest",
        )}
      </Button>
      {error && (
        <p className="text-destructive basis-full text-xs" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
