import { DragSpacer } from "@renderer/components/drag-spacer";
import {
  LanguageList,
  useLanguageOptions,
} from "@renderer/components/language-combobox";
import { Markdown } from "@renderer/components/markdown";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Card } from "@renderer/components/ui/card";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@renderer/components/ui/popover";
import { Progress } from "@renderer/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@renderer/components/ui/tabs";
import { Textarea } from "@renderer/components/ui/textarea";
import { getClient } from "@renderer/lib/api";
import { configQueryOptions, queryKeys } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  AudioLines,
  Check,
  ChevronLeft,
  Copy,
  FolderOpen,
  Languages,
  Mic,
  MonitorSpeaker,
  Pencil,
  RefreshCw,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  UserCog,
  Users,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import { SETTINGS_KEYS } from "../../../shared/settings-keys";

// ---------------------------------------------------------------------------
// API types (mirrors apps/server/src/routes/meetings.ts responses)
// ---------------------------------------------------------------------------

interface MeetingListItem {
  id: string;
  title: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  status: string;
  /** Resolved (or user-set) transcription language, Phase A2. NULL means
   * "not yet resolved" — the language chip renders "Auto". */
  language: string | null;
  error: string | null;
  created_at: number | null;
}

interface MeetingDetail extends MeetingListItem {
  stt_provider: string | null;
  stt_model: string | null;
  audio_dir: string | null;
  /** Free-text per-meeting context (specs/meeting-speaker-naming.md §3.4),
   * editable anytime. Feeds both the naming prompt and the summarize
   * prompt. NULL means unset. */
  context: string | null;
  job: { done: number; total: number; failed: number } | null;
  segment_counts: { total: number; failed: number };
  summary: {
    markdown: string | null;
    llm_provider: string | null;
    llm_model: string | null;
    cost_usd: number | null;
    created_at: number | null;
  } | null;
}

interface TranscriptSegment {
  speaker: "Me" | "Them";
  startMs: number;
  endMs: number;
  text: string;
  /** Diarization label (spec §6) — raw numeral string, e.g. "2". Undefined
   * when undiarized (flag off, or this segment fell through to NULL). */
  speakerLabel?: string;
  /** `meeting_segments.id`, Phase C (specs/meeting-transcription-quality.md
   * §6.1) — unused by the UI directly, carried through for a stable list
   * key candidate. */
  id?: string;
  /** LLM-corrected text, Phase C. Undefined when never enhanced, or when
   * Enhance ran and left this segment unchanged. */
  enhancedText?: string;
  /** Confirmed display name for this segment's resolved speaker identity
   * (specs/meeting-speaker-naming.md §4), following any merge. Undefined
   * when unnamed — renderer falls back to "Them {{speakerLabel}}". */
  speakerName?: string;
}

interface SpeakerRow {
  label: string;
  segmentCount: number;
  quote: string | null;
  displayName: string | null;
  suggestedName: string | null;
  suggestedEvidence: string | null;
  mergedInto: string | null;
}

interface SpeakersResponse {
  speakers: SpeakerRow[];
  unlabeledCount: number;
  /** Max `meeting_speakers.updated_at` across this meeting's rows, or null
   * when there are none — powers the summary-tab staleness hint (§9.2)
   * without a second endpoint. */
  latestSpeakerUpdate: number | null;
}

interface DiarizationStatusResponse {
  enabled: boolean;
  status: "ready" | "not-ready" | "unavailable" | "error";
  error?: string;
}

type RecorderStatus = "idle" | "recording" | "finalizing";

// ---------------------------------------------------------------------------
// First-run system-audio probe: macOS silently denies the Core Audio tap
// (zero-filled buffers, success codes), so before the first recording we run
// the real pipeline briefly via IPC. 'silent' is indeterminate (denied OR
// nothing playing) — surface a non-blocking hint, never a blocker.
// ---------------------------------------------------------------------------

const PROBE_DONE_KEY = "meetings_system_audio_probe_done";

function useSystemAudioProbe(shouldProbe: boolean): boolean {
  const [showHint, setShowHint] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!shouldProbe || startedRef.current) return;
    let done = false;
    try {
      done = localStorage.getItem(PROBE_DONE_KEY) === "1";
    } catch {
      // storage unavailable — probe at most once per session via startedRef
    }
    if (done) return;
    startedRef.current = true;
    void window.api?.probeMeetingSystemAudio?.().then((result) => {
      try {
        localStorage.setItem(PROBE_DONE_KEY, "1");
      } catch {
        // best-effort
      }
      if (result === "silent") setShowHint(true);
    });
  }, [shouldProbe]);

  return showHint;
}

function SystemAudioHint(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="border-border bg-card/60 mb-6 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[12px]">
      <AlertTriangle className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground m-0 leading-[1.5]">
          {t("meetings.audioProbeHintBody")}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => window.api?.openAudioCaptureSettings?.()}
      >
        {t("meetings.audioProbeHintOpenSettings")}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "0:00";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function formatTimestamp(ms: number | null): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatClockMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Everything except an active failure renders as the same plain, muted badge
// (spec: matches the approved mockup's undifferentiated `.badge` — Recorded,
// Transcribed and Summarized are not visually distinguished from each other).
const STATUS_BADGE_VARIANT: Record<string, "destructive" | "outline"> = {
  interrupted: "destructive",
  failed: "destructive",
};

// "recording"/"transcribing" are this page's only in-progress states — the
// one spot that earns the fenced accent-live coral (spec: record / live /
// in-progress ONLY). Mirrors the mockup's `.badge.live` treatment (tinted
// background + a small dot), never reused for anything else.
const LIVE_STATUSES = new Set(["recording", "transcribing"]);

