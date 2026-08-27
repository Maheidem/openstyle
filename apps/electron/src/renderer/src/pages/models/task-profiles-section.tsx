import type {
  LlmParameterPreset,
  LlmTaskAssignment,
  LlmTaskAssignmentMode,
  LlmTaskId,
} from "@openstyle/validations";
import { BUILTIN_LLM_PRESETS, SAFE_SUBSET_KEYS } from "@openstyle/validations";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@renderer/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { cn } from "@renderer/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Eyebrow } from "./page-chrome";
import { ParamJsonEditor } from "./param-json-editor";
import type { ConfiguredModel } from "./types";
import { displayName } from "./utils";

// ---------------------------------------------------------------------------
// TaskProfilesSection — "Where your models work" (specs/llm-task-profiles.md
// §9). One row per task; each row assigns Auto / a preset / Custom JSON, and
// optionally overrides which model this task uses.
// ---------------------------------------------------------------------------

const TASK_IDS: readonly LlmTaskId[] = [
  "cleanup",
  "remix",
  "meetingSummarize",
  "meetingEnhance",
];

// Only `local-llm` is the verbatim transport tier (§7.1) — every other
// provider is mapped-subset. Mirrors `apps/server/src/lib/llm/registry.ts`'s
// `PROVIDERS`; duplicated here in miniature because "which provider is
// local" isn't part of the shared `@openstyle/validations` surface the way
// `SAFE_SUBSET_KEYS` is.
const LOCAL_PROVIDER_IDS = new Set(["local-llm"]);

const CUSTOM_VALUE = "__custom__";
const NEW_PRESET_VALUE = "__new__";
// Radix `Select` reserves `""` internally to mean "no selection" and throws
// if an item uses it as its value — same reason the retired
// `CleanupSamplingDialog` used its own `SERVER_DEFAULT` sentinel
// (sampling-dialog.tsx, deleted by §10) instead of "".
const USE_DEFAULT_MODEL_VALUE = "__default__";

function newPresetId(): string {
  return `user_${crypto.randomUUID()}`;
}

function isMappedSubset(providerId: string | undefined): boolean {
  return !!providerId && !LOCAL_PROVIDER_IDS.has(providerId);
}

/** §7.5 — a task shows "cloud model: partial" when its effective model is
 *  mapped-subset tier and its resolved params carry a key that tier drops. */
function computeCloudPartial(
  providerId: string | undefined,
  params: Record<string, unknown>,
): boolean {
  if (!isMappedSubset(providerId)) return false;
  return Object.keys(params).some((k) => !SAFE_SUBSET_KEYS.has(k));
}

type EditorState =
  | { kind: "newPreset"; from?: LlmParameterPreset }
  | { kind: "viewBuiltin"; preset: LlmParameterPreset };

