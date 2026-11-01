/**
 * Data hooks of the Ask surfaces: the meeting list for the scope picker and
 * the "removed" check of cite chips, and the click actions of a cite chip.
 */
import type { MeetingListItem } from "@openstyle/validations";
import { getClient } from "@renderer/lib/api";
import { queryKeys } from "@renderer/lib/query";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import type { CiteActions } from "./ask-blocks";
import { type CiteTarget, citeTarget } from "./ask-model";

/** The same query as the Meetings page, so both share one cache entry. */
export function useMeetingsList(enabled = true) {
  return useQuery({
    queryKey: queryKeys.meetings.list,
    queryFn: async (): Promise<MeetingListItem[]> => {
      const res = await getClient().api.meetings.$get({ query: {} });
      if (!res.ok) throw new Error("meetings_load_failed");
      return (await res.json()).items;
    },
    enabled,
  });
}

/** The page of a meeting at a time: the Meetings page reads `meeting` and `at`. */
export function meetingLink(meetingId: string, startMs: number | null): string {
  const at = startMs === null ? "" : `&at=${Math.floor(startMs)}`;
  return `/meetings?meeting=${encodeURIComponent(meetingId)}${at}`;
}

/**
 * The click actions of the cite chips. `thisMeetingId` is the meeting of a
 * meeting tab: its own cites open its tabs through `onShowTranscript` and
 * `onShowSummary`. With null (a folder tab, the Ask page) every cite opens its
 * meeting at the cited time.
 */
export function useCiteActions(options: {
  thisMeetingId: string | null;
  onShowTranscript?: (startMs: number | null) => void;
  onShowSummary?: () => void;
}): CiteActions {
  const navigate = useNavigate();
  const { data: listed } = useMeetingsList();
  const knownIds = useMemo(
    () => (listed ? new Set(listed.map((m) => m.id)) : null),
    [listed],
  );
  const { thisMeetingId, onShowTranscript, onShowSummary } = options;
  return {
    resolve: (cite) => citeTarget(cite, thisMeetingId, knownIds),
    open: (target: CiteTarget) => {
      if (target.kind === "transcript") onShowTranscript?.(target.startMs);
      else if (target.kind === "summary") onShowSummary?.();
      else if (target.kind === "meeting") {
        navigate(meetingLink(target.meetingId, target.startMs));
      }
    },
  };
}
