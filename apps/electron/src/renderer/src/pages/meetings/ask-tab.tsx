import { useTranslation } from "react-i18next";
import { AskPanel } from "./ask-panel";
import { useCiteActions } from "./ask-scope";

/**
 * The Ask tab of one meeting (specs/meeting-chat-agent.md section 11, P1).
 * The scope is this meeting and never changes.
 */
export function AskTab({
  meetingId,
  onShowTranscript,
  onShowSummary,
}: {
  meetingId: string;
  /** Open the Transcript tab and mark the segment at `startMs`. */
  onShowTranscript: (startMs: number | null) => void;
  onShowSummary: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const actions = useCiteActions({
    thisMeetingId: meetingId,
    onShowTranscript,
    onShowSummary,
  });
  return (
    <AskPanel
      scope={{ kind: "meeting", id: meetingId }}
      scopeText={t("meetings.ask.scopeMeeting")}
      strings={{
        title: t("meetings.ask.title"),
        empty: t("meetings.ask.empty"),
        placeholder: t("meetings.ask.placeholder"),
        threads: t("meetings.ask.threads"),
      }}
      actions={actions}
      threads="select"
    />
  );
}

/**
 * The Ask tab of one folder (spec 11.6, scope F). The scope is this folder
 * and never changes. A cite chip opens its meeting at the cited time.
 */
export function FolderAskTab({
  folderId,
  folderName,
}: {
  folderId: string;
  folderName: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const actions = useCiteActions({ thisMeetingId: null });
  return (
    <AskPanel
      scope={{ kind: "folder", id: folderId }}
      scopeText={t("meetings.ask.scopeFolder", { name: folderName })}
      strings={{
        title: t("meetings.ask.folder.title"),
        empty: t("meetings.ask.folder.empty"),
        placeholder: t("meetings.ask.folder.placeholder"),
        threads: t("meetings.ask.folder.threads"),
      }}
      actions={actions}
      threads="select"
      folderName={(id) => (id === folderId ? folderName : null)}
    />
  );
}
