import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { getClient } from "@renderer/lib/api";
import { cn } from "@renderer/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpeakerRow, SpeakersResponse } from "./types";

// ---------------------------------------------------------------------------
// Meeting speaker naming (specs/meeting-speaker-naming.md §7): the
// naming/merge dialog, one popover-turned-dialog reachable from a "Speakers"
// action button next to "Identify speakers"/"Enhance".
// ---------------------------------------------------------------------------

/** Radix `Select` reserves `""` internally to mean "no selection" and
 * throws — same convention `task-profiles-section.tsx` already uses. */
export const SPEAKER_MERGE_NONE_VALUE = "__none__";

/** Effective (dialog-relevant) name for merge-hint matching and merge-target
 * option labels: the confirmed name, else the suggestion, else undefined. */
export function effectiveSpeakerName(row: SpeakerRow): string | undefined {
  return row.displayName ?? row.suggestedName ?? undefined;
}

/**
 * Merge-hint pairs (specs/meeting-speaker-naming.md §7.2): any two unmerged
 * rows whose effective name matches, case-insensitively, after trim.
 * Comparing the effective name (not `suggestedName` alone) means confirming
 * one of a duplicate pair doesn't make the hint vanish for the other.
 */
export function computeMergeHints(speakers: SpeakerRow[]): Map<string, string> {
  const hints = new Map<string, string>();
  const unmerged = speakers.filter((s) => s.mergedInto === null);
  for (let i = 0; i < unmerged.length; i++) {
    const a = effectiveSpeakerName(unmerged[i])?.trim().toLowerCase();
    if (!a) continue;
    for (let j = 0; j < unmerged.length; j++) {
      if (i === j || hints.has(unmerged[i].label)) continue;
      const b = effectiveSpeakerName(unmerged[j])?.trim().toLowerCase();
      if (b && a === b) hints.set(unmerged[i].label, unmerged[j].label);
    }
  }
  return hints;
}

