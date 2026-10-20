import type {
  LlmCallsResponse,
  LlmRunListResponse,
  ResumeConflictReason,
} from "@openstyle/validations";
import { QueryClient, queryOptions } from "@tanstack/react-query";
import { getClient } from "./api";
import {
  type AvailableModel,
  type ConfiguredModel,
  hasActiveDownload,
  type MlxAsrStatus,
  type WhisperStatus,
} from "./models";
import { IS_MAC } from "./platform";

/** Common staleTime for cached queries (1 hour). */
export const ONE_HOUR = 60 * 60 * 1000;

/**
 * Single source of truth for every React Query key in the renderer.
 *
 * Query keys must match exactly across producers (`useQuery`) and consumers
 * (`invalidateQueries`/`setQueryData`) — a stray inline literal silently splits
 * or misses the cache. Keeping them here prevents that drift. Conventions:
 *   - `foo` — a static key tuple.
 *   - `foo.all` — the family base; `invalidateQueries({ queryKey: foo.all })`
 *     cascades to every key that starts with it (React Query prefix match).
 *   - `foo.list(...)` — a parameterized key derived from a base.
 * Always `as const` so tuples stay literally typed for `getQueryData<T>()`.
 */
export const queryKeys = {
  /** Full persisted settings map (`GET /api/settings`). */
  settings: ["settings-all"] as const,

  models: {
    /** Family base — invalidates available + configured together. */
    all: ["models"] as const,
    available: ["models", "available"] as const,
    configured: ["models", "configured"] as const,
  },
  apiKeys: ["api-keys"] as const,
  /** Own servers with their live probe (`GET /api/servers`). */
  servers: ["servers"] as const,
  whisperStatus: ["whisper-status"] as const,
  mlxStatus: ["mlx-status"] as const,

  /** Experimental feature flags (`GET /api/config`). */
  config: ["config"] as const,
  /** Settings → Data: aggregate meetings/models disk usage (main-side IPC). */
  diskUsage: ["disk-usage"] as const,
  /** Device-local dismissed-notification keys. */
  dismissedNotifications: ["dismissed-notifications"] as const,

  meetings: {
    /** Family base — invalidates the list and every detail/transcript. */
    all: ["meetings"] as const,
    list: ["meetings", "list"] as const,
    folders: ["meetings", "folders"] as const,
    /** `GET /meetings/tags`: all tags with counts (issue #231). */
    tags: ["meetings", "tags"] as const,
    folder: (id: string | null) => ["meetings", "list", id] as const,
    detail: (id: string) => ["meetings", "detail", id] as const,
    transcript: (id: string) => ["meetings", "transcript", id] as const,
    /** specs/meeting-speaker-naming.md §7.3: the Speakers dialog's
     * GET /:id/speakers query — lives at MeetingDetailView level, not
     * inside the dialog, since §7.4's re-diarize confirmation needs its
     * data whether or not the dialog is currently open. */
    speakers: (id: string) => ["meetings", "speakers", id] as const,
    /** specs/meeting-enhance-agentic.md 8.5: `GET /:id/llm-runs?latest=1`, the
     * newest run of each kind. It feeds the run notices (8.9). */
    llmRunsLatest: (id: string) =>
      ["meetings", "llm-runs", id, "latest"] as const,
    /** 8.5: the Runs view (`runId` omitted, limit 10) or one run with all its
     * steps. Enabled only in advanced mode, while the panel shows that view. */
    llmRuns: (id: string, runId?: string) =>
      ["meetings", "llm-runs", id, runId ?? "all"] as const,
    /** 8.5: one `llm-calls` query; `selector` is its sorted query string. */
    llmCalls: (id: string, selector: string) =>
      ["meetings", "llm-calls", id, selector] as const,
    /** Prefix of every LLM run query of one meeting (8.5 invalidation). */
    llmRunsOf: (id: string) => ["meetings", "llm-runs", id] as const,
    /** Prefix of every LLM call query of one meeting (8.5 invalidation). */
    llmCallsOf: (id: string) => ["meetings", "llm-calls", id] as const,
  },

  history: {
    all: ["history"] as const,
    daily: ["history", "daily"] as const,
    list: (page: number, search: string, startDate: string, endDate: string) =>
      ["history", page, search, startDate, endDate] as const,
    stats: (startDate: string, endDate: string) =>
      ["history", "stats", startDate, endDate] as const,
  },

  dictionary: {
    all: ["dictionary"] as const,
    list: (page: number, search: string) =>
      ["dictionary", page, search] as const,
  },
  vocabulary: {
    all: ["vocabulary"] as const,
    list: (page: number, search: string) =>
      ["vocabulary", page, search] as const,
  },
} as const;