function StatusBadge({ status }: { status: string }): React.JSX.Element {
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

// ---------------------------------------------------------------------------
// Recording card: timer + per-channel level meters, driven by the preload
// meeting API (meeting:level IPC events).
// ---------------------------------------------------------------------------

function useRecorder(): {
  status: RecorderStatus;
  supported: boolean;
  meetingId: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  error: string | null;
} {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [supported, setSupported] = useState(false);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    void window.api?.getMeetingStatus?.().then((s) => {
      if (cancelled) return;
      setStatus(s.status);
      setSupported(s.supported);
      setMeetingId(s.meetingId);
    });
    const remove = window.api?.onMeetingStatusChanged?.((next) => {
      setStatus(next);
      if (next === "idle") {
        setMeetingId(null);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.meetings.all,
        });
      }
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }, [queryClient]);

  const start = useCallback(async () => {
    setError(null);
    const result = await window.api?.startMeetingRecording?.();
    if (result?.ok) {
      setMeetingId(result.id ?? null);
      setStatus("recording");
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.all });
    } else if (result?.error) {
      setError(result.error);
    }
  }, [queryClient]);

  const stop = useCallback(async () => {
    await window.api?.stopMeetingRecording?.();
    void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.all });
  }, [queryClient]);

  return { status, supported, meetingId, start, stop, error };
}

function LevelMeter({
  icon,
  label,
  level,
}: {
  icon: React.ReactNode;
  label: string;
  level: number;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      {icon}
      <span className="mono text-muted-foreground w-14 shrink-0 text-[9px] uppercase tracking-[0.14em]">
        {label}
      </span>
      <Progress
        value={Math.min(100, Math.round(level * 300))}
        className="h-1 flex-1"
      />
    </div>
  );
}

function RecordingCard({
  recorder,
  compact = false,
}: {
  recorder: ReturnType<typeof useRecorder>;
  /** Rail context (mockup artboard 02): swap the idle/finalizing "Record a
   * meeting" card — whose title+description text wraps and collides with
   * the button at ~262px — for a slim pill. An in-progress recording still
   * gets the full Card below (timer + level meters + Stop): that layout
   * never had the wrap bug, so it's left untouched. */
  compact?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [micLevel, setMicLevel] = useState(0);
  const [systemLevel, setSystemLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const recording = recorder.status === "recording";
  const finalizing = recorder.status === "finalizing";

  useEffect(() => {
    if (!recording) {
      startedAtRef.current = null;
      setElapsedMs(0);
      setMicLevel(0);
      setSystemLevel(0);
      return;
    }
    startedAtRef.current = Date.now();
    const timer = setInterval(() => {
      if (startedAtRef.current) {
        setElapsedMs(Date.now() - startedAtRef.current);
      }
    }, 1000);
    const remove = window.api?.onMeetingLevel?.((event) => {
      if (event.source === "mic") setMicLevel(event.rms);
      else setSystemLevel(event.rms);
    });
    return () => {
      clearInterval(timer);
      remove?.();
    };
  }, [recording]);

  if (compact && !recording) {
    return (
      <div className="mb-4">
        <div className="flex min-w-0 items-center gap-2">
          {finalizing ? (
            <Button variant="outline" size="xs" disabled>
              <RefreshCw data-icon="inline-start" className="animate-spin" />
              {t("meetings.finalizing")}
            </Button>
          ) : (
            <Button
              variant="ink"
              size="xs"
              onClick={() => void recorder.start()}
              disabled={!recorder.supported}
            >
              <Mic data-icon="inline-start" />
              {t("meetings.start")}
            </Button>
          )}
          {!finalizing && recorder.error && (
            <span className="text-destructive min-w-0 flex-1 truncate text-[10px]">
              {recorder.error}
            </span>
          )}
        </div>
        {!finalizing && !recorder.supported && (
          <p className="text-muted-foreground mt-1.5 text-[10.5px] leading-[1.4]">
            {t("meetings.notSupported")}
          </p>
        )}
      </div>
    );
  }

  return (
    <Card className={cn("mb-6 p-5", compact && "mb-4 p-3.5")}>
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          {recording ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2.5">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--live)]" />
                <span className="text-foreground text-[13px] font-medium">
                  {t("meetings.recording")}
                </span>
                <span className="mono text-muted-foreground text-[12px] tabular-nums">
                  {formatClockMs(elapsedMs)}
                </span>
              </div>
              <LevelMeter
                icon={<Mic className="text-muted-foreground h-3.5 w-3.5" />}
                label={t("meetings.micLevel")}
                level={micLevel}
              />
              <LevelMeter
                icon={
                  <MonitorSpeaker className="text-muted-foreground h-3.5 w-3.5" />
                }
                label={t("meetings.systemLevel")}
                level={systemLevel}
              />
            </div>
          ) : (
            <div>
              <div className="text-foreground text-[13px] font-medium">
                {t("meetings.recordTitle")}
              </div>
              <p className="text-muted-foreground mt-0.5 text-[12px] leading-snug">
                {recorder.supported
                  ? t("meetings.recordDesc")
                  : t("meetings.notSupported")}
              </p>
              {recorder.error && (
                <p className="text-destructive mt-1 text-[12px]">
                  {recorder.error}
                </p>
              )}
            </div>
          )}
        </div>
        {recording || recorder.status === "finalizing" ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void recorder.stop()}
            disabled={recorder.status === "finalizing"}
          >
            <Square data-icon="inline-start" />
            {recorder.status === "finalizing"
              ? t("meetings.finalizing")
              : t("meetings.stop")}
          </Button>
        ) : (
          <Button
            variant="ink"
            size="sm"
            onClick={() => void recorder.start()}
            disabled={!recorder.supported}
          >
            <Mic data-icon="inline-start" />
            {t("meetings.start")}
          </Button>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function CopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <Check data-icon="inline-start" className="text-primary" />
      ) : (
        <Copy data-icon="inline-start" />
      )}
      {label}
    </Button>
  );
}

