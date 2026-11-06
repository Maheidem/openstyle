// The one-click agent install rows (specs/mcp.md 7.2, 8.1, 8.2). Settings >
// Agents (MCP) and the onboarding Ready card share the state hook, the chip
// and the command line with Copy.
import { Button } from "@renderer/components/ui/button";
import { useCopyToClipboard } from "@renderer/hooks/use-copy-to-clipboard";
import { cn } from "@renderer/lib/utils";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentRow, AgentTool } from "../../../shared/agents";

/** The state of one row in the UI. Main reports all but "adding" and "removing". */
export type AgentUiState = AgentRow["state"] | "adding" | "removing";

export interface AgentUiRow extends Omit<AgentRow, "state"> {
  state: AgentUiState;
}

/** The product names. They are names, so they stay the same in every language. */
export const AGENT_LABELS: Record<AgentTool, string> = {
  claude: "Claude Code",
  pi: "pi",
  codex: "Codex",
};

/**
 * The rows of the agent tools. The first load reads the shell PATH in main,
 * so it runs only when a screen with the rows opens.
 */
export function useAgentRows(): {
  rows: AgentUiRow[] | null;
  add: (tool: AgentTool) => void;
  remove: (tool: AgentTool) => void;
  rescan: () => void;
} {
  const [rows, setRows] = useState<AgentUiRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    void window.api
      ?.listAgents()
      .then((list) => {
        if (alive) setRows(list);
      })
      .catch(() => {
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const patch = useCallback((tool: AgentTool, next: Partial<AgentUiRow>) => {
    setRows(
      (current) =>
        current?.map((row) =>
          row.tool === tool ? { ...row, ...next } : row,
        ) ?? null,
    );
  }, []);

  const run = useCallback(
    (tool: AgentTool, busy: AgentUiState, call: () => Promise<AgentRow>) => {
      patch(tool, { state: busy });
      void call()
        .then((row) => patch(tool, row))
        .catch(() =>
          patch(tool, { state: busy === "adding" ? "failed" : "added" }),
        );
    },
    [patch],
  );

  const add = useCallback(
    (tool: AgentTool) => run(tool, "adding", () => window.api.addAgent(tool)),
    [run],
  );
  const remove = useCallback(
    (tool: AgentTool) =>
      run(tool, "removing", () => window.api.removeAgent(tool)),
    [run],
  );
  const rescan = useCallback(() => {
    void window.api
      ?.rescanAgents()
      .then(setRows)
      .catch(() => {});
  }, []);

  return { rows, add, remove, rescan };
}

/** The green "Added" chip. */
export function AddedChip(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <span
      data-testid="agent-added-chip"
      className="mono shrink-0 rounded-[6px] bg-emerald-500/15 px-2 py-0.5 text-[10px] tracking-[0.08em] whitespace-nowrap text-emerald-700 uppercase dark:text-emerald-300"
    >
      {t("agents.added")}
    </span>
  );
}

/** The Terminal command of specs/mcp.md 7.3, with a Copy button. */
export function AgentCommand({
  command,
  disabled,
  testId,
}: {
  command: string;
  disabled?: boolean;
  testId: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { copied, copy } = useCopyToClipboard();
  return (
    <div
      className="border-border bg-muted/40 mt-2 flex min-w-0 items-center gap-2.5 rounded-[10px] border py-1.5 pr-1.5 pl-3"
      data-testid={testId}
    >
      <code
        className="text-foreground min-w-0 flex-1 truncate font-mono text-[11px]"
        title={command}
      >
        {command}
      </code>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        className={cn(
          "rounded-full",
          copied &&
            "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        )}
        onClick={() => void copy(command).catch(() => {})}
        data-testid={`${testId}-copy`}
      >
        {copied ? t("agents.copied") : t("agents.copy")}
      </Button>
    </div>
  );
}

/** The reload hint of a tool after an add (specs/mcp.md 7.2). */
export function reloadHintKey(tool: AgentTool): string {
  return `agents.reload.${tool}`;
}
