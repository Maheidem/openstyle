// The shape of one MCP tool and the helpers that the tool groups share.
import { z } from "zod";
import { hasJob } from "../../lib/meetings/job-registry.js";
import { type ApiCaller, type ApiResult, apiErrorText } from "../call-api.js";
import type { AgentChange } from "../emit.js";

/** read: changes nothing. write: changes data. delete: removes data. */
export type ToolKind = "read" | "write" | "delete";

export interface ToolContext {
  api: ApiCaller;
  /** The agent name from the X-Openstyle-Agent header ("unknown" if none). */
  agent: string;
}

/** The answer of a tool: the data, and the change to tell the app about. */
export interface ToolAnswer {
  data: unknown;
  change?: AgentChange;
}

export interface McpTool {
  name: string;
  description: string;
  kind: ToolKind;
  /** True when a second call with the same args changes nothing more. */
  idempotent: boolean;
  input: z.ZodObject;
  run: (args: never, ctx: ToolContext) => Promise<ToolAnswer>;
}

/** A tool error. The agent sees the message, with isError set. */
export class ToolError extends Error {}

export const CONFIRM_MESSAGE =
  "Ask the user, then call again with confirm: true";

/** The `confirm` arg of every delete tool. */
export const confirmArg = z
  .boolean()
  .optional()
  .describe(
    "Set true only after the user agreed to this delete. Without it the tool does nothing.",
  );

export function defineTool<S extends z.ZodObject>(spec: {
  name: string;
  description: string;
  kind: ToolKind;
  idempotent: boolean;
  input: S;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolAnswer>;
}): McpTool {
  return spec as unknown as McpTool;
}

/** Return the data of a good answer. Throw a ToolError for a bad one. */
export function expectOk(result: ApiResult): unknown {
  if (result.ok) return result.data;
  const text = apiErrorText(result);
  if (result.status === 409) throw new ToolError(`Conflict (409): ${text}`);
  if (result.status === 404) throw new ToolError(`Not found (404): ${text}`);
  throw new ToolError(`Error (${result.status}): ${text}`);
}

/**
 * A write on a meeting while a job (transcribe, enhance, summarize, diarize)
 * runs on it gives a 409-style error. The job writes the same rows.
 */
export function assertNoJob(meetingId: string): void {
  if (hasJob(meetingId)) {
    throw new ToolError(
      "Conflict (409): A job runs on this meeting. Wait until it ends (list_jobs), or stop it with cancel_meeting_job.",
    );
  }
}

/** Encode one path segment. */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** Build a query string from the defined values. */
export function query(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
