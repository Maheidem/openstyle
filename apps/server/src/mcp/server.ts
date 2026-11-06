// Builds one McpServer with all Openstyle tools. The /mcp route builds a new
// one for each HTTP request (stateless mode).
import { McpServer } from "@modelcontextprotocol/server";
import { createAppLogger } from "@openstyle/utils";
import type { ApiCaller } from "./call-api.js";
import { emitAgentChange } from "./emit.js";
import {
  CONFIRM_MESSAGE,
  type McpTool,
  type ToolAnswer,
  ToolError,
} from "./tools/define.js";
import { folderTools } from "./tools/folders.js";
import { historyTools } from "./tools/history.js";
import { meetingTools } from "./tools/meetings.js";
import { settingsTools } from "./tools/settings.js";
import { vocabularyTools } from "./tools/vocabulary.js";

const log = createAppLogger("mcp");

/** Every tool that /mcp serves. */
export const MCP_TOOLS: readonly McpTool[] = [
  ...meetingTools,
  ...folderTools,
  ...historyTools,
  ...vocabularyTools,
  ...settingsTools,
];

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function runTool(
  tool: McpTool,
  args: Record<string, unknown>,
  api: ApiCaller,
  agent: string,
) {
  const started = Date.now();
  let outcome = "ok";
  try {
    if (tool.kind === "delete" && args.confirm !== true) {
      outcome = "error";
      return textResult(CONFIRM_MESSAGE, true);
    }
    const answer: ToolAnswer = await tool.run(args as never, { api });
    if (answer.change) emitAgentChange(answer.change);
    return textResult(JSON.stringify(answer.data ?? null));
  } catch (err) {
    outcome = "error";
    if (err instanceof ToolError) return textResult(err.message, true);
    log.error(`tool ${tool.name} failed: ${String(err)}`);
    return textResult(`Internal error: ${String(err)}`, true);
  } finally {
    log.info(
      `tool=${tool.name} agent=${agent} result=${outcome} ms=${Date.now() - started}`,
    );
  }
}

export function buildMcpServer(options: {
  api: ApiCaller;
  agent: string;
  version: string;
}): McpServer {
  const server = new McpServer({
    name: "openstyle",
    version: options.version,
  });
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          readOnlyHint: tool.kind === "read",
          destructiveHint: tool.kind === "delete",
          idempotentHint: tool.idempotent,
          openWorldHint: false,
        },
      },
      (args) =>
        runTool(
          tool,
          args as Record<string, unknown>,
          options.api,
          options.agent,
        ),
    );
  }
  return server;
}
