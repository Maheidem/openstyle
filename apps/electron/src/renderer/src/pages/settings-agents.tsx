// Settings > Agents (MCP) (specs/mcp.md 8.1, canvas board MCPSettings v17).
// The access switch (setting mcp_enabled, a missing row means on), the
// status, one row for each agent tool and the note "The app must be running".
import {
  AddedChip,
  AGENT_LABELS,
  AgentCommand,
  type AgentUiRow,
  reloadHintKey,
  useAgentRows,
} from "@renderer/components/agent-connect";
import { Button } from "@renderer/components/ui/button";
import { Switch } from "@renderer/components/ui/switch";
import { queryKeys, settingsQueryOptions } from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpStatus } from "../../../shared/agents";
import { SETTINGS_KEYS } from "../../../shared/settings-keys";

/** The settings row of `settings.tsx`. The page gives it, so the two files do not import each other. */
type RowComponent = (props: {
  label: string;
  desc: string;
  children: React.ReactNode;
  last?: boolean;
}) => React.JSX.Element;

function StatusChip({ ready }: { ready: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <span
      data-testid="settings-agents-status-chip"
      className={cn(
        "mono rounded-[6px] px-2 py-0.5 text-[10px] tracking-[0.08em] whitespace-nowrap uppercase",
        ready
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
          : "bg-muted text-muted-foreground",
      )}
    >
      {ready ? t("settings.agents.ready") : t("settings.agents.off")}
    </span>
  );
}

function rowHint(
  row: AgentUiRow,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  switch (row.state) {
    case "not-found":
      return t("settings.agents.notFound");
    case "adding":
    case "removing":
      return t("agents.working");
    case "added":
      return t(reloadHintKey(row.tool));
    case "failed":
      return t("agents.failed");
    default:
      return t("settings.agents.notAdded");
  }
}

function AgentToolRow({
  Row,
  row,
  disabled,
  last,
  onAdd,
  onRemove,
  onRescan,
}: {
  Row: RowComponent;
  row: AgentUiRow;
  disabled: boolean;
  last: boolean;
  onAdd: () => void;
  onRemove: () => void;
  onRescan: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const label = AGENT_LABELS[row.tool];
  const busy = row.state === "adding" || row.state === "removing";
  const testId = `settings-agent-${row.tool}`;
  const showCommand = row.state === "not-found" || row.state === "failed";
  return (
    <Row label={label} desc={rowHint(row, t)} last={last}>
      <div
        className="flex min-w-0 flex-col"
        data-testid={testId}
        data-state={row.state}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {row.state === "added" && <AddedChip />}
          {row.state === "not-found" ? (
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled={disabled}
              onClick={onRescan}
              data-testid={`${testId}-rescan`}
            >
              {t("agents.checkAgain")}
            </Button>
          ) : row.state === "added" ? (
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled={disabled}
              onClick={onRemove}
              data-testid={`${testId}-remove`}
            >
              {t("agents.remove")}
            </Button>
          ) : (
            <Button
              variant={row.state === "not-added" ? "default" : "outline"}
              size="sm"
              className="rounded-full"
              disabled={disabled || busy}
              onClick={onAdd}
              data-testid={`${testId}-add`}
            >
              {busy
                ? t("agents.working")
                : row.state === "failed"
                  ? t("agents.tryAgain")
                  : t("agents.addTo", { tool: label })}
            </Button>
          )}
        </div>
        {showCommand && (
          <AgentCommand
            command={row.fallbackCommand}
            disabled={disabled}
            testId={`${testId}-command`}
          />
        )}
      </div>
    </Row>
  );
}

export function AgentsSettingsPanel({
  Row,
}: {
  Row: RowComponent;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(settingsQueryOptions());
  const [status, setStatus] = useState<McpStatus | null>(null);
  const { rows, add, remove, rescan } = useAgentRows();

  useEffect(() => {
    void window.api
      ?.getMcpStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  // A missing row means on. Only "false" turns agent access off.
  const enabled = settings?.[SETTINGS_KEYS.mcpEnabled] !== "false";
  const ready = enabled && status?.port != null;

  const setEnabled = (on: boolean): void => {
    void putSetting(SETTINGS_KEYS.mcpEnabled, String(on)).then(() =>
      queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
    );
  };

  return (
    <div className="flex flex-col" data-testid="settings-agents">
      <p className="text-muted-foreground -mt-3 mb-2 text-[13px] leading-[1.5]">
        {t("settings.agents.intro")}
      </p>
      <Row
        label={t("settings.agents.access")}
        desc={t("settings.agents.accessDesc")}
      >
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("settings.agents.access")}
          data-testid="settings-agents-access"
        />
      </Row>
      <Row
        label={t("settings.agents.status")}
        desc={
          !enabled
            ? t("settings.agents.statusOff")
            : status?.port != null
              ? t("settings.agents.statusReady", { port: String(status.port) })
              : t("settings.agents.statusNoServer")
        }
      >
        <StatusChip ready={ready} />
      </Row>
      <div
        className={cn("flex flex-col", !enabled && "opacity-45")}
        data-testid="settings-agents-rows"
      >
        {(rows ?? []).map((row, index, list) => (
          <AgentToolRow
            key={row.tool}
            Row={Row}
            row={row}
            disabled={!enabled}
            last={index === list.length - 1}
            onAdd={() => add(row.tool)}
            onRemove={() => remove(row.tool)}
            onRescan={rescan}
          />
        ))}
      </div>
      <p
        className="text-muted-foreground mt-3 text-[12.5px] leading-[1.5]"
        data-testid="settings-agents-note"
      >
        {t("settings.agents.note")}
      </p>
    </div>
  );
}
