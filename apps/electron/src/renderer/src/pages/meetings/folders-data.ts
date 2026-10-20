import {
  type MeetingDetail,
  type MeetingListItem,
  meetingFolderErrorSchema,
  meetingFolderSchema,
} from "@openstyle/validations";
import { getClient } from "@renderer/lib/api";
import { queryKeys } from "@renderer/lib/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderRequestError } from "./folders-model";

async function checked(res: {
  ok: boolean;
  json: () => Promise<unknown>;
}): Promise<unknown> {
  const body = await res.json();
  if (!res.ok) {
    const parsed = meetingFolderErrorSchema.safeParse(body);
    if (parsed.success) {
      throw new FolderRequestError(
        parsed.data.code,
        parsed.data.code === "folder_not_empty" ? parsed.data.meeting_count : 0,
      );
    }
    throw new FolderRequestError("request_failed");
  }
  return body;
}

export function folderMeetingsOptions(folderId: string | null) {
  return {
    queryKey: queryKeys.meetings.folder(folderId),
    queryFn: async (): Promise<MeetingListItem[]> => {
      const res = await getClient().api.meetings.$get({
        query: { folder_id: folderId ?? "none" },
      });
      if (!res.ok) throw new FolderRequestError("request_failed");
      return (await res.json()).items;
    },
    refetchInterval: (query: {
      state: { data: MeetingListItem[] | undefined };
    }) =>
      query.state.data?.some(
        (m) => m.status === "recording" || m.status === "transcribing",
      )
        ? 2000
        : (false as const),
  };
}

export function useMeetingFolders(enabled: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.meetings.folders,
    queryFn: async () => {
      const res = await getClient().api.meetings.folders.$get();
      if (!res.ok) throw new FolderRequestError("request_failed");
      return (await res.json()).items;
    },
    enabled,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.meetings.all });
  return {
    ...query,
    create: async (name: string) => {
      const res = await getClient().api.meetings.folders.$post({
        json: { name },
      });
      const folder = await checked(res);
      if (!res.ok) throw new FolderRequestError("request_failed");
      await refresh();
      return meetingFolderSchema.parse(folder);
    },
    update: async (
      id: string,
      values: { name?: string; description?: string | null },
    ) => {
      await checked(
        await getClient().api.meetings.folders[":id"].$patch({
          param: { id },
          json: values,
        }),
      );
      await refresh();
    },
    remove: async (id: string) => {
      try {
        await checked(
          await getClient().api.meetings.folders[":id"].$delete({
            param: { id },
          }),
        );
      } finally {
        await refresh();
      }
    },
    move: async (
      meeting: Pick<MeetingListItem, "id" | "folder_id">,
      folderId: string | null,
    ) => {
      if (meeting.folder_id === folderId) return;
      await checked(
        await getClient().api.meetings.move.$post({
          json: { meeting_ids: [meeting.id], folder_id: folderId },
        }),
      );
      queryClient.setQueryData<MeetingDetail | null>(
        queryKeys.meetings.detail(meeting.id),
        (old) => (old ? { ...old, folder_id: folderId } : old),
      );
      await refresh();
    },
  };
}
