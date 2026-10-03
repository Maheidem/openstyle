import {
  CLEANUP_CUSTOM_PROMPT_MAX,
  CLEANUP_PRESET_PROMPTS,
  type CleanupAppAssignment,
  type CleanupEmailTone,
  type CleanupIntensity,
  type CleanupOverallTone,
  type CleanupPersonalTone,
  type CleanupToneDestination,
  type CleanupWorkTone,
  parseCleanupAppAssignments,
  parseCleanupEmailTone,
  parseCleanupIntensity,
  parseCleanupOverallTone,
  parseCleanupPersonalTone,
  parseCleanupWorkTone,
} from "@openstyle/validations";
import { AppAssignments } from "@renderer/components/tone-previews/app-assignments";
import {
  type AppMarkId,
  AppMarkRow,
} from "@renderer/components/tone-previews/app-marks";
import { CleanupPreview } from "@renderer/components/tone-previews/cleanup-preview";
import { EmailPreview } from "@renderer/components/tone-previews/email-preview";
import { NotePreview } from "@renderer/components/tone-previews/note-preview";
import {
  getVisibleBuiltinRouteIds,
  normalizeManagedAssignments,
} from "@renderer/components/tone-previews/route-ownership";
import { TextMessagePreview } from "@renderer/components/tone-previews/text-message-preview";
import { WorkChatPreview } from "@renderer/components/tone-previews/work-chat-preview";
import { Button } from "@renderer/components/ui/button";
import {
  RadioCard,
  RadioCardGroup,
} from "@renderer/components/ui/radio-card-group";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@renderer/components/ui/tabs";
import { Textarea } from "@renderer/components/ui/textarea";
import { usePersistentState } from "@renderer/hooks/use-persistent-state";
import { getClient } from "@renderer/lib/api";
import { queryKeys, settingsQueryOptions } from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  DEFAULT_CLEANUP_EMAIL_TONE,
  DEFAULT_CLEANUP_OVERALL_TONE,
  DEFAULT_CLEANUP_PERSONAL_TONE,
  DEFAULT_CLEANUP_WORK_TONE,
} from "../../../shared/cleanup-tone-settings";
import { SETTINGS_KEYS } from "../../../shared/settings-keys";
import { Eyebrow, PageHeader, PageShell } from "./models/page-chrome";
import type { ConfiguredModel } from "./models/types";

// Settings that change whether the pill needs to capture the frontmost app for
// cleanup destination routing. Saving any of these notifies the pill to refresh
// its cached decision (see cleanup-app-context.ts).
const CLEANUP_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  SETTINGS_KEYS.llmCleanup,
  SETTINGS_KEYS.cleanupPersonalTone,
  SETTINGS_KEYS.cleanupWorkTone,
  SETTINGS_KEYS.cleanupEmailTone,
  SETTINGS_KEYS.cleanupOverallTone,
]);

type ToneTab =
  | "cleanup"
  | Exclude<CleanupToneDestination, "overall">
  | "everythingElse";

const TONE_TABS: readonly ToneTab[] = [
  "cleanup",
  "personal",
  "work",
  "email",
  "everythingElse",
];

const isToneTab = (value: string): value is ToneTab =>
  (TONE_TABS as readonly string[]).includes(value);

type CleanupCardValue = CleanupIntensity;

type ToneCardOption<T extends string> = {
  value: T;
  titleKey: string;
  descKey: string;
  sampleKey: string;
};

// Builds the card options for one i18n group. All keys follow
// `tone.<group>.cards.<value>.{title,desc,sample}`.
function toneOptions<T extends string>(
  group: string,
  values: readonly T[],
): ToneCardOption<T>[] {
  return values.map((value) => ({
    value,
    titleKey: `tone.${group}.cards.${value}.title`,
    descKey: `tone.${group}.cards.${value}.desc`,
    sampleKey: `tone.${group}.cards.${value}.sample`,
  }));
}

