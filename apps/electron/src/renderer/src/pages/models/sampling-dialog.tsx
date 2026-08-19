import {
  CLEANUP_SAMPLING_MAX_TOKENS_LIMIT,
  type CleanupSampling,
} from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { Slider } from "@renderer/components/ui/slider";
import { Switch } from "@renderer/components/ui/switch";
import { SlidersHorizontal } from "lucide-react";

// ---------------------------------------------------------------------------
// CleanupSamplingDialog — sampling parameters for the local cleanup server.
//
// These go onto the chat-completions body verbatim: the AI SDK has no route
// for top_k, min_p, repetition_penalty or chat_template_kwargs, so a custom
// fetch on the `local-llm` provider merges them in. Provider-wide, so they
// apply to cleanup, Remix and plugin calls alike.
// ---------------------------------------------------------------------------

/**
 * Shown when the stored setting leaves a field unset. Every numeric default is
 * a no-op, and thinking is shown as on because that is what the model does
 * when nothing is sent — so opening this dialog and nudging one slider never
 * silently changes anything else.
 */
const DISPLAY_DEFAULTS = {
  temperature: 0,
  top_p: 1,
  top_k: 0,
  min_p: 0,
  repetition_penalty: 1,
  presence_penalty: 0,
  enable_thinking: true,
  preserve_thinking: false,
} as const;

const SERVER_DEFAULT = "__server__";

const EFFORT_OPTIONS = ["none", "low", "medium", "high"];

function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

