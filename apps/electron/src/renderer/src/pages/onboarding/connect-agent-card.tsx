// The "Connect your agent" card of the Ready step (specs/mcp.md 8.2, canvas
// boards OB8Ready and OBPrototype v17). It shows one row for each agent tool
// that is found on this Mac. With no tool found, the card does not show. It
// has no Remove, and it never blocks "Open Openstyle".
import {
  AddedChip,
  AGENT_LABELS,
  AgentCommand,
  type AgentUiRow,
  reloadHintKey,
  useAgentRows,
} from "@renderer/components/agent-connect";
import { Button } from "@renderer/components/ui/button";
import { IS_MAC } from "@renderer/lib/platform";
import { Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";

function hint(
  row: AgentUiRow,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  if (row.state === "added") return t(reloadHintKey(row.tool));
  if (row.state === "adding") return t("onboarding.ready.agents.adding");
  if (row.state === "failed") return t("agents.failed");
  return t("onboarding.ready.agents.lets", { tool: AGENT_LABELS[row.tool] });
}

function CardRow({
  row,
  onAdd,
}: {
  row: AgentUiRow;
  onAdd: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const label = AGENT_LABELS[row.tool];
  const testId = `onboarding-agent-${row.tool}`;
  return (
    <div
      className="border-border mt-2 border-t pt-2"
      data-testid={testId}
      data-state={row.state}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="text-foreground w-[92px] shrink-0 text-[13px] font-semibold">
          {label}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 text-[12px] leading-[1.4]">
          {hint(row, t)}
        </span>
        {row.state === "added" ? (
          <AddedChip />
        ) : (
          <Button
            size="sm"
            variant={row.state === "failed" ? "outline" : "default"}
            className="shrink-0 rounded-full"
            disabled={row.state === "adding"}
            onClick={onAdd}
            data-testid={`${testId}-add`}
          >
            {row.state === "adding"
              ? t("onboarding.ready.agents.adding")
              : row.state === "failed"
                ? t("agents.tryAgain")
                : t("agents.addTo", { tool: label })}
          </Button>
        )}
      </div>
      {row.state === "failed" && (
        <AgentCommand
          command={row.fallbackCommand}
          testId={`${testId}-command`}
        />
      )}
    </div>
  );
}

function AgentCard(): React.JSX.Element | null {
  const { t } = useTranslation();
  const { rows, add } = useAgentRows();
  const found = (rows ?? []).filter((row) => row.found);
  if (found.length === 0) return null;
  return (
    <div
      className="border-border bg-card mt-5 rounded-[14px] border px-3.5 py-3 text-left"
      data-testid="onboarding-agent-card"
    >
      <div className="flex items-center gap-2.5">
        <div className="bg-muted text-muted-foreground flex size-[30px] shrink-0 items-center justify-center rounded-[8px]">
          <Terminal size={16} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-[13.5px] font-semibold">
            {t("onboarding.ready.agents.title")}
          </div>
          <div className="text-muted-foreground text-[12px] leading-[1.4]">
            {t("onboarding.ready.agents.desc")}
          </div>
        </div>
        <span className="mono bg-muted text-muted-foreground shrink-0 rounded-[6px] px-2 py-0.5 text-[10px] tracking-[0.08em] uppercase">
          {t("onboarding.ready.agents.optional")}
        </span>
      </div>
      {found.map((row) => (
        <CardRow key={row.tool} row={row} onAdd={() => add(row.tool)} />
      ))}
      <div className="text-muted-foreground mt-2 text-[12px]">
        {t("onboarding.ready.agents.found", {
          tools: found.map((row) => AGENT_LABELS[row.tool]).join(", "),
        })}
      </div>
    </div>
  );
}

/** The card on macOS only: the launcher is part of the macOS app. */
export function ConnectAgentCard(): React.JSX.Element | null {
  return IS_MAC ? <AgentCard /> : null;
}
