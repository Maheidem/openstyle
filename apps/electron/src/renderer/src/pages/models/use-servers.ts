import { addServerSchema, SERVER_PROVIDER_ID } from "@openstyle/validations";
import { getClient } from "@renderer/lib/api";
import {
  configuredModelsQueryOptions,
  queryKeys,
  serversQueryOptions,
} from "@renderer/lib/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { type ServerView, voiceCannotTranscribe } from "./server-roles";

/** Why an add failed. `invalid` carries the form message in `message`. */
export type AddServerError =
  | "duplicate"
  | "unreachable"
  | "unauthorized"
  | "not_openai"
  | "invalid"
  | "failed";

export type AddServerResult =
  | { ok: true }
  | { ok: false; error: AddServerError; message?: string };

export interface UseServers {
  servers: ServerView[];
  /** True until the first probe answers. */
  loading: boolean;
  /** Probe every server again. */
  refetch: () => Promise<unknown>;
  /** Probe the address, then save it. Nothing is saved when the probe fails. */
  addServer: (url: string, apiKey: string) => Promise<AddServerResult>;
  /** Delete the server and its configured models. */
  removeServer: (id: string) => Promise<void>;
}

const EMPTY_SERVERS: ServerView[] = [];

const ADD_ERRORS = new Set<string>([
  "unreachable",
  "unauthorized",
  "not_openai",
]);

export function useServers(): UseServers {
  const queryClient = useQueryClient();
  const query = useQuery(serversQueryOptions());

  const addServer = useCallback(
    async (url: string, apiKey: string): Promise<AddServerResult> => {
      const key = apiKey.trim();
      const parsed = addServerSchema.safeParse({
        url,
        api_key: key || undefined,
      });
      if (!parsed.success) {
        return {
          ok: false,
          error: "invalid",
          message: parsed.error.issues[0]?.message,
        };
      }
      try {
        const res = await getClient().api.servers.$post({ json: parsed.data });
        if (res.status === 201) {
          const added = await res.json();
          queryClient.setQueryData<ServerView[]>(queryKeys.servers, (list) => [
            ...(list ?? []),
            added,
          ]);
          return { ok: true };
        }
        const body = (await res.json()) as { code?: string; error?: string };
        if (res.status === 409) return { ok: false, error: "duplicate" };
        if (body.error && ADD_ERRORS.has(body.error)) {
          return { ok: false, error: body.error as AddServerError };
        }
        return { ok: false, error: res.status === 400 ? "invalid" : "failed" };
      } catch {
        return { ok: false, error: "failed" };
      }
    },
    [queryClient],
  );

  const removeServer = useCallback(
    async (id: string) => {
      await getClient().api.servers[":id"].$delete({ param: { id } });
      queryClient.setQueryData<ServerView[]>(queryKeys.servers, (list) =>
        (list ?? []).filter((s) => s.id !== id),
      );
      // The server also deleted its configured models.
      await queryClient.invalidateQueries({ queryKey: queryKeys.models.all });
    },
    [queryClient],
  );

  return {
    servers: query.data ?? EMPTY_SERVERS,
    loading: query.isLoading,
    refetch: query.refetch,
    addServer,
    removeServer,
  };
}

/**
 * True when the default voice model is on an own server that lists it as a
 * model that cannot transcribe. Probes the servers only when the default voice
 * is a server model. Used by the one-time dashboard notice.
 */
export function useVoiceCannotTranscribe(): boolean {
  const { data: configured } = useQuery(configuredModelsQueryOptions());
  const voice = configured?.find(
    (m) => m.type === "voice" && m.is_default === 1,
  );
  const isServerVoice = voice?.provider === SERVER_PROVIDER_ID;
  const { data: servers } = useQuery({
    ...serversQueryOptions(),
    enabled: isServerVoice,
  });
  return isServerVoice && !!servers && voiceCannotTranscribe(voice, servers);
}
