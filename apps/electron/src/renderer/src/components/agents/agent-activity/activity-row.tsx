import { cn } from "@renderer/lib/utils";
import { Check, Circle } from "lucide-react";
import { m } from "motion/react";
import type { AgentActivityStep } from "./types";

export function StepRow({ item }: { item: AgentActivityStep }) {
  const state = item.status ?? "complete";

  return (
    <div className="flex min-h-7 items-start gap-2.5 rounded-md px-1.5 py-1">
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-4 shrink-0 place-items-center text-muted-foreground/70"
      >
        {state === "complete" ? (
          <Check className="size-4" strokeWidth={1.8} />
        ) : state === "active" ? (
          <span className="relative grid size-3 place-items-center">
            <m.span
              className="absolute inset-0 rounded-full bg-foreground/10"
              animate={{ opacity: [0.35, 0.8, 0.35] }}
              transition={{ duration: 1.5, repeat: Number.POSITIVE_INFINITY }}
            />
            <span className="size-1.5 rounded-full bg-foreground/60" />
          </span>
        ) : (
          <Circle className="size-3" strokeWidth={1.5} />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 leading-5",
          state === "pending"
            ? "text-muted-foreground/55"
            : "text-foreground/90",
        )}
      >
        {item.label}
      </span>
      {item.meta ? (
        <span className="shrink-0 leading-5 text-muted-foreground/55">
          {item.meta}
        </span>
      ) : null}
    </div>
  );
}