export function CleanupSamplingDialog({
  sampling,
  onChange,
  onReset,
  onClose,
}: {
  sampling: CleanupSampling;
  onChange: (next: CleanupSampling) => void;
  onReset: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const kwargs = sampling.chat_template_kwargs ?? {};
  const thinking = kwargs.enable_thinking ?? DISPLAY_DEFAULTS.enable_thinking;

  // Every edit rewrites the whole object, so what the dialog shows is exactly
  // what goes on the wire. The three optional fields drop out when left blank.
  const emit = (patch: Partial<CleanupSampling>): void => {
    const next: CleanupSampling = {
      temperature: num(sampling.temperature, DISPLAY_DEFAULTS.temperature),
      top_p: num(sampling.top_p, DISPLAY_DEFAULTS.top_p),
      top_k: num(sampling.top_k, DISPLAY_DEFAULTS.top_k),
      min_p: num(sampling.min_p, DISPLAY_DEFAULTS.min_p),
      repetition_penalty: num(
        sampling.repetition_penalty,
        DISPLAY_DEFAULTS.repetition_penalty,
      ),
      presence_penalty: num(
        sampling.presence_penalty,
        DISPLAY_DEFAULTS.presence_penalty,
      ),
      ...(sampling.max_tokens != null
        ? { max_tokens: sampling.max_tokens }
        : {}),
      ...(sampling.thinking_budget != null
        ? { thinking_budget: sampling.thinking_budget }
        : {}),
      ...(sampling.reasoning_effort
        ? { reasoning_effort: sampling.reasoning_effort }
        : {}),
      chat_template_kwargs: {
        enable_thinking: thinking,
        preserve_thinking:
          kwargs.preserve_thinking ?? DISPLAY_DEFAULTS.preserve_thinking,
        ...(kwargs.reasoning_effort
          ? { reasoning_effort: kwargs.reasoning_effort }
          : {}),
      },
      ...patch,
    };
    onChange(next);
  };

  const emitKwargs = (
    patch: Partial<NonNullable<CleanupSampling["chat_template_kwargs"]>>,
  ): void => {
    const merged = {
      enable_thinking: thinking,
      preserve_thinking:
        kwargs.preserve_thinking ?? DISPLAY_DEFAULTS.preserve_thinking,
      ...(kwargs.reasoning_effort
        ? { reasoning_effort: kwargs.reasoning_effort }
        : {}),
      ...patch,
    };
    // A cleared select drops the key rather than sending an empty string.
    if (!merged.reasoning_effort) delete merged.reasoning_effort;
    emit({ chat_template_kwargs: merged });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-2.5">
            <SlidersHorizontal className="text-primary h-4 w-4 shrink-0" />
            <DialogTitle>Sampling</DialogTitle>
          </div>
        </DialogHeader>

        <p className="text-muted-foreground text-[12.5px] leading-relaxed">
          Sent with every request to your local server — cleanup, Remix and
          plugins alike. Leave everything at its default to send nothing extra.
        </p>

        <div className="space-y-5">
          <SliderRow
            label="Temperature"
            value={num(sampling.temperature, DISPLAY_DEFAULTS.temperature)}
            min={0}
            max={2}
            step={0.05}
            hint="0 is deterministic. Higher wanders more."
            onChange={(v) => emit({ temperature: v })}
          />
          <SliderRow
            label="Top P"
            value={num(sampling.top_p, DISPLAY_DEFAULTS.top_p)}
            min={0}
            max={1}
            step={0.01}
            hint="Nucleus sampling. 1 considers every token."
            onChange={(v) => emit({ top_p: v })}
          />
          <SliderRow
            label="Min P"
            value={num(sampling.min_p, DISPLAY_DEFAULTS.min_p)}
            min={0}
            max={0.5}
            step={0.01}
            hint="Floor on token probability, relative to the top token. 0 is off."
            onChange={(v) => emit({ min_p: v })}
          />
          <SliderRow
            label="Repetition penalty"
            value={num(
              sampling.repetition_penalty,
              DISPLAY_DEFAULTS.repetition_penalty,
            )}
            min={1}
            max={1.5}
            step={0.01}
            hint="Above ~1.2 the model starts avoiding words it needs."
            onChange={(v) => emit({ repetition_penalty: v })}
          />
          <SliderRow
            label="Presence penalty"
            value={num(
              sampling.presence_penalty,
              DISPLAY_DEFAULTS.presence_penalty,
            )}
            min={-2}
            max={2}
            step={0.1}
            hint="Pushes the model toward new topics. 0 is off."
            onChange={(v) => emit({ presence_penalty: v })}
          />

          <NumberRow
            label="Top K"
            value={num(sampling.top_k, DISPLAY_DEFAULTS.top_k)}
            min={0}
            max={500}
            placeholder="0"
            hint="Keep only the K most likely tokens. 0 is off."
            onChange={(v) => emit({ top_k: v ?? DISPLAY_DEFAULTS.top_k })}
          />

          <div className="border-border space-y-5 border-t pt-5">
            <SwitchRow
              label="Thinking"
              checked={thinking}
              hint="Let the model reason before answering. Reasoning is emitted on top of the answer, so give it output budget below."
              onChange={(v) => emitKwargs({ enable_thinking: v })}
            />
            <NumberRow
              label="Minimum output budget"
              value={sampling.max_tokens ?? null}
              min={1}
              max={CLEANUP_SAMPLING_MAX_TOKENS_LIMIT}
              placeholder="Auto (512–8192, scaled to the transcript)"
              hint="A floor, not a cap. Raise it when thinking is on. A larger automatic budget still wins, so rewriting long text is never cut short."
              onChange={(v) => emit({ max_tokens: v ?? undefined })}
            />
            <NumberRow
              label="Thinking budget"
              value={sampling.thinking_budget ?? null}
              min={0}
              max={CLEANUP_SAMPLING_MAX_TOKENS_LIMIT}
              placeholder="Server default"
              hint="Caps reasoning separately, so the answer always has room left."
              onChange={(v) => emit({ thinking_budget: v ?? undefined })}
            />
            <SelectRow
              label="Reasoning effort"
              value={sampling.reasoning_effort ?? SERVER_DEFAULT}
              hint="Top-level field. Higher effort means more reasoning tokens."
              onChange={(v) =>
                emit({
                  reasoning_effort: v === SERVER_DEFAULT ? undefined : v,
                })
              }
            />
            <SelectRow
              label="Reasoning effort (chat template)"
              value={kwargs.reasoning_effort ?? SERVER_DEFAULT}
              hint="The template's own field. Separate from the one above."
              onChange={(v) =>
                emitKwargs({
                  reasoning_effort: v === SERVER_DEFAULT ? undefined : v,
                })
              }
            />
            <SwitchRow
              label="Preserve thinking"
              checked={
                kwargs.preserve_thinking ?? DISPLAY_DEFAULTS.preserve_thinking
              }
              hint="Keep earlier reasoning in the conversation instead of dropping it."
              onChange={(v) => emitKwargs({ preserve_thinking: v })}
            />
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" onClick={onReset}>
            Reset to defaults
          </Button>
          <Button variant="ink" size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowShell({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value?: string;
  hint: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-foreground text-[13px] font-medium">{label}</span>
        {value !== undefined && (
          <span className="mono text-muted-foreground text-[11.5px]">
            {value}
          </span>
        )}
      </div>
      {children}
      <p className="text-muted-foreground mt-1.5 text-[11.5px] leading-snug">
        {hint}
      </p>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hint: string;
  onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <RowShell label={label} value={value.toFixed(2)} hint={hint}>
      <Slider
        value={[value]}
        onValueChange={([v]) => {
          if (v !== undefined) onChange(Number(v.toFixed(2)));
        }}
        min={min}
        max={max}
        step={step}
        aria-label={label}
      />
    </RowShell>
  );
}

function NumberRow({
  label,
  value,
  min,
  max,
  placeholder,
  hint,
  onChange,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  placeholder: string;
  hint: string;
  onChange: (value: number | null) => void;
}): React.JSX.Element {
  return (
    <RowShell label={label} hint={hint}>
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") {
            onChange(null);
            return;
          }
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) return;
          // Clamp to the schema's bounds. Without this the server rejects the
          // PUT with a 400 that only reaches the console, leaving the dialog
          // showing a value the database never took.
          onChange(Math.min(Math.max(Math.trunc(parsed), min), max));
        }}
        aria-label={label}
      />
    </RowShell>
  );
}

function SwitchRow({
  label,
  checked,
  hint,
  onChange,
}: {
  label: string;
  checked: boolean;
  hint: string;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-foreground text-[13px] font-medium">{label}</div>
        <p className="text-muted-foreground mt-1 text-[11.5px] leading-snug">
          {hint}
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
        className="mt-0.5 shrink-0"
      />
    </div>
  );
}

function SelectRow({
  label,
  value,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  hint: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <RowShell label={label} hint={hint}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SERVER_DEFAULT}>Server default</SelectItem>
          {EFFORT_OPTIONS.map((effort) => (
            <SelectItem key={effort} value={effort}>
              {effort}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </RowShell>
  );
}
