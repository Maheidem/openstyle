import {
  LanguageList,
  useLanguageOptions,
} from "@renderer/components/language-combobox";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@renderer/components/ui/popover";
import { Textarea } from "@renderer/components/ui/textarea";
import { getClient } from "@renderer/lib/api";
import { Languages, Pencil } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function EditableTitle({
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
export function MeetingContextField({
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
export function MeetingLanguageChip({
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
