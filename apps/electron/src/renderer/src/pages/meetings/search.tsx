import {
  type SearchMeetingsResponse,
  type SearchOffReason,
  type SearchStatus,
  searchMeetingsResponseSchema,
  searchStatusSchema,
} from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { getClient } from "@renderer/lib/api";
import { formatClockMs, formatTimestamp } from "@renderer/lib/format";
import { queryKeys } from "@renderer/lib/query";
import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

// Meeting search (specs/local-semantic-search.md 7.4, 9.1, D21): a box in the
// Meetings page header, scoped by the folder selected in the tree; with no
// folder selected it searches all meetings.

/** The i18n key of the text for a search-off reason (spec 9.1). */
export function searchOffKey(reason: SearchOffReason): string {
  if (reason === "no_model") return "meetings.search.offNoModel";
  if (reason === "unsupported_platform")
    return "meetings.search.offUnsupported";
  return "meetings.search.offReinstall";
}

export function useSearchStatus(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.meetings.searchStatus,
    queryFn: async (): Promise<SearchStatus> => {
      const res = await getClient().api.search.status.$get();
      if (!res.ok) throw new Error("search_status_failed");
      return searchStatusSchema.parse(await res.json());
    },
    enabled,
    // Poll while the index builds, so the progress line stays current.
    refetchInterval: (query) => {
      const s = query.state.data;
      return s?.state === "on" &&
        (s.meetings.queued > 0 || s.meetings.indexed < s.meetings.eligible)
        ? 3000
        : false;
    },
  });
}

export function MeetingSearchBar({
  status,
  scopeName,
  onSearch,
}: {
  status: SearchStatus | undefined;
  /** The selected folder name, or null for all meetings. */
  scopeName: string | null;
  onSearch: (query: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const off = status?.state === "off" ? status.reason : null;
  const building =
    status?.state === "on" &&
    status.meetings.indexed < status.meetings.eligible;
  return (
    <div className="mb-4">
      <form
        className="relative max-w-xl"
        onSubmit={(e) => {
          e.preventDefault();
          const q = text.trim();
          if (q) onSearch(q);
        }}
      >
        <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
        <Input
          type="search"
          value={text}
          maxLength={1000}
          disabled={!status || off !== null}
          aria-label={t("meetings.search.label")}
          placeholder={
            scopeName
              ? t("meetings.search.placeholderFolder", { name: scopeName })
              : t("meetings.search.placeholderAll")
          }
          className="pl-8"
          onChange={(e) => setText(e.target.value)}
        />
      </form>
      {off && (
        <p className="text-muted-foreground mt-1.5 text-xs" role="status">
          {t(searchOffKey(off))}{" "}
          {off === "no_model" && (
            <Button
              variant="link"
              size="xs"
              className="h-auto p-0 text-xs"
              onClick={() => navigate("/settings/models")}
            >
              {t("meetings.search.openModels")}
            </Button>
          )}
        </p>
      )}
      {building && status && (
        <p className="text-muted-foreground mt-1.5 text-xs" role="status">
          {t("meetings.search.indexing", {
            indexed: status.meetings.indexed,
            total: status.meetings.eligible,
          })}
        </p>
      )}
    </div>
  );
}

export function MeetingSearchResults({
  query,
  folderId,
  scopeName,
  onOpen,
  onClose,
}: {
  query: string;
  folderId: string | null;
  scopeName: string | null;
  onOpen: (meetingId: string) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const result = useQuery({
    queryKey: queryKeys.meetings.search(query, folderId),
    queryFn: async (): Promise<SearchMeetingsResponse> => {
      const res = await getClient().api.search.meetings.$post({
        json: { query, ...(folderId ? { folder_id: folderId } : {}) },
      });
      if (!res.ok) throw new Error("search_failed");
      return searchMeetingsResponseSchema.parse(await res.json());
    },
    retry: false,
    staleTime: 0,
  });
  const data = result.data;
  return (
    <section aria-label={t("meetings.search.resultsLabel")}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-sm font-medium">
          {scopeName
            ? t("meetings.search.resultsFolder", { query, name: scopeName })
            : t("meetings.search.resultsAll", { query })}
        </h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("meetings.search.close")}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      {result.isPending ? (
        <p className="text-muted-foreground py-5 text-xs">
          {t("meetings.search.searching")}
        </p>
      ) : result.isError ? (
        <p className="text-destructive py-5 text-xs" role="alert">
          {t("meetings.search.failed")}
        </p>
      ) : data?.status === "off" ? (
        <p className="text-muted-foreground py-5 text-xs" role="status">
          {t(searchOffKey(data.reason))}
        </p>
      ) : data && data.hits.length > 0 ? (
        <ol className="border-border bg-card overflow-hidden rounded-lg border">
          {data.hits.map((hit) => (
            <li
              key={hit.chunk_id}
              className="border-border border-b last:border-b-0"
            >
              <button
                type="button"
                className="hover:bg-muted/60 block w-full px-3.5 py-2.5 text-left"
                onClick={() => onOpen(hit.meeting_id)}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[13px] font-medium">
                    {hit.meeting_title || t("meetings.untitled")}
                  </span>
                  <span className="text-muted-foreground mono shrink-0 text-[11px]">
                    {formatTimestamp(hit.started_at, i18n.language)}
                    {hit.start_ms !== null &&
                      ` · ${formatClockMs(hit.start_ms)}`}
                  </span>
                </span>
                <span className="text-muted-foreground mt-1 line-clamp-2 block text-xs">
                  {hit.snippet}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-center text-[12.5px]">
          {t("meetings.search.noResults")}
        </p>
      )}
    </section>
  );
}