const CLEANUP_OPTIONS = toneOptions<CleanupCardValue>("cleanup", [
  "low",
  "medium",
  "high",
  "custom",
]);
const PERSONAL_OPTIONS = toneOptions<CleanupPersonalTone>("personal", [
  "polished",
  "casual",
  "very_casual",
  "off",
]);
const WORK_OPTIONS = toneOptions<CleanupWorkTone>("work", [
  "direct",
  "friendly",
  "formal",
  "off",
]);
const EMAIL_OPTIONS = toneOptions<CleanupEmailTone>("email", [
  "casual",
  "warm",
  "formal",
  "off",
]);
const OVERALL_OPTIONS = toneOptions<CleanupOverallTone>("everythingElse", [
  "casual",
  "neutral",
  "professional",
  "off",
]);

export default function TonePage(): React.JSX.Element {
  const { t } = useTranslation();
  const [llmCleanup, setLlmCleanup] = useState(false);
  const [cleanupIntensity, setCleanupIntensity] =
    useState<CleanupIntensity>("medium");
  const [cleanupCustomPrompt, setCleanupCustomPrompt] = useState("");
  const [savedCleanupCustomPrompt, setSavedCleanupCustomPrompt] = useState("");
  const [savingCustomPrompt, setSavingCustomPrompt] = useState(false);
  const [personalTone, setPersonalTone] = useState<CleanupPersonalTone>(
    DEFAULT_CLEANUP_PERSONAL_TONE,
  );
  const [workTone, setWorkTone] = useState<CleanupWorkTone>(
    DEFAULT_CLEANUP_WORK_TONE,
  );
  const [emailTone, setEmailTone] = useState<CleanupEmailTone>(
    DEFAULT_CLEANUP_EMAIL_TONE,
  );
  const [overallTone, setOverallTone] = useState<CleanupOverallTone>(
    DEFAULT_CLEANUP_OVERALL_TONE,
  );
  const [assignments, setAssignments] = useState<CleanupAppAssignment[]>([]);
  const [activeTab, setActiveTab] = usePersistentState<ToneTab>(
    "tone.activeTab",
    "cleanup",
    isToneTab,
  );

  const customPromptDirty = cleanupCustomPrompt !== savedCleanupCustomPrompt;

  const settingsQuery = useQuery(settingsQueryOptions());

  const configuredQuery = useQuery({
    queryKey: queryKeys.models.configured,
    queryFn: async () => {
      const res = await getClient().api.models.configured.$get();
      if (!res.ok) throw new Error("Failed to load configured models");
      return (await res.json()) as ConfiguredModel[];
    },
  });

  const loading = settingsQuery.isLoading || configuredQuery.isLoading;

  // Whether a default cleanup (LLM) model is configured — drives the banners.
  const hasCleanupModel = useMemo(
    () =>
      (configuredQuery.data ?? []).some(
        (model) => model.type === "llm" && model.is_default === 1,
      ),
    [configuredQuery.data],
  );

  // Seed editable tone/cleanup state from persisted settings once. Save
  // handlers update local state directly, so we don't re-seed on later
  // invalidations (which would clobber in-progress edits).
  const seededRef = useRef(false);
  useEffect(() => {
    const settings = settingsQuery.data;
    if (!settings || seededRef.current) return;
    seededRef.current = true;

    setLlmCleanup(settings[SETTINGS_KEYS.llmCleanup] === "true");
    setCleanupIntensity(
      parseCleanupIntensity(settings[SETTINGS_KEYS.cleanupIntensity]),
    );
    const prompt = settings[SETTINGS_KEYS.cleanupCustomPrompt];
    if (typeof prompt === "string") {
      setCleanupCustomPrompt(prompt);
      setSavedCleanupCustomPrompt(prompt);
    }
    setPersonalTone(
      parseCleanupPersonalTone(settings[SETTINGS_KEYS.cleanupPersonalTone]),
    );
    setWorkTone(parseCleanupWorkTone(settings[SETTINGS_KEYS.cleanupWorkTone]));
    setEmailTone(
      parseCleanupEmailTone(settings[SETTINGS_KEYS.cleanupEmailTone]),
    );
    setOverallTone(
      parseCleanupOverallTone(settings[SETTINGS_KEYS.cleanupOverallTone]),
    );
    setAssignments(
      normalizeManagedAssignments(
        parseCleanupAppAssignments(
          settings[SETTINGS_KEYS.cleanupAppAssignments],
        ),
      ),
    );
  }, [settingsQuery.data]);

  const saveSetting = useCallback(async (key: string, value: string) => {
    // The Hono client does not throw on non-2xx — surface server rejections so
    // callers' .catch handlers fire (and "Saved" state isn't shown on failure).
    if (!(await putSetting(key, value))) {
      throw new Error(`Failed to save setting "${key}"`);
    }
    // Let the pill refresh its cached "needs frontmost app for routing" decision
    // when a cleanup-relevant setting changes, so it doesn't re-fetch settings
    // on every recording start.
    if (CLEANUP_CONTEXT_KEYS.has(key)) {
      window.api?.sendCleanupContextChanged();
    }
  }, []);

  const selectCleanupMode = useCallback(
    (next: CleanupCardValue) => {
      // Enablement lives on the Models page now — this only picks the strength.
      if (next === "custom" && cleanupIntensity !== "custom") {
        const seed =
          cleanupCustomPrompt.trim() ||
          CLEANUP_PRESET_PROMPTS[cleanupIntensity];
        setCleanupCustomPrompt(seed);
      }

      setCleanupIntensity(next);
      saveSetting(SETTINGS_KEYS.cleanupIntensity, next).catch((err) =>
        console.error("Failed to save cleanup strength:", err),
      );
    },
    [cleanupCustomPrompt, cleanupIntensity, saveSetting],
  );

  const saveCleanupCustomPrompt = useCallback(async () => {
    const value = cleanupCustomPrompt;
    setSavingCustomPrompt(true);
    try {
      await saveSetting(SETTINGS_KEYS.cleanupCustomPrompt, value);
      setSavedCleanupCustomPrompt(value);
    } catch (err) {
      console.error("Failed to save cleanup custom prompt:", err);
    } finally {
      setSavingCustomPrompt(false);
    }
  }, [cleanupCustomPrompt, saveSetting]);

  const resetToPresetMode = useCallback(() => {
    selectCleanupMode("low");
  }, [selectCleanupMode]);

  const savePersonalTone = useCallback(
    (value: CleanupPersonalTone) => {
      setPersonalTone(value);
      saveSetting(SETTINGS_KEYS.cleanupPersonalTone, value).catch((err) =>
        console.error("Failed to save personal tone:", err),
      );
    },
    [saveSetting],
  );

  const saveWorkTone = useCallback(
    (value: CleanupWorkTone) => {
      setWorkTone(value);
      saveSetting(SETTINGS_KEYS.cleanupWorkTone, value).catch((err) =>
        console.error("Failed to save work tone:", err),
      );
    },
    [saveSetting],
  );

  const saveEmailTone = useCallback(
    (value: CleanupEmailTone) => {
      setEmailTone(value);
      saveSetting(SETTINGS_KEYS.cleanupEmailTone, value).catch((err) =>
        console.error("Failed to save email tone:", err),
      );
    },
    [saveSetting],
  );

  const saveOverallTone = useCallback(
    (value: CleanupOverallTone) => {
      setOverallTone(value);
      saveSetting(SETTINGS_KEYS.cleanupOverallTone, value).catch((err) =>
        console.error("Failed to save everything-else tone:", err),
      );
    },
    [saveSetting],
  );

  const persistAssignments = useCallback(
    (next: CleanupAppAssignment[]) => {
      const normalized = normalizeManagedAssignments(next);
      setAssignments(normalized);
      saveSetting(
        SETTINGS_KEYS.cleanupAppAssignments,
        JSON.stringify(normalized),
      ).catch((err) => console.error("Failed to save app assignments:", err));
    },
    [saveSetting],
  );

  const addAssignment = useCallback(
    (assignment: CleanupAppAssignment) => {
      // A given app/site maps to exactly one group — a re-add moves it.
      persistAssignments([
        ...assignments.filter((a) => a.match !== assignment.match),
        assignment,
      ]);
    },
    [assignments, persistAssignments],
  );

  const removeAssignment = useCallback(
    (match: string) => {
      persistAssignments(assignments.filter((a) => a.match !== match));
    },
    [assignments, persistAssignments],
  );

  if (loading) {
    return (
      <PageShell>
        <div className="mx-auto w-full max-w-[1060px]">
          <div className="flex items-center justify-center py-24">
            <p className="text-muted-foreground text-sm">{t("tone.loading")}</p>
          </div>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="mx-auto w-full max-w-[1060px]">
        <PageHeader title={t("tone.title")} subtitle={t("tone.subtitle")} />

        {!llmCleanup ? (
          <CleanupDisabledBanner />
        ) : !hasCleanupModel ? (
          <CleanupNoModelBanner />
        ) : null}

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as ToneTab)}
          className="mt-8 gap-7"
        >
          <TabsList className="h-11 w-fit max-w-full items-stretch gap-1 self-start overflow-x-auto overflow-y-hidden rounded-full border border-border bg-card p-[3px]">
            {(
              [
                ["cleanup", "tone.tabs.cleanup"],
                ["personal", "tone.tabs.personal"],
                ["work", "tone.tabs.work"],
                ["email", "tone.tabs.email"],
                ["everythingElse", "tone.tabs.everythingElse"],
              ] as const
            ).map(([value, key]) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-full flex-none rounded-full px-4 py-0 text-[13px] font-medium leading-none data-active:border-border data-active:bg-background data-active:text-foreground"
              >
                {t(key)}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="cleanup" className="mt-0">
            <CleanupTonePanel
              value={cleanupIntensity}
              onChange={selectCleanupMode}
              cleanupCustomPrompt={cleanupCustomPrompt}
              onCustomPromptChange={setCleanupCustomPrompt}
              customPromptDirty={customPromptDirty}
              onSaveCustomPrompt={() => void saveCleanupCustomPrompt()}
              onResetToPreset={resetToPresetMode}
              savingCustomPrompt={savingCustomPrompt}
            />
          </TabsContent>

          <TabsContent value="personal" className="mt-0">
            <SubsetTonePanel
              destination="personal"
              title={t("tone.personal.title")}
              apps={getVisibleBuiltinRouteIds("personal", assignments)}
              value={personalTone}
              options={PERSONAL_OPTIONS}
              onChange={savePersonalTone}
              assignments={assignments.filter(
                (a) => a.destination === "personal",
              )}
              allAssignments={assignments}
              onAddAssignment={addAssignment}
              onRemoveAssignment={removeAssignment}
            />
          </TabsContent>

          <TabsContent value="work" className="mt-0">
            <SubsetTonePanel
              destination="work"
              title={t("tone.work.title")}
              apps={getVisibleBuiltinRouteIds("work", assignments)}
              value={workTone}
              options={WORK_OPTIONS}
              onChange={saveWorkTone}
              assignments={assignments.filter((a) => a.destination === "work")}
              allAssignments={assignments}
              onAddAssignment={addAssignment}
              onRemoveAssignment={removeAssignment}
            />
          </TabsContent>

          <TabsContent value="email" className="mt-0">
            <SubsetTonePanel
              destination="email"
              title={t("tone.email.title")}
              apps={getVisibleBuiltinRouteIds("email", assignments)}
              value={emailTone}
              options={EMAIL_OPTIONS}
              onChange={saveEmailTone}
              assignments={assignments.filter((a) => a.destination === "email")}
              allAssignments={assignments}
              onAddAssignment={addAssignment}
              onRemoveAssignment={removeAssignment}
            />
          </TabsContent>

          <TabsContent value="everythingElse" className="mt-0">
            <SubsetTonePanel
              destination="overall"
              title={t("tone.everythingElse.title")}
              desc={t("tone.everythingElse.desc")}
              apps={[]}
              value={overallTone}
              options={OVERALL_OPTIONS}
              onChange={saveOverallTone}
              assignments={assignments.filter(
                (a) => a.destination === "overall",
              )}
              allAssignments={assignments}
              onAddAssignment={addAssignment}
              onRemoveAssignment={removeAssignment}
            />
          </TabsContent>
        </Tabs>
      </div>
    </PageShell>
  );
}

// Shown across every Tone tab while post-processing is off. Cleanup enablement
// lives on the Models page, so this points users there.
function CleanupDisabledBanner(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="border-border/70 bg-card mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-foreground text-[13px] font-medium">
          {t("tone.disabledBanner.title")}
        </p>
        <p className="text-muted-foreground mt-0.5 text-[12px] leading-[1.5]">
          {t("tone.disabledBanner.desc")}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to="/settings/models">
            {t("tone.disabledBanner.goToModels")}
          </Link>
        </Button>
      </div>
    </div>
  );
}