/**
 * Query options for the full persisted-settings map. Use with `useQuery`:
 *
 *   const { data } = useQuery(settingsQueryOptions());
 *   const { data } = useQuery({ ...settingsQueryOptions(), enabled });
 *
 * Keeps the key + fetch shape in one place across the pages that read settings
 * (settings, tone, models, onboarding, tutorial demo).
 */
export function settingsQueryOptions() {
  return {
    queryKey: queryKeys.settings,
    queryFn: async (): Promise<Record<string, string>> => {
      const res = await getClient().api.settings.$get();
      if (!res.ok) throw new Error("Failed to load settings");
      return await res.json();
    },
  };
}

/**
 * Query options for the available-models catalog. Use with `useQuery`, or read
 * the shared cache from a handler via
 * `queryClient.ensureQueryData(availableModelsQueryOptions())`.
 */
export function availableModelsQueryOptions() {
  return {
    queryKey: queryKeys.models.available,
    queryFn: async (): Promise<AvailableModel[]> => {
      const res = await getClient().api.models.available.$get();
      if (!res.ok) throw new Error("Failed to load available models");
      return await res.json();
    },
  };
}

/** Query options for the configured models (the saved default per type). */
export function configuredModelsQueryOptions() {
  return {
    queryKey: queryKeys.models.configured,
    queryFn: async (): Promise<ConfiguredModel[]> => {
      const res = await getClient().api.models.configured.$get();
      if (!res.ok) throw new Error("Failed to load configured models");
      return (await res.json()) as ConfiguredModel[];
    },
  };
}

/**
 * Query options for the newest LLM run of each kind of one meeting
 * (`GET /api/meetings/:id/llm-runs?latest=1`, specs/meeting-enhance-agentic.md
 * 8.5). `staleTime` 0: the job-end effect and every action invalidate it, and
 * the notices must never show a run that a newer one replaced.
 */
export function llmRunsLatestQueryOptions(id: string, enabled: boolean) {
  return queryOptions({
    queryKey: queryKeys.meetings.llmRunsLatest(id),
    enabled,
    staleTime: 0,
    queryFn: async (): Promise<LlmRunListResponse> => {
      const res = await getClient().api.meetings[":id"]["llm-runs"].$get({
        param: { id },
        query: { latest: "1" },
      });
      if (!res.ok) throw new Error("Failed to load the LLM runs");
      return await res.json();
    },
  });
}

/** While the inspector panel is open and a job runs, its queries refetch every 2 s (8.5). */
const INSPECTOR_POLL_MS = 2000;

/**
 * Query options for the Runs view (`GET /api/meetings/:id/llm-runs`, limit 10),
 * or for one run with all its steps when `runId` is set (8.5). Call it only
 * from the inspector panel, which mounts in advanced mode only.
 */
export function llmRunsQueryOptions(
  id: string,
  runId: string | undefined,
  polling: boolean,
) {
  return queryOptions({
    queryKey: queryKeys.meetings.llmRuns(id, runId),
    staleTime: 0,
    refetchInterval: polling ? INSPECTOR_POLL_MS : false,
    queryFn: async (): Promise<LlmRunListResponse> => {
      const res = await getClient().api.meetings[":id"]["llm-runs"].$get({
        param: { id },
        query: runId ? { run_id: runId } : { limit: "10" },
      });
      if (!res.ok) throw new Error("Failed to load the LLM runs");
      return await res.json();
    },
  });
}

/** The query string of one `llm-calls` request (8.3): one selector and its options. */
export interface LlmCallsSelector {
  call_id?: string;
  run_id?: string;
  step_key?: string;
  target_type?: "segment" | "speaker" | "summary";
  target_id?: string;
  detail?: "summary" | "full";
}

