import type {
  LlmParameterPreset,
  LlmTaskAssignment,
  LlmTaskAssignmentMode,
  LlmTaskId,
} from "@openstyle/validations";
import {
  BUILTIN_LLM_PRESETS,
  LLM_PRESET_NAME_MAX,
  LLM_TASK_IDS,
  SAFE_SUBSET_KEYS,
  SERVER_PROVIDER_ID,
} from "@openstyle/validations";
import { Eyebrow } from "@renderer/components/page-chrome";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@renderer/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import type { ConfiguredModel } from "@renderer/lib/models";
import { cn } from "@renderer/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ParamJsonEditor } from "./param-json-editor";
import type { PresetWriteIssue } from "./preset-ops";
import {
  checkPresetWrite,
  clampPresetName,
  clonePresetParams,
  isBuiltinPresetId,
  isDanglingAssignment,
  makePresetId,
  upsertPreset,
} from "./preset-ops";
import { providerLabel, type ServerView } from "./server-roles";

// ---------------------------------------------------------------------------
// TaskProfilesSection — "Where your models work" (specs/llm-task-profiles.md
// §9). One row per task; each row assigns Auto / a preset / Custom JSON, and
// optionally overrides which model this task uses.
// ---------------------------------------------------------------------------

// Only `server` is the verbatim transport tier (§7.1) — every other
// provider is mapped-subset. Mirrors `apps/server/src/lib/llm/registry.ts`'s
// `PROVIDERS`; duplicated here in miniature because "which provider is
// local" isn't part of the shared `@openstyle/validations` surface the way
// `SAFE_SUBSET_KEYS` is.
const LOCAL_PROVIDER_IDS = new Set([SERVER_PROVIDER_ID]);

const CUSTOM_VALUE = "__custom__";
const NEW_PRESET_VALUE = "__new__";
// Radix `Select` reserves `""` internally to mean "no selection" and throws
// if an item uses it as its value — same reason the retired
// `CleanupSamplingDialog` used its own `SERVER_DEFAULT` sentinel
// (sampling-dialog.tsx, deleted by §10) instead of "".
const USE_DEFAULT_MODEL_VALUE = "__default__";