export function TaskProfilesSection({
  taskAssignments,
  userPresets,
  configured,
  defaultLlm,
  cleanupSampling,
  expandedTask,
  onExpandedTaskChange,
  onSaveAssignment,
  onResetAssignment,
  onSavePreset,
}: {
  taskAssignments: Partial<Record<LlmTaskId, LlmTaskAssignment>>;
  userPresets: LlmParameterPreset[];
  configured: ConfiguredModel[];
  defaultLlm: ConfiguredModel | undefined;
  /** The retired global `cleanup_sampling` blob — see §12.7's read-time
   *  fallback. `{}` when there's nothing to fall back to. */
  cleanupSampling: Record<string, unknown>;
  expandedTask: LlmTaskId | null;
  onExpandedTaskChange: (task: LlmTaskId | null) => void;
  onSaveAssignment: (taskId: LlmTaskId, assignment: LlmTaskAssignment) => void;
  onResetAssignment: (taskId: LlmTaskId) => void;
  onSavePreset: (preset: LlmParameterPreset) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const mergedPresets = [...BUILTIN_LLM_PRESETS, ...userPresets];
  const llmModels = configured.filter((c) => c.type === "llm");
  const cleanupLegacyFallback = Object.keys(cleanupSampling).length > 0;

  return (
    <section>
      <div className="mb-3">
        <Eyebrow text={t("models.taskProfiles.eyebrow")} />
      </div>
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        {TASK_IDS.map((taskId, i) => {
          const migratedFromLegacy =
            taskId === "cleanup" &&
            !taskAssignments.cleanup &&
            cleanupLegacyFallback;
          const assignment: LlmTaskAssignment =
            taskAssignments[taskId] ??
            (migratedFromLegacy
              ? { mode: "custom", params: cleanupSampling }
              : { mode: "auto" });

          return (
            <TaskRow
              key={taskId}
              taskId={taskId}
              first={i === 0}
              assignment={assignment}
              migratedFromLegacy={migratedFromLegacy}
              presets={mergedPresets}
              llmModels={llmModels}
              defaultLlm={defaultLlm}
              expanded={expandedTask === taskId}
              onToggleExpand={() =>
                onExpandedTaskChange(expandedTask === taskId ? null : taskId)
              }
              onSaveAssignment={(next) => onSaveAssignment(taskId, next)}
              onResetAssignment={() => onResetAssignment(taskId)}
              onSavePreset={onSavePreset}
            />
          );
        })}
      </div>
    </section>
  );
}

function TaskRow({
  taskId,
  first,
  assignment,
  migratedFromLegacy,
  presets,
  llmModels,
  defaultLlm,
  expanded,
  onToggleExpand,
  onSaveAssignment,
  onResetAssignment,
  onSavePreset,
}: {
  taskId: LlmTaskId;
  first: boolean;
  assignment: LlmTaskAssignment;
  migratedFromLegacy: boolean;
  presets: LlmParameterPreset[];
  llmModels: ConfiguredModel[];
  defaultLlm: ConfiguredModel | undefined;
  expanded: boolean;
  onToggleExpand: () => void;
  onSaveAssignment: (assignment: LlmTaskAssignment) => void;
  onResetAssignment: () => void;
  onSavePreset: (preset: LlmParameterPreset) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [editor, setEditor] = useState<EditorState | null>(null);

  const preset =
    assignment.mode === "preset"
      ? presets.find((p) => p.id === assignment.presetId)
      : undefined;
  const params: Record<string, unknown> =
    assignment.mode === "preset"
      ? (preset?.params ?? {})
      : assignment.mode === "custom"
        ? (assignment.params ?? {})
        : {};

  const effectiveProvider =
    assignment.modelOverride?.provider ?? defaultLlm?.provider;
  const cloudPartial =
    assignment.mode !== "auto" &&
    computeCloudPartial(effectiveProvider, params);

  const segmentedOptions: SegmentedOption[] = [
    { value: "auto", label: t("models.taskProfiles.assignmentAuto") },
    ...presets.map((p) => ({ value: p.id, label: p.name })),
    { value: CUSTOM_VALUE, label: t("models.taskProfiles.customOption") },
    {
      value: NEW_PRESET_VALUE,
      label: `+ ${t("models.taskProfiles.newPreset")}`,
    },
  ];
  const segmentedValue: string =
    assignment.mode === "preset"
      ? (assignment.presetId ?? "auto")
      : assignment.mode === "custom"
        ? CUSTOM_VALUE
        : "auto";

  const onModeChange = (value: string): void => {
    if (value === NEW_PRESET_VALUE) {
      setEditor({ kind: "newPreset" });
      return;
    }
    if (value === CUSTOM_VALUE) {
      onSaveAssignment({
        mode: "custom",
        params: assignment.mode === "custom" ? (assignment.params ?? {}) : {},
        modelOverride: assignment.modelOverride,
      });
      setEditor(null);
      return;
    }
    if (value === "auto") {
      onSaveAssignment({
        mode: "auto",
        modelOverride: assignment.modelOverride,
      });
      setEditor(null);
      return;
    }
    // A preset id.
    onSaveAssignment({
      mode: "preset",
      presetId: value,
      modelOverride: assignment.modelOverride,
    });
    setEditor(null);
  };

  const onModelOverrideChange = (value: string): void => {
    const modelOverride =
      value === USE_DEFAULT_MODEL_VALUE
        ? undefined
        : (() => {
            const [provider, ...rest] = value.split("/");
            return { provider: provider ?? "", model_id: rest.join("/") };
          })();
    onSaveAssignment({ ...assignment, modelOverride });
  };

  const chipMode: LlmTaskAssignmentMode = assignment.mode;

  return (
    <div className={cn(!first && "border-border border-t")}>
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex w-full items-start justify-between gap-4 px-[18px] py-[13px] text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-[13.5px] font-semibold">
            {t(`models.taskProfiles.${taskId}.name`)}
          </div>
          <div className="text-muted-foreground mt-0.5 text-[11.5px]">
            {t(`models.taskProfiles.${taskId}.desc`)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {cloudPartial && (
            <span className="text-muted-foreground text-[11px]">
              {t("models.taskProfiles.cloudPartialNote")}
            </span>
          )}
          {chipMode === "auto" ? (
            <span className="text-muted-foreground text-[11.5px]">
              {t("models.taskProfiles.assignmentAuto")}
            </span>
          ) : chipMode === "preset" ? (
            <Badge variant="secondary">
              {preset?.name ?? assignment.presetId}
            </Badge>
          ) : (
            <Badge variant="passive">
              {t("models.taskProfiles.assignmentCustomized")}
            </Badge>
          )}
          {expanded ? (
            <ChevronDown className="text-muted-foreground size-4" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-border bg-muted/20 space-y-4 border-t px-[18px] py-4">
          {migratedFromLegacy && (
            <p className="text-muted-foreground text-[11.5px] leading-snug">
              {t("models.taskProfiles.migratedNote")}
            </p>
          )}

          <div>
            <span className="text-foreground mb-1.5 block text-[13px] font-medium">
              {t("models.taskProfiles.paramsLabel")}
            </span>
            <SegmentedControl
              options={segmentedOptions}
              value={segmentedValue}
              onValueChange={onModeChange}
              size="sm"
              wrap
            />
          </div>

          {assignment.mode === "custom" && (
            <ParamJsonEditor
              value={assignment.params ?? {}}
              onChange={(next) =>
                onSaveAssignment({
                  ...assignment,
                  mode: "custom",
                  params: next,
                })
              }
              onClose={onToggleExpand}
            />
          )}

          {editor?.kind === "newPreset" && (
            <NewPresetEditor
              from={editor.from}
              onCancel={() => setEditor(null)}
              onSave={(preset) => {
                onSavePreset(preset);
                onSaveAssignment({
                  mode: "preset",
                  presetId: preset.id,
                  modelOverride: assignment.modelOverride,
                });
                setEditor(null);
              }}
            />
          )}

          {assignment.mode === "preset" &&
            preset &&
            preset.id.startsWith("builtin:") &&
            editor?.kind !== "viewBuiltin" && (
              <Button
                variant="link"
                size="sm"
                className="text-muted-foreground h-auto px-0 text-[12.5px] font-normal"
                onClick={() => setEditor({ kind: "viewBuiltin", preset })}
              >
                {t("models.taskProfiles.duplicateToEdit")}
              </Button>
            )}

          {editor?.kind === "viewBuiltin" && (
            <ParamJsonEditor
              value={editor.preset.params}
              readOnly
              onChange={() => {}}
              onClose={() => setEditor(null)}
              onDuplicate={() => {
                setEditor({ kind: "newPreset", from: editor.preset });
              }}
            />
          )}

          <div>
            <span className="text-foreground mb-1.5 block text-[13px] font-medium">
              {t("models.taskProfiles.modelOverrideLabel")}
            </span>
            <Select
              value={
                assignment.modelOverride
                  ? `${assignment.modelOverride.provider}/${assignment.modelOverride.model_id}`
                  : USE_DEFAULT_MODEL_VALUE
              }
              onValueChange={onModelOverrideChange}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={USE_DEFAULT_MODEL_VALUE}>
                  {t("models.taskProfiles.modelOverrideDefault", {
                    name: defaultLlm?.model_name ?? "—",
                  })}
                </SelectItem>
                {llmModels.map((m) => (
                  <SelectItem
                    key={`${m.provider}/${m.model_id}`}
                    value={`${m.provider}/${m.model_id}`}
                  >
                    {m.model_name} · {displayName(m.provider)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={onResetAssignment}>
              {t("models.taskProfiles.reset")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function NewPresetEditor({
  from,
  onCancel,
  onSave,
}: {
  /** Seeds the draft from an existing preset's payload (§4.2's
   *  "Duplicate to edit" — copy a read-only built-in into an editable
   *  `user_*` preset). Undefined for a plain "+ New preset". */
  from?: LlmParameterPreset;
  onCancel: () => void;
  onSave: (preset: LlmParameterPreset) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState(() => (from ? `${from.name} copy` : ""));

  // `ParamJsonEditor`'s own Save button only fires `onChange` once the
  // textarea holds valid, parsed JSON (§9.4) — that's also the right moment
  // to finalize the new preset, so this wrapper doesn't need a second Save
  // step. A blank name falls back to the "New preset" default rather than
  // blocking the save on a second, undeclared validation rule.
  return (
    <ParamJsonEditor
      name={name}
      onNameChange={setName}
      value={from?.params ?? {}}
      onChange={(params) => {
        const now = new Date().toISOString();
        onSave({
          id: newPresetId(),
          name: name.trim() || t("models.taskProfiles.newPreset"),
          params,
          createdAt: now,
          updatedAt: now,
        });
      }}
      onClose={onCancel}
    />
  );
}
