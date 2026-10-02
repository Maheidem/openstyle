import type { ReactNode } from "react";

export type AgentActivityStatus = "working" | "complete";
export type AgentStepStatus = "pending" | "active" | "complete";

export interface AgentActivityStep {
  id: string;
  type: "step";
  label: ReactNode;
  status?: AgentStepStatus;
  meta?: ReactNode;
}

export interface AgentActivityProps {
  items: AgentActivityStep[];
  status?: AgentActivityStatus;
  activeLabel?: ReactNode;
  summary: ReactNode;
  maxHeight?: number;
  className?: string;
  contentClassName?: string;
}