function newPresetId(): string {
  return makePresetId(crypto.randomUUID());
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

/** The inline editors a task panel can hold (§9.4). `editPreset` covers both
 *  directions of §4.2's amendment: for a `user_*` preset it overwrites in
 *  place, for a `builtin:*` one it writes the auto-copy and re-points this
 *  task at it. `rename` is the same write path with a name-only input. */
type EditorState =
  | { kind: "newPreset" }
  | { kind: "editPreset"; preset: LlmParameterPreset }
  | { kind: "rename"; preset: LlmParameterPreset };

export function TaskProfilesSection({
  taskAssignments,
  userPresets,
  configured,
  servers,
  defaultLlm,
  cleanupSampling,
  expandedTask,
  onExpandedTaskChange,
  onSaveAssignment,
  onResetAssignment,
  onSavePreset,
  onDuplicatePreset,
  onRequestDeletePreset,
}: {
  taskAssignments: Partial<Record<LlmTaskId, LlmTaskAssignment>>;
  userPresets: LlmParameterPreset[];
  configured: ConfiguredModel[];
  servers: ServerView[];
  defaultLlm: ConfiguredModel | undefined;
  /** The retired global `cleanup_sampling` blob — see §12.7's read-time
   *  fallback. `{}` when there's nothing to fall back to. */
  cleanupSampling: Record<string, unknown>;
  expandedTask: LlmTaskId | null;
  onExpandedTaskChange: (task: LlmTaskId | null) => void;
  onSaveAssignment: (taskId: LlmTaskId, assignment: LlmTaskAssignment) => void;
  onResetAssignment: (taskId: LlmTaskId) => void;
  /** `false` = refused (client-side §4.3 guard, or the PUT failed). */
  onSavePreset: (preset: LlmParameterPreset) => Promise<boolean>;
  /** Copy-and-append; never re-points an assignment (see the Duplicate
   *  comment in `use-models.ts`). `null` = refused. */
  onDuplicatePreset: (
    source: LlmParameterPreset,
    copyName: string,
  ) => Promise<LlmParameterPreset | null>;
  /** Opens the confirm dialog owned by `models/index.tsx` (§9.3) — the
   *  section never deletes anything itself. */
  onRequestDeletePreset: (preset: LlmParameterPreset) => void;
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
        {LLM_TASK_IDS.map((taskId, i) => {
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
              userPresets={userPresets}
              llmModels={llmModels}
              servers={servers}
              defaultLlm={defaultLlm}
              expanded={expandedTask === taskId}
              onToggleExpand={() =>
                onExpandedTaskChange(expandedTask === taskId ? null : taskId)
              }
              onSaveAssignment={(next) => onSaveAssignment(taskId, next)}
              onResetAssignment={() => onResetAssignment(taskId)}
              onSavePreset={onSavePreset}
              onDuplicatePreset={onDuplicatePreset}
              onRequestDeletePreset={onRequestDeletePreset}
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
  userPresets,
  llmModels,
  servers,
  defaultLlm,
  expanded,
  onToggleExpand,
  onSaveAssignment,
  onResetAssignment,
  onSavePreset,
  onDuplicatePreset,
  onRequestDeletePreset,
}: {
  taskId: LlmTaskId;
  first: boolean;
  assignment: LlmTaskAssignment;
  migratedFromLegacy: boolean;
  /** Built-ins merged ahead of the stored list (§4.2) — what the track and
   *  the chips render. */
  presets: LlmParameterPreset[];
  /** The storable list only: the base a copy or an edit is inserted into,
   *  and the list the §4.3 write guard runs over. Built-ins are in neither,
   *  which is why this is not just `presets`. */
  userPresets: LlmParameterPreset[];
  llmModels: ConfiguredModel[];
  servers: ServerView[];
  defaultLlm: ConfiguredModel | undefined;
  expanded: boolean;
  onToggleExpand: () => void;
  onSaveAssignment: (assignment: LlmTaskAssignment) => void;
  onResetAssignment: () => void;
  onSavePreset: (preset: LlmParameterPreset) => Promise<boolean>;
  onDuplicatePreset: (
    source: LlmParameterPreset,
    copyName: string,
  ) => Promise<LlmParameterPreset | null>;
  onRequestDeletePreset: (preset: LlmParameterPreset) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const ownServerModels = llmModels.filter(
    (c) => c.provider === SERVER_PROVIDER_ID,
  );
  const cloudModels = llmModels.filter(
    (c) => c.provider !== SERVER_PROVIDER_ID,
  );
  const [editor, setEditor] = useState<EditorState | null>(null);
  // Inline failure for the action row — a refused write never silently
  // looks like a saved one (the bug the old `saveUserPreset` had).
  const [actionError, setActionError] = useState<string | null>(null);
  // In-flight flag for `writePreset` — the row's only awaited write path
  // (params editor, rename, new-preset auto-copy). Forwarded to the editors
  // as `saving` so Save/Cancel can't fire a second write mid-PUT.
  const [saving, setSaving] = useState(false);

  const preset =
    assignment.mode === "preset"
      ? presets.find((p) => p.id === assignment.presetId)
      : undefined;
  const dangling =
    assignment.mode === "preset" && isDanglingAssignment(assignment, presets);
  // A built-in cannot be edited or renamed in place — it is a code constant
  // (§4.2). Both actions therefore produce a copy the user owns, which
  // *reads* as the same action and is labelled as one (§9.3).
  const targetsBuiltin = !!preset && isBuiltinPresetId(preset.id);
  const copyName = preset
    ? t("models.taskProfiles.presetCopyName", { name: preset.name })
    : "";
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
  // A dangling `presetId` (§11) matches no option in the track, which left
  // the control showing nothing selected. Normalise it to "auto" — exactly
  // what the server does with it (`resolveModeParams` warns and returns `{}`,
  // §8.3) — and say so in the panel below the track.
  const segmentedValue: string =
    assignment.mode === "preset"
      ? preset
        ? (assignment.presetId ?? "auto")
        : "auto"
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

  /** Map the §4.3 guard's verdict onto the message the user acts on. The
   *  byte-cap wording is the existing `presetTooLarge` key, not a new one. */
  const issueText = (issue: PresetWriteIssue): string =>
    issue.kind === "tooLarge"
      ? t("models.taskProfiles.presetTooLarge")
      : issue.kind === "countMax"
        ? t("models.taskProfiles.presetCountMax", { max: issue.max })
        : t("models.taskProfiles.presetSaveFailed");

  /**
   * The one write path for every action in this row (§9.3/§9.4). Runs the
   * route's §4.3 rules over the list this write WOULD produce, then hands
   * off to `use-models.ts`; a refusal at either step shows inline and leaves
   * the stored blob alone.
   *
   * `reassign` is the built-in case (§4.2 amendment): the write lands under a
   * fresh `user_*` id, so this task's assignment has to follow it. That is the
   * moment the task opts out of future built-in updates — the built-in payload
   * may change in a release, this assignment now points at a frozen copy.
   */
  const writePreset = async (
    next: LlmParameterPreset,
    reassign: boolean,
  ): Promise<void> => {
    const issue = checkPresetWrite(upsertPreset(userPresets, next));
    if (issue) {
      setActionError(issueText(issue));
      return;
    }
    setSaving(true);
    try {
      const ok = await onSavePreset(next);
      if (!ok) {
        setActionError(t("models.taskProfiles.presetSaveFailed"));
        return;
      }
      if (reassign) {
        onSaveAssignment({
          mode: "preset",
          presetId: next.id,
          // §6.3 — a per-task model choice says nothing about presets, so it
          // survives every rewrite this row performs.
          modelOverride: assignment.modelOverride,
        });
      }
      setActionError(null);
      setEditor(null);
    } finally {
      // `finally`, not a tail call: a refused/rejected PUT must not strand
      // the editor with a stuck guard.
      setSaving(false);
    }
  };

  const onSaveParams = (params: Record<string, unknown>, name: string) => {
    if (!preset) return;
    if (!targetsBuiltin) {
      void writePreset({ ...preset, params }, false);
      return;
    }
    const now = new Date().toISOString();
    void writePreset(
      {
        id: newPresetId(),
        name: clampPresetName(name.trim() || copyName),
        params,
        createdAt: now,
        updatedAt: now,
      },
      true,
    );
  };

  const onSaveName = (rawName: string) => {
    if (!preset) return;
    // A blank draft keeps the current name rather than blocking on a second,
    // undeclared validation rule — the same fallback `NewPresetEditor` uses.
    const name = clampPresetName(
      rawName.trim() || (targetsBuiltin ? copyName : preset.name),
    );
    if (!targetsBuiltin) {
      void writePreset({ ...preset, name }, false);
      return;
    }
    const now = new Date().toISOString();
    void writePreset(
      {
        id: newPresetId(),
        name,
        params: clonePresetParams(preset.params),
        createdAt: now,
        updatedAt: now,
      },
      true,
    );
  };

  const onDuplicate = () => {
    if (!preset) return;
    setActionError(null);
    void onDuplicatePreset(preset, copyName).then((copy) => {
      setActionError(copy ? null : t("models.taskProfiles.presetSaveFailed"));
    });
  };

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
            <Badge variant={dangling ? "outline" : "secondary"}>
              {dangling
                ? t("models.taskProfiles.presetMissingBadge")
                : (preset?.name ?? "")}
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

            {/* The action row lives BELOW the track, never inside it —
                `ToggleGroupItem` renders a `<button>`, so a nested action
                button would be invalid DOM that bubbles a selection change
                (`toggle.tsx` also sets `[&_svg]:pointer-events-none`).
                Always visible, not hover-revealed: this is a settings panel
                with no reliable hover state. */}
            {preset && !dangling ? (
              <PresetActionRow
                preset={preset}
                editing={editor?.kind === "editPreset"}
                renaming={editor?.kind === "rename"}
                onEditParams={() =>
                  setEditor(
                    editor?.kind === "editPreset"
                      ? null
                      : { kind: "editPreset", preset },
                  )
                }
                onRename={() =>
                  setEditor(
                    editor?.kind === "rename"
                      ? null
                      : { kind: "rename", preset },
                  )
                }
                onDuplicate={onDuplicate}
                onRequestDelete={() => onRequestDeletePreset(preset)}
              />
            ) : null}

            {dangling && (
              <p className="text-muted-foreground mt-2 text-[11.5px] leading-snug">
                {t("models.taskProfiles.presetMissingNote")}
              </p>
            )}

            {actionError && (
              <p className="text-destructive mt-2 text-[11.5px] leading-snug">
                {actionError}
              </p>
            )}
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

          {/* Save-and-select, the §9.3 convention: a newly created preset IS
              the draft the user just typed, so leaving the task on its old
              assignment would make the edit invisible. `writePreset` re-points
              and surfaces a refusal instead of a silent half-write. */}
          {editor?.kind === "newPreset" && (
            <NewPresetEditor
              saving={saving}
              onCancel={() => setEditor(null)}
              onSave={(created) => void writePreset(created, true)}
            />
          )}

          {editor?.kind === "editPreset" && (
            <PresetParamsEditor
              preset={editor.preset}
              copyName={copyName}
              saving={saving}
              onSave={(params, name) => onSaveParams(params, name)}
              onCancel={() => setEditor(null)}
            />
          )}

          {editor?.kind === "rename" && (
            <RenamePresetEditor
              preset={editor.preset}
              saving={saving}
              onSave={onSaveName}
              onCancel={() => setEditor(null)}
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
                {[
                  {
                    label: t("models.picker.ownServer"),
                    models: ownServerModels,
                  },
                  { label: t("models.picker.cloud"), models: cloudModels },
                ]
                  .filter((group) => group.models.length > 0)
                  .map((group) => (
                    <SelectGroup key={group.label}>
                      <SelectLabel>{group.label}</SelectLabel>
                      {group.models.map((m) => (
                        <SelectItem
                          key={`${m.provider}/${m.model_id}`}
                          value={`${m.provider}/${m.model_id}`}
                        >
                          {m.model_name} · {providerLabel(m, servers, t)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
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

/** The plain "+ New preset" editor (§9.4): empty name, empty payload, always
 *  a fresh `user_*` id. It no longer seeds from anything — §4.2's 2026-09-26
 *  amendment retired the read-only built-in, so copying a built-in's payload
 *  is `PresetActionRow`'s Edit/Rename fork (`editPreset`/`rename` →
 *  `onSaveParams`/`onSaveName`), not a variant of this editor. */
function NewPresetEditor({
  saving,
  onCancel,
  onSave,
}: {
  /** Forwarded to `ParamJsonEditor` — the `writePreset` in-flight guard. */
  saving: boolean;
  onCancel: () => void;
  onSave: (preset: LlmParameterPreset) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  // Blank by design. The "… copy" naming lives on the fork path, which
  // composes `presetCopyName` in `TaskRow` — the same key the Duplicate
  // button uses — so nothing seeds a name here.
  const [name, setName] = useState("");

  // `ParamJsonEditor`'s own Save button only fires `onChange` once the
  // textarea holds valid, parsed JSON (§9.4) — that's also the right moment
  // to finalize the new preset, so this wrapper doesn't need a second Save
  // step. A blank name falls back to the "New preset" default rather than
  // blocking the save on a second, undeclared validation rule.
  return (
    <ParamJsonEditor
      name={name}
      onNameChange={setName}
      value={{}}
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
      saving={saving}
    />
  );
}

// ---------------------------------------------------------------------------
// PresetActionRow — the four per-preset actions (§9.3), inline under the
// Params track. Text buttons, always visible, `title` + `aria-label` on
// every control; Delete stays `hover:text-destructive` so it reads distinct
// from the neutral grey of the rest (specs/design-system.md). Built-ins get
// the SAME row minus Delete — there is nothing to delete (§4.2), and a
// disabled dead button is worse than no button — and their Edit button is
// labelled with the existing `duplicateToEdit` string, because that is
// literally what it does.
// ---------------------------------------------------------------------------

function PresetActionRow({
  preset,
  editing,
  renaming,
  onEditParams,
  onRename,
  onDuplicate,
  onRequestDelete,
}: {
  /** The preset this row acts on — named, so it is never ambiguous which of
   *  the track's options a click targets. */
  preset: LlmParameterPreset;
  editing: boolean;
  renaming: boolean;
  onEditParams: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onRequestDelete: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const builtin = isBuiltinPresetId(preset.id);
  const editLabel = builtin
    ? t("models.taskProfiles.duplicateToEdit")
    : t("models.taskProfiles.editParams");

  return (
    <div className="mt-2.5 space-y-1">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Badge variant={builtin ? "secondary" : "outline"}>
          {builtin
            ? t("models.taskProfiles.presetBuiltin")
            : t("models.taskProfiles.presetYours")}
        </Badge>
        <span
          className="text-muted-foreground max-w-[22ch] truncate text-[11.5px]"
          title={preset.name}
        >
          {preset.name}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={onEditParams}
            aria-expanded={editing}
            title={editLabel}
            aria-label={editLabel}
          >
            {editLabel}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={onRename}
            aria-expanded={renaming}
            title={t("models.taskProfiles.rename")}
            aria-label={t("models.taskProfiles.rename")}
          >
            {t("models.taskProfiles.rename")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={onDuplicate}
            title={t("models.taskProfiles.duplicate")}
            aria-label={t("models.taskProfiles.duplicate")}
          >
            {t("models.taskProfiles.duplicate")}
          </Button>
          {!builtin && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={onRequestDelete}
              title={t("models.taskProfiles.deletePreset")}
              aria-label={t("models.taskProfiles.deletePresetAria", {
                name: preset.name,
              })}
            >
              {t("models.taskProfiles.deletePreset")}
            </Button>
          )}
        </div>
      </div>
      {builtin && (
        <p className="text-muted-foreground text-[11px] leading-snug">
          {t("models.taskProfiles.builtinAutoCopyNote")}
        </p>
      )}
    </div>
  );
}

/** §9.4's editor, reused for "edit this preset's params". A `user_*` preset
 *  opens with no Name field — Rename is its own action. A `builtin:*` preset
 *  opens editable with a prefilled name, because the write is a copy (§4.2)
 *  and that copy needs a name the moment it exists. */
function PresetParamsEditor({
  preset,
  copyName,
  saving,
  onSave,
  onCancel,
}: {
  preset: LlmParameterPreset;
  copyName: string;
  /** Forwarded to `ParamJsonEditor` — the `writePreset` in-flight guard. */
  saving: boolean;
  onSave: (params: Record<string, unknown>, name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const builtin = isBuiltinPresetId(preset.id);
  const [name, setName] = useState(copyName);

  return (
    <ParamJsonEditor
      name={builtin ? name : undefined}
      onNameChange={builtin ? setName : undefined}
      saveLabel={builtin ? t("models.taskProfiles.saveCopy") : undefined}
      value={preset.params}
      onChange={(params) => onSave(params, name)}
      onClose={onCancel}
      saving={saving}
    />
  );
}

/** Inline rename — Enter commits, Escape aborts, `maxLength` is the §4.1
 *  bound enforced by the same constant the schema uses. No dialog for a
 *  string this short. */
function RenamePresetEditor({
  preset,
  saving,
  onSave,
  onCancel,
}: {
  preset: LlmParameterPreset;
  /** Same guard as `ParamJsonEditor` — `onSaveName` awaits `writePreset`. */
  saving: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(preset.name);
  const label = t("models.taskProfiles.presetNameLabel");

  return (
    <div className="space-y-2">
      <span className="text-foreground block text-[13px] font-medium">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={LLM_PRESET_NAME_MAX}
          aria-label={label}
          className="max-w-64"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!saving) onSave(draft);
            } else if (e.key === "Escape") {
              e.preventDefault();
              if (!saving) onCancel();
            }
          }}
        />
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="ink"
          size="sm"
          onClick={() => onSave(draft)}
          disabled={!draft.trim() || saving}
        >
          {t("common.save")}
        </Button>
      </div>
      {isBuiltinPresetId(preset.id) && (
        <p className="text-muted-foreground text-[11px] leading-snug">
          {t("models.taskProfiles.renameBuiltinNote")}
        </p>
      )}
    </div>
  );
}
