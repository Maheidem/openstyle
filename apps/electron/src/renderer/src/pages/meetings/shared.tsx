import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { useCopyToClipboard } from "@renderer/hooks/use-copy-to-clipboard";
import { cn } from "@renderer/lib/utils";
import type { TFunction } from "i18next";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TranscriptSegment } from "./types";

// specs/meeting-speaker-naming.md §4: prefer a confirmed speakerName over the
// numbered fallback; a "Them" segment with no speakerLabel at all renders
// "Unidentified" (§3.3 amendment), never bare "Them".
export function segmentSpeakerLabel(
  seg: TranscriptSegment,
  t: TFunction,
): string {
  if (seg.speaker === "Me") return t("meetings.me");
  return (
    seg.speakerName ??
    (seg.speakerLabel
      ? t("meetings.themNumbered", { n: seg.speakerLabel })
      : t("meetings.speakerUnidentified"))
  );
}

// Everything except an active failure renders as the same plain, muted badge
// (spec: matches the approved mockup's undifferentiated `.badge` — Recorded,
// Transcribed and Summarized are not visually distinguished from each other).
export const STATUS_BADGE_VARIANT: Record<string, "destructive" | "outline"> = {
  interrupted: "destructive",
  failed: "destructive",
};

// "recording"/"transcribing" are this page's only in-progress states — the
// one spot that earns the fenced accent-live coral (spec: record / live /
// in-progress ONLY). Mirrors the mockup's `.badge.live` treatment (tinted
// background + a small dot), never reused for anything else.
export const LIVE_STATUSES = new Set(["recording", "transcribing"]);

export function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const { t } = useTranslation();
  const live = LIVE_STATUSES.has(status);
  const variant = STATUS_BADGE_VARIANT[status] ?? "outline";
  return (
    <Badge
      variant={variant}
      className={cn(
        "mono h-4 shrink-0 gap-1 px-1.5 text-[9px] uppercase tracking-[0.12em]",
        variant === "outline" && !live && "text-muted-foreground",
        live &&
          "border-[color:var(--live)]/30 bg-[var(--live-tint)] text-[color:var(--live)]",
      )}
    >
      {live && (
        <span className="h-[5px] w-[5px] shrink-0 animate-pulse rounded-full bg-[var(--live)]" />
      )}
      {t(`meetings.status.${status}`, status)}
    </Badge>
  );
}

export function CopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}): React.JSX.Element {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Button variant="outline" size="sm" onClick={() => void copy(text)}>
      {copied ? (
        <Check data-icon="inline-start" className="text-primary" />
      ) : (
        <Copy data-icon="inline-start" />
      )}
      {label}
    </Button>
  );
}
