import { Button } from "@renderer/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@renderer/components/ui/popover";
import { Switch } from "@renderer/components/ui/switch";
import { Textarea } from "@renderer/components/ui/textarea";
import { getClient } from "@renderer/lib/api";
import { queryKeys, settingsQueryOptions } from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Info,
  MessageSquareText,
  Settings2,
  Users,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SETTINGS_KEYS } from "../../../../shared/settings-keys";
import type { DiarizationStatusResponse } from "./types";

export function SummaryInstructionsPopover(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(settingsQueryOptions());
  const saved = settings?.[SETTINGS_KEYS.meetingSummaryInstructions] ?? "";
  // null = the user has not edited the text since the popover opened.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  const value = draft ?? saved;
  const dirty = draft !== null && draft !== saved;

  const save = useCallback(async () => {
    if (draft === null) return;
    setSaving(true);
    try {
      if (await putSetting(SETTINGS_KEYS.meetingSummaryInstructions, draft)) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
        setDraft(null);
      }
    } finally {
      setSaving(false);
    }
  }, [draft, queryClient]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(null);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("meetings.summaryInstructionsLabel")}
          title={t("meetings.summaryInstructionsLabel")}
        >
          <Settings2 />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="text-foreground text-[12.5px] font-medium">
          {t("meetings.summaryInstructionsLabel")}
        </p>
        <p className="text-muted-foreground text-[11px] leading-[1.5]">
          {t("meetings.summaryInstructionsHint")}
        </p>
        <div className="border-border bg-card/30 text-muted-foreground flex items-start gap-1.5 rounded-md border px-2.5 py-2 text-[11px] leading-[1.4]">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            <span className="text-foreground font-medium">
              {t("meetings.summaryInstructionsGlobalNote")}
            </span>{" "}
            {t("meetings.summaryInstructionsPerMeetingPointer")}
          </span>
        </div>
        <Textarea
          value={value}
          maxLength={4000}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="mono min-h-[120px] resize-y text-[11.5px] leading-[1.5]"
          aria-label={t("meetings.summaryInstructionsLabel")}
        />
        <div className="flex justify-end">
          <Button
            variant="ink"
            size="sm"
            onClick={() => void save()}
            disabled={!dirty || saving}
          >
            {saving ? t("meetings.saving") : t("meetings.save")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Global (not per-meeting) diarization toggle (spec §8, simplified
 * 2026-08-25). Models are pre-bundled with the app (spec §4) — there's no
 * download to trigger any more, so the toggle just persists the flag. A
 * cheap probe (`GET /diarization/status`) still runs on open so the popover
 * can tell the user when a build/packaging gap makes the feature unusable,
 * rather than the toggle silently doing nothing.
 */
export function DiarizationSettingsPopover(): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DiarizationStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh =
    useCallback(async (): Promise<DiarizationStatusResponse | null> => {
      const res = await getClient().api.meetings.diarization.status.$get();
      if (!res.ok) return null;
      const body = await res.json();
      setState(body);
      return body;
    }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const handleToggle = useCallback(async (next: boolean) => {
    setBusy(true);
    try {
      await getClient().api.settings[":key"].$put({
        param: { key: SETTINGS_KEYS.meetingDiarizationEnabled },
        json: { value: String(next) },
      });
      setState((s) => (s ? { ...s, enabled: next } : s));
    } finally {
      setBusy(false);
    }
  }, []);

  const checked = Boolean(state?.enabled);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("meetings.diarizationLabel")}
          title={t("meetings.diarizationLabel")}
        >
          <Users />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-foreground m-0 text-[12.5px] font-medium">
              {t("meetings.diarizationLabel")}
            </p>
            <p className="text-muted-foreground m-0 text-[11px] leading-[1.5]">
              {t("meetings.diarizationHint")}
            </p>
          </div>
          <Switch
            checked={checked}
            disabled={busy}
            onCheckedChange={(v) => void handleToggle(v)}
          />
        </div>
        {(state?.status === "unavailable" || state?.status === "error") && (
          <p className="text-muted-foreground mt-2 text-[10.5px]">
            {t("meetings.diarizationUnavailable")}
          </p>
        )}
        {state?.status === "not-ready" && (
          <p className="text-destructive mt-2 text-[10.5px]">
            {t("meetings.diarizationNotReady")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Global auto-Enhance toggle (specs/meeting-transcription-v2.md §3.2). When
 * on, a finished transcription is followed automatically by an Enhance pass
 * with the default LLM. Like the diarization switch above it writes the
 * string contract the server validator accepts: only `"true"` turns it on,
 * `"false"` is an explicit off, and a missing row means off too.
 */
/**
 * Global previous-chunk-context toggle (specs/meeting-transcription-v2.md
 * §3.1, owner decision 2026-10-07). When on, each chunk's bias prompt
 * carries the tail of the previous chunk's cleaned text in the same
 * channel. Like the auto-Enhance switch above it, it writes the string
 * contract the server validator accepts: only `"true"` turns it on,
 * `"false"` is an explicit off, and a missing row means off too.
 */
export function AsrContextSettingsPopover(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(settingsQueryOptions());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const checked = settings?.[SETTINGS_KEYS.meetingAsrContext] === "true";

  const handleToggle = useCallback(
    async (next: boolean) => {
      setBusy(true);
      try {
        await putSetting(SETTINGS_KEYS.meetingAsrContext, String(next));
        await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      } finally {
        setBusy(false);
      }
    },
    [queryClient],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("meetings.asrContextLabel")}
          title={t("meetings.asrContextLabel")}
        >
          <MessageSquareText />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-foreground m-0 text-[12.5px] font-medium">
              {t("meetings.asrContextLabel")}
            </p>
            <p className="text-muted-foreground m-0 text-[11px] leading-[1.5]">
              {t("meetings.asrContextHint")}
            </p>
          </div>
          <Switch
            checked={checked}
            disabled={busy}
            onCheckedChange={(v) => void handleToggle(v)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function EnhanceSettingsPopover(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(settingsQueryOptions());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const checked = settings?.[SETTINGS_KEYS.meetingEnhanceAutoRun] === "true";

  const handleToggle = useCallback(
    async (next: boolean) => {
      setBusy(true);
      try {
        await putSetting(SETTINGS_KEYS.meetingEnhanceAutoRun, String(next));
        await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      } finally {
        setBusy(false);
      }
    },
    [queryClient],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("meetings.enhanceAutoLabel")}
          title={t("meetings.enhanceAutoLabel")}
        >
          <WandSparkles />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-foreground m-0 text-[12.5px] font-medium">
              {t("meetings.enhanceAutoLabel")}
            </p>
            <p className="text-muted-foreground m-0 text-[11px] leading-[1.5]">
              {t("meetings.enhanceAutoHint")}
            </p>
          </div>
          <Switch
            checked={checked}
            disabled={busy}
            onCheckedChange={(v) => void handleToggle(v)}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
