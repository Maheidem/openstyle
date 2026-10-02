import { LLM_PRESET_NAME_MAX } from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// ---------------------------------------------------------------------------
// ParamJsonEditor — the raw-JSON editor that replaces `CleanupSamplingDialog`
// entirely (specs/llm-task-profiles.md §9.4, §10). One component reused for
// "edit a named preset" (shows a Name input) and "edit this task's Custom
// JSON" (no Name field). No structured controls of any kind — a user who
// wants the same knobs the old dialog built for them types the same keys.
// ---------------------------------------------------------------------------

export function ParamJsonEditor({
  name,
  onNameChange,
  value,
  onChange,
  onClose,
  saveLabel,
  saving,
}: {
  /** `undefined` when editing a task's inline Custom JSON (no name field). */
  name?: string;
  onNameChange?: (next: string) => void;
  value: Record<string, unknown>;
  /** Called only with valid, parsed JSON — never with a malformed draft. */
  onChange: (next: Record<string, unknown>) => void;
  onClose: () => void;
  /** Overrides the Save label. Used when saving does not overwrite what the
   *  user was looking at — "Save as copy" for a `builtin:*` preset (§4.2). */
  saveLabel?: string;
  /** In-flight write from the caller. Built-ins are auto-copied by the
   *  caller (§4.2, §9.3), so this editor is ALWAYS editable — there is no
   *  read-only variant. Default `false` keeps non-writing callers (a task's
   *  inline Custom JSON) inert; while `true` both buttons are disabled, so
   *  neither a second Save nor a dismiss can land mid-write. */
  saving?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const seed = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(seed);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the draft when the caller hands us a different value (e.g.
  // switching which task/preset this instance is editing). The effect keys
  // on the serialized text, not the object. A caller that passes a new `{}`
  // on each render must not erase what the user typed.
  useEffect(() => {
    setDraft(seed);
    setError(null);
  }, [seed]);

  const validate = (raw: string): Record<string, unknown> | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setError(t("models.taskProfiles.invalidJson"));
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      setError(t("models.taskProfiles.notAnObject"));
      return null;
    }
    setError(null);
    return parsed as Record<string, unknown>;
  };

  const onDraftChange = (raw: string): void => {
    setDraft(raw);
    validate(raw);
  };

  // `saving` guards the write: the caller's save is optimistic with a revert
  // from a ref snapshot that mirrors state one commit late, so a double-click
  // or a mid-write dismiss can clobber the rollback (§9.3).
  const onSave = (): void => {
    const parsed = validate(draft);
    if (parsed) onChange(parsed);
  };

  return (
    <div className="space-y-3">
      {name !== undefined && (
        <div>
          <span className="text-foreground mb-1.5 block text-[13px] font-medium">
            {t("models.taskProfiles.presetNameLabel")}
          </span>
          <Input
            value={name}
            onChange={(e) => onNameChange?.(e.target.value)}
            maxLength={LLM_PRESET_NAME_MAX}
          />
        </div>
      )}

      <Textarea
        className="mono min-h-40 text-[12.5px]"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        spellCheck={false}
      />
      {error && (
        <p className="text-destructive text-[11.5px] leading-snug">{error}</p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="ink"
          size="sm"
          onClick={onSave}
          disabled={!!error || saving}
        >
          {saveLabel ?? t("common.save")}
        </Button>
      </div>
    </div>
  );
}
