import {
  type MeetingDetail,
  meetingTagListResponseSchema,
  meetingTagsResponseSchema,
} from "@openstyle/validations";
import { getClient } from "@renderer/lib/api";
import { queryKeys } from "@renderer/lib/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";

/** All tags with their meeting counts, for the suggestions. */
export function useAllTags() {
  return useQuery({
    queryKey: queryKeys.meetings.tags,
    queryFn: async () => {
      const res = await getClient().api.meetings.tags.$get();
      if (!res.ok) throw new Error("request_failed");
      return meetingTagListResponseSchema.parse(await res.json()).items;
    },
  });
}

/** Save the full tag list of a meeting and update the cached detail. */
export function useSaveMeetingTags(id: string) {
  const queryClient = useQueryClient();
  return async (tags: string[]): Promise<string[]> => {
    const res = await getClient().api.meetings[":id"].tags.$put({
      param: { id },
      json: { tags },
    });
    if (!res.ok) throw new Error("request_failed");
    const saved = meetingTagsResponseSchema.parse(await res.json()).tags;
    queryClient.setQueryData<MeetingDetail | null>(
      queryKeys.meetings.detail(id),
      (old) => (old ? { ...old, tags: saved } : old),
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.tags });
    return saved;
  };
}