// Cleanup is enabled but no LLM model is configured, so nothing actually runs.
// Shown across every Tone tab (not just the Cleanup tab) since the tone
// selectors have no effect until a model is picked.
function CleanupNoModelBanner(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="border-border/70 bg-card mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-foreground text-[13px] font-medium">
          {t("tone.cleanup.noModelTitle")}
        </p>
        <p className="text-muted-foreground mt-0.5 text-[12px] leading-[1.5]">
          {t("tone.cleanup.noModelDesc")}
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link to="/settings/models">{t("tone.cleanup.noModelCta")}</Link>
      </Button>
    </div>
  );
}

function CleanupTonePanel({
  value,
  onChange,
  cleanupCustomPrompt,
  onCustomPromptChange,
  customPromptDirty,
  onSaveCustomPrompt,
  onResetToPreset,
  savingCustomPrompt,
}: {
  value: CleanupCardValue;
  onChange: (value: CleanupCardValue) => void;
  cleanupCustomPrompt: string;
  onCustomPromptChange: (value: string) => void;
  customPromptDirty: boolean;
  onSaveCustomPrompt: () => void;
  onResetToPreset: () => void;
  savingCustomPrompt: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();

  const activeOption =
    CLEANUP_OPTIONS.find((option) => option.value === value) ??
    CLEANUP_OPTIONS[0]!;

  return (
    <div className="space-y-6">
      <section className="border-t border-border/70 pt-5">
        <h2 className="display text-foreground text-[28px] leading-[1.05] tracking-[-0.03em]">
          {t("tone.cleanup.title")}
        </h2>
        <p className="text-muted-foreground mt-2 max-w-[52ch] text-[13px] leading-[1.55]">
          {t("tone.cleanup.desc")}
        </p>
      </section>

      <div className="space-y-5">
        <RadioCardGroup
          value={value}
          onValueChange={(next) => onChange(next as CleanupCardValue)}
          aria-label={t("tone.cleanup.title")}
          className="grid grid-cols-2 gap-2.5 min-[560px]:grid-cols-3 min-[1000px]:grid-cols-5"
        >
          {CLEANUP_OPTIONS.map((option) => (
            <RadioCard
              key={option.value}
              value={option.value}
              className="flex flex-col gap-1.5 p-3.5"
            >
              <div className="flex items-center justify-between gap-1.5">
                <p className="display text-foreground text-[21px] leading-none tracking-[-0.03em]">
                  {t(option.titleKey)}
                </p>
                <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full border border-border/70 bg-transparent text-transparent transition-colors duration-150 group-hover:border-foreground/25 group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-data-[state=checked]:text-primary-foreground">
                  <Check
                    className="size-2.5"
                    strokeWidth={3}
                    aria-hidden="true"
                  />
                </span>
              </div>
              <p className="text-muted-foreground text-[11.5px] leading-[1.4]">
                {t(option.descKey)}
              </p>
            </RadioCard>
          ))}
        </RadioCardGroup>

        {value === "custom" ? (
          <div className="border-border bg-card rounded-lg border p-5">
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <Eyebrow text={t("models.cleanup.promptLabel")} />
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={onResetToPreset}
              >
                {t("models.cleanup.resetToPresets")}
              </Button>
            </div>
            <p className="text-muted-foreground mb-3 text-[12.5px] leading-[1.55]">
              {t("models.cleanup.presetHint")}
            </p>
            <Textarea
              value={cleanupCustomPrompt}
              maxLength={CLEANUP_CUSTOM_PROMPT_MAX}
              onChange={(event) => onCustomPromptChange(event.target.value)}
              spellCheck={false}
              className="mono min-h-[180px] resize-y text-[12px] leading-[1.65]"
              aria-label={t("models.cleanup.promptLabel")}
            />
            <div className="text-muted-foreground mt-3 flex flex-wrap items-center justify-between gap-3 text-[11px]">
              <span>{t("models.cleanup.customHint")}</span>
              <Button
                variant="ink"
                size="sm"
                onClick={onSaveCustomPrompt}
                disabled={savingCustomPrompt || !customPromptDirty}
              >
                {savingCustomPrompt ? (
                  <>
                    <Loader2 className="animate-spin" />
                    {t("models.cleanup.saving")}
                  </>
                ) : customPromptDirty ? (
                  t("models.cleanup.save")
                ) : (
                  <>
                    <Check />
                    {t("models.cleanup.saved")}
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="border-border bg-card rounded-lg border p-5">
            <div className="grid gap-5 min-[720px]:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] min-[720px]:gap-8">
              <div>
                <Eyebrow text={t("tone.cleanup.preview.rawLabel")} />
                <p className="text-muted-foreground mt-2.5 text-[13.5px] leading-[1.6]">
                  {t("tone.cleanup.preview.rawSample")}
                </p>
              </div>
              <div className="min-[720px]:border-border/60 min-[720px]:border-l min-[720px]:pl-8">
                <div className="mb-2.5 flex items-center justify-between gap-2">
                  <Eyebrow
                    text={t("tone.cleanup.preview.resultLabel")}
                    accent
                  />
                  <Eyebrow text={t(activeOption.titleKey)} />
                </div>
                <CleanupPreview result={t(activeOption.sampleKey)} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SubsetTonePanel<T extends string>({
  destination,
  title,
  desc,
  apps,
  value,
  options,
  onChange,
  assignments,
  allAssignments,
  onAddAssignment,
  onRemoveAssignment,
}: {
  destination: CleanupToneDestination;
  title: string;
  desc?: string;
  apps: readonly AppMarkId[];
  value: T;
  options: ToneCardOption<T>[];
  onChange: (value: T) => void;
  assignments: CleanupAppAssignment[];
  allAssignments: CleanupAppAssignment[];
  onAddAssignment: (assignment: CleanupAppAssignment) => void;
  onRemoveAssignment: (match: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const canManageRoutes = destination !== "overall";
  const hasRouteIcons = apps.length > 0 || assignments.length > 0;
  const assignmentsButton = canManageRoutes ? (
    <AppAssignments
      destination={destination}
      items={assignments}
      allItems={allAssignments}
      onAdd={onAddAssignment}
      onRemove={onRemoveAssignment}
    />
  ) : null;

  const renderPreview = (sample: string): React.JSX.Element => {
    if (destination === "personal") {
      return <TextMessagePreview sample={sample} />;
    }
    if (destination === "work") {
      return (
        <WorkChatPreview
          sample={sample}
          sender={t("tone.work.preview.sender")}
          time={t("tone.work.preview.time")}
        />
      );
    }
    if (destination === "email") {
      return (
        <EmailPreview
          body={sample}
          to={t("tone.email.preview.to")}
          subject={t("tone.email.preview.subject")}
        />
      );
    }
    return <NotePreview sample={sample} />;
  };

  const activeOption = options.find((o) => o.value === value) ?? options[0]!;
  const rawSampleKey =
    destination === "overall"
      ? "tone.everythingElse.preview.rawSample"
      : `tone.${destination}.preview.rawSample`;

  return (
    <div className="space-y-6">
      <section className="grid gap-5 border-t border-border/70 pt-5 min-[980px]:grid-cols-[minmax(0,1fr)_300px] min-[980px]:items-start">
        <div className="min-w-0">
          <h2 className="display text-foreground text-[28px] leading-[1.05] tracking-[-0.03em]">
            {title}
          </h2>
          {desc ? (
            <p className="text-muted-foreground mt-2 max-w-[52ch] text-[13px] leading-[1.55]">
              {desc}
            </p>
          ) : null}
        </div>
        <div className="min-[980px]:justify-self-end">
          <Eyebrow text={t("tone.routesFrom")} />
          {hasRouteIcons ? (
            <AppMarkRow
              ids={apps}
              assignments={assignments}
              size={30}
              className="mt-3"
              trailing={assignmentsButton}
            />
          ) : (
            <p className="text-muted-foreground mt-3 text-[12px] leading-[1.5]">
              {t("tone.apps.anyUnlisted")}
            </p>
          )}
          {!hasRouteIcons && assignmentsButton ? (
            <div className="mt-3 flex items-center">{assignmentsButton}</div>
          ) : null}
        </div>
      </section>

      <div className="grid gap-4 min-[820px]:grid-cols-[minmax(0,300px)_minmax(0,1fr)] min-[820px]:items-start">
        <RadioCardGroup
          value={value}
          onValueChange={(next) => onChange(next as T)}
          aria-label={title}
          className="flex flex-col gap-2.5"
        >
          {options.map((option) => (
            <RadioCard
              key={option.value}
              value={option.value}
              className="flex items-center gap-3 py-4 pr-4 pl-5"
            >
              <span
                aria-hidden="true"
                className="absolute left-0 top-1/2 h-0 w-1 -translate-y-1/2 rounded-r-full bg-foreground/15 transition-all duration-150 group-hover:h-5 group-data-[state=checked]:h-9 group-data-[state=checked]:bg-primary"
              />
              <div className="min-w-0 flex-1">
                <p className="display text-foreground text-[24px] leading-none tracking-[-0.03em]">
                  {t(option.titleKey)}
                </p>
                <p className="text-muted-foreground mt-2 text-[12.5px] leading-[1.45]">
                  {t(option.descKey)}
                </p>
              </div>
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/70 bg-transparent text-transparent transition-colors duration-150 group-hover:border-foreground/25 group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-data-[state=checked]:text-primary-foreground">
                <Check className="size-3" strokeWidth={3} aria-hidden="true" />
              </span>
            </RadioCard>
          ))}
        </RadioCardGroup>

        <div>
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <Eyebrow text={t("tone.previewLabel")} />
            <Eyebrow text={t(activeOption.titleKey)} accent />
          </div>
          <div className="space-y-1.5">
            <Eyebrow text={t("tone.cleanup.preview.rawLabel")} />
            <p className="text-muted-foreground text-[13px] leading-[1.55]">
              {t(rawSampleKey)}
            </p>
          </div>
          <div className="my-3.5 flex items-center gap-2.5">
            <span className="border-border/70 h-px flex-1 border-t" />
            <Eyebrow text={t("tone.cleanup.preview.resultLabel")} accent />
            <span className="border-border/70 h-px flex-1 border-t" />
          </div>
          {activeOption.value === "off" ? (
            <NotePreview sample={t(activeOption.sampleKey)} />
          ) : (
            renderPreview(t(activeOption.sampleKey))
          )}
        </div>
      </div>
    </div>
  );
}