function EditableTitle({
  id,
  title,
  onRenamed,
}: {
  id: string;
  title: string | null;
  onRenamed: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setValue(title ?? "");
  }, [title, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = useCallback(async () => {
    const next = value.trim();
    setEditing(false);
    if (!next || next === (title ?? "")) {
      setValue(title ?? "");
      return;
    }
    const res = await getClient().api.meetings[":id"].$patch({
      param: { id },
      json: { title: next },
    });
    if (res.ok) onRenamed();
    else setValue(title ?? "");
  }, [id, onRenamed, title, value]);

  if (editing) {
    return (
      <Input
        ref={inputRef}
        value={value}
        maxLength={512}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            setValue(title ?? "");
            setEditing(false);
          }
        }}
        aria-label={t("meetings.renameLabel")}
        className="h-7 text-[15px] font-medium"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="group flex min-w-0 items-center gap-1.5 text-left"
      title={t("meetings.rename")}
    >
      <span className="text-foreground truncate text-[15px] font-medium">
        {title || t("meetings.untitled")}
      </span>
      <Pencil className="text-muted-foreground/0 group-hover:text-muted-foreground h-3 w-3 shrink-0 transition-colors" />
    </button>
  );
}

/**
 * Editable per-meeting free-text context field (specs/meeting-speaker-
 * naming.md §3.4/§7.6, amended 2026-08-27 sign-off point 1). Collapsed to a
 * single muted line by default, expanding to a `Textarea` on click; saves on
 * blur, empty string normalizes to `null` (explicit clear). Visible whenever
 * the meeting detail view is open — not gated on `hasTranscript`, since
 * context is useful to jot down before a meeting has even been transcribed
 * and feeds a later Enhance/Summarize run whenever it eventually happens.
 */
function MeetingContextField({
  id,
  context,
  onChanged,
}: {
  id: string;
  context: string | null;
  onChanged: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(context ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setValue(context ?? "");
  }, [context, editing]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const commit = useCallback(async () => {
    const next = value.trim();
    setEditing(false);
    if (next === (context ?? "")) return;
    const res = await getClient().api.meetings[":id"].$patch({
      param: { id },
      json: { context: next || null },
    });
    if (res.ok) onChanged();
    else setValue(context ?? "");
  }, [id, onChanged, context, value]);

  if (editing) {
    return (
      <Textarea
        ref={textareaRef}
        value={value}
        maxLength={2000}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setValue(context ?? "");
            setEditing(false);
          }
        }}
        aria-label={t("meetings.contextPlaceholder")}
        placeholder={t("meetings.contextPlaceholder")}
        className="mono min-h-[64px] resize-y text-[12px] leading-[1.5]"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="group flex min-w-0 items-center gap-1.5 text-left"
    >
      <span className="text-muted-foreground group-hover:text-foreground truncate text-[11.5px] transition-colors">
        {context || t("meetings.contextPlaceholder")}
      </span>
      <Pencil className="text-muted-foreground/0 group-hover:text-muted-foreground h-3 w-3 shrink-0 transition-colors" />
    </button>
  );
}

/**
 * Editable per-meeting transcription-language chip (Phase A2 §3.2.5,
 * specs/meeting-transcription-quality.md). Shows the resolved (or user-set)
 * language, or "Auto" when unresolved (`meeting.language` is NULL — either
 * `languages` is set to auto-detect, or the meeting hasn't been transcribed
 * yet). Re-transcribe and retry-failed always read whatever is currently
 * stored (routes/meetings.ts), so picking a language here takes effect on
 * the next run with no other wiring.
 */
