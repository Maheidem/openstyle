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
  readOnly,
  onDuplicate,
}: {
  /** `undefined` when editing a task's inline Custom JSON (no name field). */
  name?: string;
  onNameChange?: (next: string) => void;
  value: Record<string, unknown>;
  /** Called only with valid, parsed JSON — never with a malformed draft. */
  onChange: (next: Record<string, unknown>) => void;
  onClose: () => void;
  /** True for a `builtin:*` preset (§4.2) — shows "Duplicate to edit" instead of Save. */
  readOnly?: boolean;
  onDuplicate?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  // Re-seed the draft whenever the caller hands us a different value (e.g.
  // switching which task/preset this instance is editing).
  useEffect(() => {
    setDraft(JSON.stringify(value, null, 2));
    setError(null);
  }, [value]);

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
            disabled={readOnly}
            maxLength={60}
          />
        </div>
      )}

      <Textarea
        className="mono min-h-40 text-[12.5px]"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        readOnly={readOnly}
        aria-invalid={error ? true : undefined}
        spellCheck={false}
      />
      {error && (
        <p className="text-destructive text-[11.5px] leading-snug">{error}</p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        {readOnly ? (
          <Button variant="ink" size="sm" onClick={onDuplicate}>
            {t("models.taskProfiles.duplicateToEdit")}
          </Button>
        ) : (
          <Button variant="ink" size="sm" onClick={onSave} disabled={!!error}>
            {t("common.save")}
          </Button>
        )}
      </div>
    </div>
  );
}