export function SpeakerRowEditor({
  meetingId,
  row,
  speakers,
  mergeHintTarget,
  onSaved,
}: {
  meetingId: string;
  row: SpeakerRow;
  speakers: SpeakerRow[];
  mergeHintTarget: SpeakerRow | undefined;
  onSaved: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState(row.displayName ?? row.suggestedName ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(row.displayName ?? row.suggestedName ?? "");
  }, [row.displayName, row.suggestedName]);

  const patch = useCallback(
    async (body: {
      displayName?: string | null;
      mergedInto?: string | null;
    }) => {
      const res = await getClient().api.meetings[":id"].speakers[
        ":label"
      ].$patch({
        param: { id: meetingId, label: row.label },
        json: body,
      });
      if (res.ok) onSaved();
      return res.ok;
    },
    [meetingId, row.label, onSaved],
  );

  const commitName = useCallback(async () => {
    const next = name.trim();
    const current = row.displayName ?? "";
    // A blur that lands back on the currently-confirmed value (or on
    // nothing, when nothing was ever confirmed) is a no-op — everything
    // else, including a blur that still holds an unconfirmed suggestion, is
    // an explicit confirmation (specs/meeting-speaker-naming.md §7.2).
    if (next === current) return;
    const ok = await patch({ displayName: next || null });
    if (!ok) setName(row.displayName ?? row.suggestedName ?? "");
  }, [name, row.displayName, row.suggestedName, patch]);

  const isSuggestedUnconfirmed =
    row.displayName === null &&
    !!row.suggestedName &&
    name.trim() === row.suggestedName;
  const isRoleGuess = isSuggestedUnconfirmed && row.suggestedKind === "role";

  const otherSpeakers = speakers.filter((s) => s.label !== row.label);
  const mergeTargetLabel = (label: string): string =>
    speakers.find((s) => s.label === label)?.displayName ??
    t("meetings.themNumbered", { n: label });

  return (
    <div className="border-border border-b py-3.5 last:border-b-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-foreground text-[12.5px] font-medium">
          {t("meetings.themNumbered", { n: row.label })}
        </span>
        <span className="text-muted-foreground text-[11px]">
          {t("meetings.speakerSegments", { n: row.segmentCount })}
        </span>
      </div>
      {row.quote && (
        <p className="text-muted-foreground m-0 mb-2 truncate text-[11.5px] italic">
          “{row.quote}”
        </p>
      )}
      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center gap-1.5">
          <Input
            ref={inputRef}
            value={name}
            maxLength={80}
            placeholder={t("meetings.speakerNamePlaceholder")}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                inputRef.current?.blur();
              }
            }}
            className={cn(
              "h-8 text-[12.5px]",
              isSuggestedUnconfirmed && "border-dashed",
              // Role guesses read visually distinct from a real name
              // suggestion — this is a descriptor the LLM inferred, never
              // evidence-backed identity (specs/meeting-speaker-naming.md
              // §5.2's hardened contract; real-E2E finding on meeting
              // 8e6aea86).
              isRoleGuess && "italic",
            )}
          />
          {isSuggestedUnconfirmed && (
            <Badge variant="passive" className="shrink-0">
              {t(
                isRoleGuess
                  ? "meetings.speakerRoleGuess"
                  : "meetings.speakerSuggested",
              )}
            </Badge>
          )}
        </div>
        {row.mergedInto ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-muted-foreground text-[11px]">
              {t("meetings.speakerMergedInto", {
                name: mergeTargetLabel(row.mergedInto),
              })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => void patch({ mergedInto: null })}
            >
              {t("meetings.speakerUnmerge")}
            </Button>
          </div>
        ) : (
          <Select
            value={SPEAKER_MERGE_NONE_VALUE}
            onValueChange={(v) =>
              void patch({
                mergedInto: v === SPEAKER_MERGE_NONE_VALUE ? null : v,
              })
            }
          >
            <SelectTrigger
              className="h-8 w-40 shrink-0 text-[12px]"
              aria-label={t("meetings.speakerMergeInto")}
            >
              <SelectValue placeholder={t("meetings.speakerMergeNone")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SPEAKER_MERGE_NONE_VALUE}>
                {t("meetings.speakerMergeNone")}
              </SelectItem>
              {otherSpeakers.map((s) => (
                <SelectItem key={s.label} value={s.label}>
                  {s.displayName ?? t("meetings.themNumbered", { n: s.label })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {row.suggestedEvidence && (
        <p className="text-muted-foreground m-0 mt-1 truncate text-[11px]">
          {t(
            isRoleGuess
              ? "meetings.speakerRoleEvidence"
              : "meetings.speakerEvidence",
            { evidence: row.suggestedEvidence },
          )}
        </p>
      )}
      {row.mergedInto === null && mergeHintTarget && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-[var(--accent-passive-tint)] px-2.5 py-1.5">
          <span className="text-[color:var(--accent-passive-ink)] text-[11px]">
            {t("meetings.speakerMergeHint", {
              name: effectiveSpeakerName(mergeHintTarget),
              label: mergeHintTarget.label,
            })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={() => void patch({ mergedInto: mergeHintTarget.label })}
          >
            {t("meetings.speakerMerge")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function SpeakersDialog({
  id,
  open,
  onOpenChange,
  data,
  onSaved,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Owned by `MeetingDetailView`, not this dialog (specs/meeting-speaker-
   * naming.md §7.3): §7.4's re-diarize confirmation needs this data whether
   * or not the dialog is open, so the dialog is a consumer, not the owner. */
  data: SpeakersResponse | undefined;
  onSaved: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();

  const speakers = data?.speakers ?? [];
  const unlabeledCount = data?.unlabeledCount ?? 0;
  const mergeHints = computeMergeHints(speakers);
  const byLabel = new Map(speakers.map((s) => [s.label, s]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("meetings.speakersDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("meetings.speakersDialogDesc")}
          </DialogDescription>
        </DialogHeader>

        {speakers.length === 0 && unlabeledCount === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-[12.5px]">
            {t("meetings.speakerEmptyState")}
          </p>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto">
            {speakers.map((row) => (
              <SpeakerRowEditor
                key={row.label}
                meetingId={id}
                row={row}
                speakers={speakers}
                mergeHintTarget={
                  mergeHints.has(row.label)
                    ? byLabel.get(mergeHints.get(row.label) as string)
                    : undefined
                }
                onSaved={onSaved}
              />
            ))}
            {unlabeledCount > 0 && (
              <p className="text-muted-foreground border-border border-t pt-3 text-[11px]">
                {t("meetings.speakerUnlabeledNote", { n: unlabeledCount })}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            {t("meetings.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