function MeetingLanguageChip({
  id,
  language,
  onChanged,
}: {
  id: string;
  language: string | null;
  onChanged: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const options = useLanguageOptions();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const current = language ?? "auto";
  const label =
    options.find((o) => o.code === current)?.label ??
    language ??
    t("meetings.languageAuto");

  const select = useCallback(
    async (code: string) => {
      setSaving(true);
      try {
        const res = await getClient().api.meetings[":id"].$patch({
          param: { id },
          json: { language: code === "auto" ? null : code },
        });
        if (res.ok) onChanged();
      } finally {
        setSaving(false);
        setOpen(false);
      }
    },
    [id, onChanged],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={saving}
          className="h-6 gap-1 rounded-full px-2.5 text-[11px]"
          aria-label={t("meetings.language")}
          title={t("meetings.language")}
        >
          <Languages className="size-3" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <LanguageList
          options={options}
          selectedCodes={[current]}
          autoFocus
          onSelect={(code) => void select(code)}
        />
      </PopoverContent>
    </Popover>
  );
}

function SummaryInstructionsPopover(): React.JSX.Element {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getClient()
      .api.settings[":key"].$get({
        param: { key: SETTINGS_KEYS.meetingSummaryInstructions },
      })
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { value: string };
          setValue(body.value);
          setSaved(body.value);
        } else {
          setValue("");
          setSaved("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await getClient().api.settings[":key"].$put({
        param: { key: SETTINGS_KEYS.meetingSummaryInstructions },
        json: { value },
      });
      if (res.ok) setSaved(value);
    } finally {
      setSaving(false);
    }
  }, [value]);

  const dirty = value !== saved;

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
        <Textarea
          value={value}
          maxLength={4000}
          onChange={(e) => setValue(e.target.value)}
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
function DiarizationSettingsPopover(): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DiarizationStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh =
    useCallback(async (): Promise<DiarizationStatusResponse | null> => {
      const res = await getClient().api.meetings.diarization.status.$get();
      if (!res.ok) return null;
      const body = (await res.json()) as DiarizationStatusResponse;
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

// ---------------------------------------------------------------------------
// Meeting speaker naming (specs/meeting-speaker-naming.md §7): the
// naming/merge dialog, one popover-turned-dialog reachable from a "Speakers"
// action button next to "Identify speakers"/"Enhance".
// ---------------------------------------------------------------------------

/** Radix `Select` reserves `""` internally to mean "no selection" and
 * throws — same convention `task-profiles-section.tsx` already uses. */
const SPEAKER_MERGE_NONE_VALUE = "__none__";

/** Effective (dialog-relevant) name for merge-hint matching and merge-target
 * option labels: the confirmed name, else the suggestion, else undefined. */
function effectiveSpeakerName(row: SpeakerRow): string | undefined {
  return row.displayName ?? row.suggestedName ?? undefined;
}

/**
 * Merge-hint pairs (specs/meeting-speaker-naming.md §7.2): any two unmerged
 * rows whose effective name matches, case-insensitively, after trim.
 * Comparing the effective name (not `suggestedName` alone) means confirming
 * one of a duplicate pair doesn't make the hint vanish for the other.
 */
function computeMergeHints(speakers: SpeakerRow[]): Map<string, string> {
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

function SpeakerRowEditor({
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
            )}
          />
          {isSuggestedUnconfirmed && (
            <Badge variant="passive" className="shrink-0">
              {t("meetings.speakerSuggested")}
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

function SpeakersDialog({
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

function MeetingDetailView({
  id,
  onBack,
  onDeleted,
}: {
  id: string;
  onBack: () => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [diarizeResult, setDiarizeResult] = useState<{
    labeledCount: number;
    speakerCount: number;
  } | null>(null);
  const [enhanceResult, setEnhanceResult] = useState<{
    correctedCount: number;
  } | null>(null);
  const [speakersOpen, setSpeakersOpen] = useState(false);
  const [rediarizeConfirmOpen, setRediarizeConfirmOpen] = useState(false);
  // Per-session viewing preference (Phase C, specs/meeting-transcription-
  // quality.md §6.6), not persisted meeting state — a segment Enhance left
  // unchanged (omitted from its JSON response) still renders correctly in
  // either mode via `seg.enhancedText ?? seg.text`.
  const [showEnhanced, setShowEnhanced] = useState(true);

  const { data: meeting } = useQuery({
    queryKey: queryKeys.meetings.detail(id),
    queryFn: async (): Promise<MeetingDetail | null> => {
      const res = await getClient().api.meetings[":id"].$get({
        param: { id },
      });
      if (!res.ok) return null;
      return (await res.json()) as unknown as MeetingDetail;
    },
    // Poll while the transcription job runs so progress and the final status
    // arrive without user interaction.
    refetchInterval: (query) =>
      query.state.data?.status === "transcribing" ? 1000 : false,
  });

  const hasTranscript =
    meeting?.status === "transcribed" || meeting?.status === "summarized";

  const { data: transcript, isFetching: isTranscriptFetching } = useQuery({
    queryKey: queryKeys.meetings.transcript(id),
    queryFn: async (): Promise<TranscriptSegment[]> => {
      const res = await getClient().api.meetings[":id"].transcript.$get({
        param: { id },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { segments: TranscriptSegment[] };
      return body.segments;
    },
    enabled: hasTranscript,
    // Re-transcribe races: the server sets status='transcribing' and DELETEs
    // meeting_segments synchronously in POST /:id/transcribe, then this
    // component's invalidate() (runAction's finally) fires before the
    // re-render disables this query, so it can refetch mid-DELETE and cache
    // a legitimate-looking `[]`. The global default staleTime (ONE_HOUR,
    // query.ts) would then treat that poisoned `[]` as fresh for the rest of
    // the session, so re-enabling this query once the job actually finishes
    // (hasTranscript flips back to true) would never trigger a refetch.
    // staleTime: 0 here means every re-enable refetches for real.
    staleTime: 0,
  });

  // specs/meeting-speaker-naming.md §7.3: kept warm whenever the detail view
  // is open (same `hasTranscript` gate as the "Speakers" button itself),
  // not just while the dialog is open — §7.4's re-diarize confirmation
  // needs this data regardless of whether the dialog has ever been opened.
  const { data: speakersData } = useQuery({
    queryKey: queryKeys.meetings.speakers(id),
    queryFn: async (): Promise<SpeakersResponse> => {
      const res = await getClient().api.meetings[":id"].speakers.$get({
        param: { id },
      });
      if (!res.ok) {
        return { speakers: [], unlabeledCount: 0, latestSpeakerUpdate: null };
      }
      return (await res.json()) as unknown as SpeakersResponse;
    },
    enabled: hasTranscript,
  });
  const hasConfirmedSpeakerState = (speakersData?.speakers ?? []).some(
    (s) => s.displayName !== null || s.mergedInto !== null,
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.all });
  }, [queryClient]);

  const runAction = useCallback(
    async (
      name: string,
      request: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
    ): Promise<unknown> => {
      setBusy(name);
      setActionError(null);
      // Cleared on every action, not just the diarize/enhance ones, so a
      // stale "Identified N speakers"/"Corrected N segments" note doesn't
      // linger through an unrelated re-transcribe/summarize click.
      setDiarizeResult(null);
      setEnhanceResult(null);
      let result: unknown;
      try {
        const res = await request();
        const body = await res.json();
        if (!res.ok) {
          setActionError(
            (body as { error?: string }).error ?? t("meetings.actionFailed"),
          );
        } else {
          result = body;
        }
      } catch {
        setActionError(t("meetings.actionFailed"));
      } finally {
        setBusy(null);
        invalidate();
      }
      return result;
    },
    [invalidate, t],
  );

  const transcribe = useCallback(() => {
    // Clear the transcript cache *before* the POST fires. The server
    // synchronously sets status='transcribing' and DELETEs meeting_segments
    // before returning 202, so a query that's still enabled from the
    // previous 'transcribed' render can race the DELETE and cache an empty
    // result that then reads as "confirmed empty" (see the transcript
    // useQuery comment above). Removing the cache entry up front means
    // there is nothing stale for that race to serve.
    queryClient.removeQueries({ queryKey: queryKeys.meetings.transcript(id) });
    return runAction("transcribe", () =>
      getClient().api.meetings[":id"].transcribe.$post({ param: { id } }),
    );
  }, [id, runAction, queryClient]);
  const summarize = useCallback(
    () =>
      runAction("summarize", () =>
        getClient().api.meetings[":id"].summarize.$post({ param: { id } }),
      ),
    [id, runAction],
  );
  const retryFailed = useCallback(
    () =>
      runAction("retry", () =>
        getClient().api.meetings[":id"]["retry-failed"].$post({
          param: { id },
        }),
      ),
    [id, runAction],
  );
  const identifySpeakers = useCallback(async () => {
    const result = await runAction("diarize", () =>
      getClient().api.meetings[":id"].diarize.$post({ param: { id } }),
    );
    if (result) {
      setDiarizeResult(
        result as { labeledCount: number; speakerCount: number },
      );
    }
    // The route only UPDATEs speaker_label on existing rows — the merged
    // transcript needs a re-fetch to pick the new labels up, same as every
    // other action's invalidate() call inside runAction, called out here
    // because it's the effect the task specifically asked to verify.
    void queryClient.invalidateQueries({
      queryKey: queryKeys.meetings.transcript(id),
    });
  }, [id, runAction, queryClient]);
  // specs/meeting-speaker-naming.md §6.3/§7.4: re-diarize clears the naming
  // mapping (label "N" has no guaranteed relationship to the new run's
  // label "N") — guard the click with a confirmation whenever there's
  // actually something to lose. No guard on the common case (first-ever
  // diarization run, nothing confirmed yet).
  const handleIdentifySpeakersClick = useCallback(() => {
    if (hasConfirmedSpeakerState) setRediarizeConfirmOpen(true);
    else void identifySpeakers();
  }, [hasConfirmedSpeakerState, identifySpeakers]);
  const enhance = useCallback(async () => {
    const result = await runAction("enhance", () =>
      getClient().api.meetings[":id"].enhance.$post({ param: { id } }),
    );
    if (result) {
      setEnhanceResult(result as { correctedCount: number });
    }
    // The route only UPDATEs enhanced_text on existing rows — the merged
    // transcript needs a re-fetch to pick the corrections up, same as
    // identifySpeakers' invalidate() above.
    void queryClient.invalidateQueries({
      queryKey: queryKeys.meetings.transcript(id),
    });
  }, [id, runAction, queryClient]);
  const deleteMeeting = useCallback(async () => {
    await getClient().api.meetings[":id"].$delete({ param: { id } });
    invalidate();
    onDeleted();
  }, [id, invalidate, onDeleted]);

  if (!meeting) {
    return (
      <div className="text-muted-foreground py-10 text-center text-[13px]">
        {t("common.loading", "Loading…")}
      </div>
    );
  }

  const transcribing = meeting.status === "transcribing";
  const canTranscribe =
    !transcribing && meeting.status !== "recording" && busy === null;
  const failedCount = meeting.segment_counts.failed;
  const hasEnhanced = (transcript ?? []).some(
    (s) => s.enhancedText !== undefined,
  );
  // specs/meeting-speaker-naming.md §9.2: an already-generated summary is a
  // persisted artifact, not live-computed, so confirming a name after
  // summarizing doesn't retroactively change existing summary text — show a
  // note instead, computed from data already loaded (no new endpoint).
  const summaryStaleNames = Boolean(
    meeting.summary?.markdown &&
      meeting.summary.created_at !== null &&
      speakersData?.latestSpeakerUpdate != null &&
      meeting.summary.created_at < speakersData.latestSpeakerUpdate,
  );
  const transcriptText = (transcript ?? [])
    .map((s) => {
      // specs/meeting-speaker-naming.md §4: prefer a confirmed speakerName
      // over the numbered fallback; a "Them" segment with no speakerLabel
      // at all renders "Unidentified" (§3.3 amendment), never bare "Them".
      const label =
        s.speaker === "Me"
          ? t("meetings.me")
          : (s.speakerName ??
            (s.speakerLabel
              ? t("meetings.themNumbered", { n: s.speakerLabel })
              : t("meetings.speakerUnidentified")));
      const text = showEnhanced ? (s.enhancedText ?? s.text) : s.text;
      return `${label}: ${text}`;
    })
    .join("\n");

  return (
    <div>
      <div className="mb-5 flex items-center gap-2.5">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label={t("meetings.back")}
          // The list rail is always visible at >=900px (master-detail), so
          // "back" only means something in the narrow single-pane fallback.
          className="min-[900px]:hidden"
        >
          <ChevronLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <EditableTitle id={id} title={meeting.title} onRenamed={invalidate} />
          <div className="text-muted-foreground text-[11px]">
            {formatTimestamp(meeting.started_at)} ·{" "}
            {formatDuration(meeting.duration_ms)}
          </div>
          <MeetingContextField
            id={id}
            context={meeting.context}
            onChanged={invalidate}
          />
        </div>
        <MeetingLanguageChip
          id={id}
          language={meeting.language}
          onChanged={invalidate}
        />
        <StatusBadge status={meeting.status} />
      </div>

      {/* Actions */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button
          variant="ink"
          size="sm"
          onClick={() => void transcribe()}
          disabled={!canTranscribe}
        >
          <AudioLines data-icon="inline-start" />
          {hasTranscript
            ? t("meetings.retranscribe")
            : t("meetings.transcribe")}
        </Button>
        {hasTranscript && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleIdentifySpeakersClick}
            disabled={busy !== null}
          >
            <Users data-icon="inline-start" />
            {busy === "diarize"
              ? t("meetings.identifyingSpeakers")
              : t("meetings.identifySpeakers")}
          </Button>
        )}
        {hasTranscript && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSpeakersOpen(true)}
          >
            <UserCog data-icon="inline-start" />
            {t("meetings.speakers")}
          </Button>
        )}
        {hasTranscript && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void enhance()}
            disabled={busy !== null}
          >
            <WandSparkles data-icon="inline-start" />
            {busy === "enhance"
              ? t("meetings.enhancing")
              : hasEnhanced
                ? t("meetings.reEnhance")
                : t("meetings.enhance")}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void summarize()}
          disabled={!hasTranscript || busy !== null}
        >
          <Sparkles data-icon="inline-start" />
          {busy === "summarize"
            ? t("meetings.summarizing")
            : meeting.summary
              ? t("meetings.resummarize")
              : t("meetings.summarize")}
        </Button>
        {failedCount > 0 && !transcribing && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void retryFailed()}
            disabled={busy !== null}
          >
            <RefreshCw data-icon="inline-start" />
            {t("meetings.retryFailed", { n: failedCount })}
          </Button>
        )}
        <div className="flex-1" />
        <SummaryInstructionsPopover />
        <Button
          variant="outline"
          size="icon-sm"
          disabled={!meeting.audio_dir}
          onClick={() => void window.api?.revealMeetingInFinder?.(id)}
          aria-label={t("meetings.revealInFinder")}
          title={t("meetings.revealInFinder")}
        >
          <FolderOpen />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
          aria-label={t("meetings.delete")}
          title={t("meetings.delete")}
        >
          <Trash2 />
        </Button>
      </div>

      {transcribing && (
        <Card className="mb-5 p-4">
          <div className="flex items-center gap-3">
            <RefreshCw className="text-primary h-3.5 w-3.5 animate-spin" />
            <div className="flex-1">
              <div className="text-foreground text-[12.5px]">
                {t("meetings.transcribing")}
              </div>
              {meeting.job && meeting.job.total > 0 && (
                <Progress
                  value={(meeting.job.done / meeting.job.total) * 100}
                  className="mt-2 h-1"
                />
              )}
            </div>
            {meeting.job && meeting.job.total > 0 && (
              <span className="mono text-muted-foreground text-[10px] tabular-nums">
                {meeting.job.done}/{meeting.job.total}
              </span>
            )}
          </div>
        </Card>
      )}

      {(meeting.error || actionError) && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive mb-5 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[12px]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{actionError ?? meeting.error}</span>
        </div>
      )}

      {diarizeResult && !actionError && (
        <div className="border-border bg-card/30 text-foreground mb-5 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[12px]">
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {diarizeResult.speakerCount === 0
              ? t("meetings.diarizeNoSpeakers")
              : t("meetings.diarizeResult", { n: diarizeResult.speakerCount })}
            {diarizeResult.speakerCount === 1 &&
              ` ${t("meetings.diarizeSingleSpeakerNote")}`}
          </span>
        </div>
      )}

      {enhanceResult && !actionError && (
        <div className="border-border bg-card/30 text-foreground mb-5 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[12px]">
          <WandSparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {enhanceResult.correctedCount === 0
              ? t("meetings.enhanceNoneCorrected")
              : t("meetings.enhanceResult", {
                  n: enhanceResult.correctedCount,
                })}
          </span>
        </div>
      )}

      <Tabs defaultValue="transcript">
        <TabsList>
          <TabsTrigger value="transcript">
            {t("meetings.tabTranscript")}
          </TabsTrigger>
          <TabsTrigger value="summary">{t("meetings.tabSummary")}</TabsTrigger>
        </TabsList>

        <TabsContent value="transcript" className="mt-4">
          {transcript && transcript.length > 0 ? (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                {hasEnhanced ? (
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={showEnhanced}
                      onCheckedChange={setShowEnhanced}
                      aria-label={t("meetings.showEnhancedLabel")}
                    />
                    <span className="text-muted-foreground text-[11px]">
                      {showEnhanced
                        ? t("meetings.showingEnhanced")
                        : t("meetings.showingRaw")}
                    </span>
                  </div>
                ) : (
                  <div />
                )}
                <CopyButton
                  text={transcriptText}
                  label={t("meetings.copyTranscript")}
                />
              </div>
              <div className="flex flex-col gap-3.5">
                {transcript.map((seg) => (
                  <div
                    key={`${seg.speaker}-${seg.startMs}-${seg.endMs}`}
                    className="flex gap-3"
                  >
                    <span className="w-16 shrink-0 pt-0.5 text-right leading-none">
                      <span
                        className={cn(
                          "mono inline-flex items-center whitespace-nowrap rounded-[5px] px-[7px] py-[2.5px] text-[9px] font-medium uppercase tracking-[0.1em]",
                          seg.speaker === "Me"
                            ? "bg-transparent px-0 font-semibold text-foreground"
                            : seg.speakerLabel
                              ? // Confirmed name or numbered-but-unnamed "Them
                                // N" — a real, distinguishable speaker — gets
                                // the full accent-passive treatment (specs/
                                // meeting-speaker-naming.md §7.5).
                                "bg-[var(--accent-passive-tint)] text-[color:var(--accent-passive-ink)]"
                              : // Unidentified: a materially weaker claim
                                // (the diarizer couldn't attribute this line
                                // to anyone at all) — a muted outline, never
                                // the accent-passive fill (§3.3/§7.5).
                                "border border-border bg-transparent text-muted-foreground",
                        )}
                      >
                        {seg.speaker === "Me"
                          ? t("meetings.me")
                          : (seg.speakerName ??
                            (seg.speakerLabel
                              ? t("meetings.themNumbered", {
                                  n: seg.speakerLabel,
                                })
                              : t("meetings.speakerUnidentified")))}
                      </span>
                    </span>
                    <p className="text-foreground m-0 flex-1 text-[13.5px] leading-[1.55]">
                      {showEnhanced ? (seg.enhancedText ?? seg.text) : seg.text}
                    </p>
                    <span className="mono text-muted-foreground/60 shrink-0 pt-0.5 text-[9px] tabular-nums">
                      {formatClockMs(seg.startMs)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="border-border bg-card/30 rounded-lg border border-dashed px-6 py-10 text-center">
              <p className="text-muted-foreground m-0 text-[13px]">
                {!hasTranscript
                  ? t("meetings.transcriptPending")
                  : // Distinguish "confirmed empty" from "haven't refetched this
                    // job's result yet" — isFetching or an as-yet-undefined
                    // cache entry means the query hasn't resolved for the
                    // *current* transcribed state, so transcriptEmpty must
                    // wait for a settled, non-fetching, genuinely zero-length
                    // result (see the transcript useQuery comment above).
                    isTranscriptFetching || transcript === undefined
                    ? t("meetings.transcriptLoading")
                    : t("meetings.transcriptEmpty")}
              </p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="summary" className="mt-4">
          {meeting.summary?.markdown ? (
            <>
              {summaryStaleNames && (
                <div className="border-border bg-card/30 text-muted-foreground mb-3 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[12px]">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t("meetings.summaryStaleNames")}</span>
                </div>
              )}
              <div className="mb-3 flex justify-end">
                <CopyButton
                  text={meeting.summary.markdown}
                  label={t("meetings.copySummary")}
                />
              </div>
              <Markdown source={meeting.summary.markdown} />
            </>
          ) : (
            <div className="border-border bg-card/30 rounded-lg border border-dashed px-6 py-10 text-center">
              <p className="text-muted-foreground m-0 text-[13px]">
                {t("meetings.summaryEmpty")}
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("meetings.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("meetings.deleteDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("meetings.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void deleteMeeting()}
            >
              {t("meetings.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SpeakersDialog
        id={id}
        open={speakersOpen}
        onOpenChange={setSpeakersOpen}
        data={speakersData}
        onSaved={() => {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.meetings.speakers(id),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.meetings.transcript(id),
          });
        }}
      />

      <AlertDialog
        open={rediarizeConfirmOpen}
        onOpenChange={setRediarizeConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("meetings.speakerResetOnRediarizeTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("meetings.speakerResetOnRediarizeDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("meetings.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void identifySpeakers()}>
              {t("meetings.identifySpeakers")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function MeetingsEmptyState(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="border-border bg-card rounded-lg border border-dashed px-9 py-[52px] text-center">
      <div className="bg-accent mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl">
        <AudioLines className="text-primary h-6 w-6" />
      </div>
      <h2 className="display text-foreground m-0 text-[26px] font-medium leading-none">
        {t("meetings.emptyTitle")}
      </h2>
      <p className="text-muted-foreground mx-auto mt-2.5 max-w-[420px] text-[13px] leading-[1.55]">
        {t("meetings.emptyDesc")}
      </p>
    </div>
  );
}

export default function MeetingsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const recorder = useRecorder();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Feature-flagged: the nav entry is already gated, but a direct URL must
  // bounce too. Wait for the config load before deciding.
  const { data: config, isLoading: configLoading } = useQuery(
    configQueryOptions(),
  );
  const enabled = config?.flags?.meetings === true;

  const { data: listData } = useQuery({
    queryKey: queryKeys.meetings.list,
    queryFn: async (): Promise<MeetingListItem[]> => {
      const res = await getClient().api.meetings.$get();
      if (!res.ok) return [];
      const body = (await res.json()) as { items: MeetingListItem[] };
      return body.items;
    },
    enabled,
    // A recording in progress or a transcription job elsewhere in the list
    // should surface without a manual refresh.
    refetchInterval: (query) =>
      query.state.data?.some(
        (m) => m.status === "recording" || m.status === "transcribing",
      )
        ? 2000
        : false,
  });

  const meetings = useMemo(() => listData ?? [], [listData]);

  // Master-detail (see below) keeps the right-hand pane non-empty by default
  // once meetings exist, so the persistent list rail never sits next to a
  // blank pane. Captured once, from the first non-empty load only — NOT
  // re-derived from `meetings[0]` on every render, because the list query
  // polls every 2s while anything is recording/transcribing and a fresh
  // recording lands at index 0 (server orders by created_at DESC). Re-deriving
  // live would silently swap the detail pane out from under a user who never
  // explicitly picked a meeting. `selectedId` (explicit, user-driven) always
  // wins over this default, and once set here it never changes again.
  const [defaultId, setDefaultId] = useState<string | null>(null);
  useEffect(() => {
    if (defaultId === null && meetings.length > 0) {
      setDefaultId(meetings[0].id);
    }
  }, [meetings, defaultId]);
  const activeId = selectedId ?? defaultId;

  // Only probe ahead of the FIRST recording: list loaded, empty, recorder
  // supported and idle.
  const showAudioHint = useSystemAudioProbe(
    enabled &&
      recorder.supported &&
      recorder.status === "idle" &&
      listData !== undefined &&
      meetings.length === 0,
  );

  if (!configLoading && !enabled) {
    return <Navigate to="/today" replace />;
  }

  // Nothing to show a detail pane for yet — keep the original single-pane
  // first-run flow (hero title, record card, empty state) rather than
  // rendering a master-detail grid with an empty rail next to a lone empty
  // card. Also covers the pre-load instant, same as before this change.
  if (meetings.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <DragSpacer />
        <div
          className="responsive-page-scroll flex-1 overflow-auto pt-5"
          style={{ scrollbarWidth: "none" } as React.CSSProperties}
        >
          <div className="mx-auto max-w-[760px]">
            <div className="mb-2 flex items-start justify-between gap-3">
              <h1 className="display text-foreground m-0 text-[32px] font-medium leading-tight tracking-[-0.02em]">
                {t("meetings.titleAccent")}
              </h1>
              <div className="pt-2">
                <DiarizationSettingsPopover />
              </div>
            </div>
            <p className="text-muted-foreground mb-6 max-w-[480px] text-[13px] leading-[1.5]">
              {t("meetings.subtitle")}
            </p>

            {showAudioHint && <SystemAudioHint />}

            <RecordingCard recorder={recorder} />

            <MeetingsEmptyState />
          </div>
        </div>
      </div>
    );
  }

  // Master-detail (mockup artboard 02): persistent list rail + detail pane at
  // >=900px (same collapse breakpoint settings.tsx already uses for its own
  // rail+content split). Below that, CSS-only collapse to the old
  // single-pane flow: `max-[899px]:hidden` on whichever pane isn't the
  // user's current focus, driven purely by `selectedId` so the narrow-width
  // behavior (land on the list, tap a row to drill in, back returns to the
  // list) is byte-for-byte what it was before this change.
  const hideListAtNarrow = Boolean(selectedId);
  const hideDetailAtNarrow = !selectedId;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DragSpacer />
      <div
        className="responsive-page-scroll flex-1 overflow-auto pt-5"
        style={{ scrollbarWidth: "none" } as React.CSSProperties}
      >
        {showAudioHint && <SystemAudioHint />}

        <div className="grid min-h-full grid-cols-1 gap-6 min-[900px]:grid-cols-[262px_minmax(0,1fr)]">
          <aside
            className={cn(
              "min-w-0 min-[900px]:border-border min-[900px]:border-r min-[900px]:pr-6",
              hideListAtNarrow && "max-[899px]:hidden",
            )}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="eyebrow">{t("meetings.titleAccent")}</span>
              <DiarizationSettingsPopover />
            </div>

            <RecordingCard recorder={recorder} compact />

            <div className="flex flex-col gap-0.5">
              {meetings.map((m) => {
                const selected = selectedId === m.id;
                // Visual parity for the implicit default selection — only at
                // >=900px, where the detail pane is actually showing it. At
                // narrow widths this row hasn't really been "opened" (the
                // list is what's visible), so it stays unhighlighted there.
                const implicitlyActive = !selectedId && activeId === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSelectedId(m.id)}
                    className={cn(
                      "flex min-w-0 flex-col gap-1 rounded-[9px] border border-transparent px-3 py-2.5 text-left transition-colors",
                      "hover:bg-card/60",
                      selected && "bg-card border-border",
                      implicitlyActive &&
                        "min-[900px]:bg-card min-[900px]:border-border",
                    )}
                  >
                    <span className="text-foreground min-w-0 truncate text-[12.5px] font-medium">
                      {m.title || t("meetings.untitled")}
                    </span>
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="mono text-muted-foreground/70 min-w-0 truncate text-[10px]">
                        {formatTimestamp(m.started_at)} ·{" "}
                        {formatDuration(m.duration_ms)}
                      </span>
                      <StatusBadge status={m.status} />
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div
            className={cn(
              "min-w-0",
              hideDetailAtNarrow && "max-[899px]:hidden",
            )}
          >
            {activeId && (
              <MeetingDetailView
                key={activeId}
                id={activeId}
                onBack={() => setSelectedId(null)}
                onDeleted={() => setSelectedId(null)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
