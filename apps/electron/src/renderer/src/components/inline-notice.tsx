import { cn } from "@renderer/lib/utils";
import type { LucideIcon } from "lucide-react";

const TONE_CLASS = {
  neutral: "border-border bg-card/30 text-foreground",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
} as const;

/** One banner line: an icon and a message. `className` overrides the defaults. */
export function InlineNotice({
  tone,
  icon: Icon,
  iconClassName,
  className,
  children,
}: {
  tone: keyof typeof TONE_CLASS;
  icon: LucideIcon;
  iconClassName?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "mb-5 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[12px]",
        TONE_CLASS[tone],
        className,
      )}
    >
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", iconClassName)} />
      {children}
    </div>
  );
}
