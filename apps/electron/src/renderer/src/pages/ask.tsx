import {
  type ChatScope,
  type MeetingListItem,
  SETTINGS_KEYS,
} from "@openstyle/validations";
import { PageHeader, PageShell } from "@renderer/components/page-chrome";
import { Button } from "@renderer/components/ui/button";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { settingsQueryOptions } from "@renderer/lib/query";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { fetchThread } from "./meetings/ask-api";
import { scopeOfThread } from "./meetings/ask-model";
import { AskPanel } from "./meetings/ask-panel";
import { useCiteActions, useMeetingsList } from "./meetings/ask-scope";
import { useMeetingFolders } from "./meetings/folders-data";

type ScopeKind = "all" | "folder" | "meeting";

interface Pick {
  kind: ScopeKind;
  folderId: string | null;
  meetingId: string | null;
}

/** The last pick outlives the page, like the selection of the Meetings page. */
let remembered: Pick = { kind: "all", folderId: null, meetingId: null };

function pickOfScope(scope: ChatScope): Pick {
  return {
    kind: scope.kind,
    folderId: scope.kind === "folder" ? scope.id : null,
    meetingId: scope.kind === "meeting" ? scope.id : null,
  };
}

function meetingName(m: MeetingListItem, untitled: string): string {
  return m.title?.trim() || untitled;
}

/**
 * The Ask page (specs/meeting-chat-agent.md 11.6, decision D19): ask about
 * everything, one folder or one meeting. It shows the threads of the picked
 * scope, newest first, and the same answer UI as the meeting tab. A thread
 * made in the bubble or in a tab shows in the list of its scope.
 */
export default function AskPage(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const linkedThread = params.get("thread");

  const { data: settings } = useQuery(settingsQueryOptions());
  const enabled = settings?.[SETTINGS_KEYS.meetingChatEnabled] === "true";
  const folderData = useMeetingFolders(enabled);
  const folders = useMemo(() => folderData.data ?? [], [folderData.data]);
  const { data: meetingList } = useMeetingsList(enabled);
  const meetings = useMemo(() => meetingList ?? [], [meetingList]);

  const [pick, setPick] = useState<Pick>(remembered);
  // The thread to open first, from "Open in Ask" of the bubble. The URL has
  // it once; the page keeps it in state, so a later pick does not reuse it.
  const [firstThread, setFirstThread] = useState<string | null>(null);
  const [resolved, setResolved] = useState(linkedThread === null);
  const choose = (next: Pick): void => {
    remembered = next;
    setPick(next);
    setFirstThread(null);
  };

  useEffect(() => {
    if (!linkedThread) return;
    let cancelled = false;
    void fetchThread(linkedThread)
      .then((detail) => {
        if (cancelled) return;
        const next = pickOfScope(scopeOfThread(detail.thread));
        remembered = next;
        setPick(next);
        setFirstThread(detail.thread.id);
      })
      .catch(() => {})
      .finally(() => {
        if (cancelled) return;
        setResolved(true);
        setParams({}, { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [linkedThread, setParams]);

  const actions = useCiteActions({ thisMeetingId: null });
  const untitled = t("meetings.ask.untitled");

  const scope: ChatScope | null =
    pick.kind === "all"
      ? { kind: "all" }
      : pick.kind === "folder"
        ? pick.folderId
          ? { kind: "folder", id: pick.folderId }
          : null
        : pick.meetingId
          ? { kind: "meeting", id: pick.meetingId }
          : null;
  const folderName = (id: string): string | null =>
    folders.find((f) => f.id === id)?.name ?? null;

  let scopeText = t("ask.scopeEverythingText");
  let strings = {
    title: t("meetings.ask.everything.title"),
    empty: t("meetings.ask.everything.empty"),
    placeholder: t("meetings.ask.everything.placeholder"),
    threads: t("meetings.ask.everything.threads"),
  };
  if (scope?.kind === "folder") {
    scopeText = t("meetings.ask.scopeFolder", {
      name: folderName(scope.id) ?? "",
    });
    strings = {
      title: t("meetings.ask.folder.title"),
      empty: t("meetings.ask.folder.empty"),
      placeholder: t("meetings.ask.folder.placeholder"),
      threads: t("meetings.ask.folder.threads"),
    };
  } else if (scope?.kind === "meeting") {
    scopeText = t("meetings.ask.scopeMeeting");
    strings = {
      title: t("meetings.ask.title"),
      empty: t("meetings.ask.empty"),
      placeholder: t("meetings.ask.placeholder"),
      threads: t("meetings.ask.threads"),
    };
  }

  return (
    <PageShell>
      <div data-testid="ask-page" className="flex min-w-0 flex-col gap-5">
        <PageHeader title={t("ask.title")} subtitle={t("ask.intro")} />
        {settings && !enabled ? (
          <div
            className="border-border bg-card flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-[13px]"
            data-testid="ask-page-off"
          >
            <span className="min-w-0 flex-1">{t("ask.off")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/settings#meetings")}
            >
              {t("meetings.ask.openSettings")}
            </Button>
          </div>
        ) : (
          <>
            <div
              className="flex min-w-0 flex-wrap items-center gap-3"
              data-testid="ask-scope-picker"
            >
              <span className="text-muted-foreground text-[12px]">
                {t("ask.scopeLabel")}
              </span>
              <SegmentedControl
                size="sm"
                value={pick.kind}
                onValueChange={(v) =>
                  choose({
                    kind: v as ScopeKind,
                    folderId: pick.folderId,
                    meetingId: pick.meetingId,
                  })
                }
                options={[
                  { value: "all", label: t("ask.scopeEverything") },
                  { value: "folder", label: t("ask.scopeFolder") },
                  { value: "meeting", label: t("ask.scopeMeeting") },
                ]}
              />
              {pick.kind === "folder" && (
                <Select
                  value={pick.folderId ?? ""}
                  onValueChange={(id) => choose({ ...pick, folderId: id })}
                >
                  <SelectTrigger
                    className="w-60 max-w-full"
                    aria-label={t("ask.pickFolder")}
                    data-testid="ask-pick-folder"
                  >
                    <SelectValue placeholder={t("ask.pickFolder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {folders.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {pick.kind === "meeting" && (
                <Select
                  value={pick.meetingId ?? ""}
                  onValueChange={(id) => choose({ ...pick, meetingId: id })}
                >
                  <SelectTrigger
                    className="w-72 max-w-full"
                    aria-label={t("ask.pickMeeting")}
                    data-testid="ask-pick-meeting"
                  >
                    <SelectValue placeholder={t("ask.pickMeeting")} />
                  </SelectTrigger>
                  <SelectContent>
                    {meetings.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {meetingName(m, untitled)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {resolved && scope ? (
              <AskPanel
                key={`${pick.kind}:${pick.folderId ?? ""}:${pick.meetingId ?? ""}:${firstThread ?? ""}`}
                scope={scope}
                scopeText={scopeText}
                strings={strings}
                actions={actions}
                threads="list"
                initialThreadId={firstThread}
                folderName={folderName}
              />
            ) : (
              resolved && (
                <p
                  className="text-muted-foreground m-0 text-[12.5px]"
                  data-testid="ask-pick-hint"
                >
                  {pick.kind === "folder"
                    ? t("ask.pickFolderHint")
                    : t("ask.pickMeetingHint")}
                </p>
              )
            )}
          </>
        )}
      </div>
    </PageShell>
  );
}