/** A stable text for a selector, used inside the query key. */
export function llmCallsSelectorKey(selector: LlmCallsSelector): string {
  return Object.entries(selector)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * Query options for one `GET /api/meetings/:id/llm-calls` request (8.5). The
 * renderer asks for one `full` call at a time. Call it only from the inspector
 * panel, which mounts in advanced mode only.
 */
export function llmCallsQueryOptions(
  id: string,
  selector: LlmCallsSelector,
  polling: boolean,
) {
  return queryOptions({
    queryKey: queryKeys.meetings.llmCalls(id, llmCallsSelectorKey(selector)),
    staleTime: 0,
    refetchInterval: polling ? INSPECTOR_POLL_MS : false,
    queryFn: async (): Promise<LlmCallsResponse> => {
      const res = await getClient().api.meetings[":id"]["llm-calls"].$get({
        param: { id },
        query: selector,
      });
      if (!res.ok) throw new Error("Failed to load the LLM calls");
      return await res.json();
    },
  });
}

/**
 * The result of a resume request: a started run, or the refusal. `error` is the
 * one English line and `reason` the guard of a 409 (`ResumeConflict`); both are
 * null for any other fault.
 */
export type ResumeRunResult =
  | { ok: true }
  | { ok: false; error: string | null; reason: ResumeConflictReason | null };

/**
 * Resume an interrupted run (`POST /api/meetings/:id/runs/:runId/resume`,
 * specs/meeting-enhance-agentic.md 8.5, 3.4.2). It then refetches the latest
 * runs and the meeting detail, so the one-second poll starts for a resumed run
 * and the notice follows a run that a guard failed. A 409 gives the `error`
 * line of the `ResumeConflict`; any other fault gives `null`.
 */
export async function resumeRun(
  queryClient: QueryClient,
  id: string,
  runId: string,
): Promise<ResumeRunResult> {
  let result: ResumeRunResult;
  try {
    const res = await getClient().api.meetings[":id"].runs[
      ":runId"
    ].resume.$post({ param: { id, runId } });
    if (res.ok) {
      result = { ok: true };
    } else {
      const body = (await res.json().catch(() => null)) as Partial<
        Record<"error" | "reason", unknown>
      > | null;
      result = {
        ok: false,
        error: typeof body?.error === "string" ? body.error : null,
        reason:
          typeof body?.reason === "string"
            ? (body.reason as ResumeConflictReason)
            : null,
      };
    }
  } catch {
    result = { ok: false, error: null, reason: null };
  }
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.meetings.llmRunsLatest(id),
    }),
    queryClient.invalidateQueries({ queryKey: queryKeys.meetings.detail(id) }),
  ]);
  return result;
}

/**
 * Query options for the own servers. The route probes every server live (up to
 * 3 s each), so the result stays fresh for 30 s and `refetch` is the Retry.
 */
export function serversQueryOptions() {
  return {
    queryKey: queryKeys.servers,
    queryFn: async () => {
      const res = await getClient().api.servers.$get();
      if (!res.ok) throw new Error("Failed to load servers");
      return await res.json();
    },
    staleTime: 30_000,
  };
}

/**
 * Query options for the Whisper status. The status is volatile during
 * downloads, so it is always stale. It polls every 500 ms while a download or
 * verify is active, then stops.
 */
export function whisperStatusQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.whisperStatus,
    queryFn: async (): Promise<WhisperStatus> => {
      const res = await getClient().api.whisper.status.$get();
      if (!res.ok) throw new Error("Failed to load whisper status");
      return await res.json();
    },
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && (d.binaryDownloading || hasActiveDownload(d.models))
        ? 500
        : false;
    },
    staleTime: 0,
  });
}

/** Same rules as the Whisper status. Only runs on macOS. */
export function mlxStatusQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.mlxStatus,
    enabled: IS_MAC,
    queryFn: async (): Promise<MlxAsrStatus> => {
      const res = await getClient().api["mlx-asr"].status.$get();
      if (!res.ok) throw new Error("Failed to load MLX ASR status");
      return await res.json();
    },
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && hasActiveDownload(d.models) ? 500 : false;
    },
    staleTime: 0,
  });
}

export type OpenstyleConfig = {
  version: number;
  flags: Record<string, boolean>;
};

/**
 * Query options for `config.freestyle.json` (experimental feature flags). Keeps
 * the flags load on the same React Query cache as the rest of the settings page
 * instead of re-fetching on every visit. Invalidate `queryKeys.config` after a
 * flag mutation to refresh.
 */
export function configQueryOptions() {
  return {
    queryKey: queryKeys.config,
    queryFn: async (): Promise<OpenstyleConfig> => {
      const res = await getClient().api.config.$get();
      if (!res.ok) throw new Error("Failed to load config");
      return await res.json();
    },
  };
}

/**
 * Query options for the device-local dismissed-notification key list. Use with
 * `useQuery`:
 *
 *   const { data } = useQuery(dismissedNotificationsQueryOptions());
 */
export function dismissedNotificationsQueryOptions() {
  return {
    queryKey: queryKeys.dismissedNotifications,
    queryFn: async (): Promise<string[]> => {
      const res = await getClient().api["dismissed-notifications"].$get();
      if (!res.ok) throw new Error("Failed to load dismissed notifications");
      return await res.json();
    },
  };
}

/**
 * Shared QueryClient factory for the renderer. Defaults suit a desktop SPA:
 * - `refetchOnWindowFocus: false` — the user switches apps constantly; focus
 *   refetches would be noisy. Freshness is driven by explicit invalidation
 *   (mutations + IPC events) instead.
 * - `staleTime: ONE_HOUR` — avoid redundant refetches on remount/navigation.
 *   Queries that need fresher data override this locally.
 * - `retry: 1` — one retry for transient loopback hiccups, no aggressive loop.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: ONE_HOUR,
        retry: 1,
      },
    },
  });
}
