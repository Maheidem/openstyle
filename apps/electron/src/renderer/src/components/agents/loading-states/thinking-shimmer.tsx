import { cn } from "@renderer/lib/utils";
import type { ReactNode } from "react";

export interface ThinkingShimmerProps {
  children?: ReactNode;
  duration?: number;
  className?: string;
}

export function ThinkingShimmer({
  children = "Thinking…",
  duration = 1.8,
  className,
}: ThinkingShimmerProps) {
  return (
    <span
      style={{ animation: `beui-text-shimmer ${duration}s linear infinite` }}
      className={cn(
        "inline-block bg-[length:200%_100%] bg-clip-text text-transparent bg-[linear-gradient(110deg,var(--muted-foreground)_30%,var(--foreground)_50%,var(--muted-foreground)_70%)]",
        "font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}
