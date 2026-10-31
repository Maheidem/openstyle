import { CHAT_SETTING_LIMITS } from "@openstyle/validations";
import { Input } from "@renderer/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import { queryKeys, settingsQueryOptions } from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { cn } from "@renderer/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SETTINGS_KEYS } from "../../../shared/settings-keys";
import { useTimeoutSetting } from "./use-timeout-setting";

/** The settings row of `settings.tsx`. The page gives it, so the two files do not import each other. */
type RowComponent = (props: {
  label: string;
  desc: string;
  children: React.ReactNode;
  last?: boolean;
}) => React.JSX.Element;

type NumberLimits = { min: number; max: number; default: number };

/** A whole number inside the limits, or null. */
function makeParse(limits: NumberLimits) {
  return (value: string | null | undefined): number | null => {
    if (value == null || !/^\d+$/.test(value.trim())) return null;
    const n = Number(value);
    return n >= limits.min && n <= limits.max ? n : null;
  };
}

const parseRounds = makeParse(CHAT_SETTING_LIMITS.rounds);
const parseSourceBudget = makeParse(CHAT_SETTING_LIMITS.sourceBudget);
const parseK = makeParse(CHAT_SETTING_LIMITS.k);
const parseDeadline = makeParse(CHAT_SETTING_LIMITS.deadlineSeconds);

/**
 * One numeric row. The hook commits on blur or Enter only and checks the
 * limits. A value that is not the default shows "unmeasured" (spec 2.9 rule 2).
 */
function NumberRow({
  Row,
  setting,
  i18nKey,
  testId,
  defaultValue,
  unit,
  last,
}: {
  Row: RowComponent;
  setting: ReturnType<typeof useTimeoutSetting>;
  i18nKey: string;
  testId: string;
  defaultValue: number;
  unit?: string;
  last?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const unmeasured = Number(setting.shown) !== defaultValue;
  return (
    <Row
      label={t(i18nKey)}
      desc={t(`${i18nKey}Desc`, { value: defaultValue })}
      last={last}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Input
            inputMode="numeric"
            value={setting.shown}
            onChange={(e) => setting.onChange(e.target.value)}
            onBlur={(e) => setting.onBlur(e.target.value)}
            onKeyDown={setting.onKeyDown}
            maxLength={setting.maxDigits}
            className="w-24 text-center"
            aria-label={t(i18nKey)}
            aria-invalid={setting.invalid}
            data-testid={testId}
          />
          {unit && (
            <span className="text-muted-foreground text-xs">{unit}</span>
          )}
          {unmeasured && (
            <span
              className="border-border text-muted-foreground rounded-md border px-1.5 py-0.5 text-[11px]"
              data-testid={`${testId}-unmeasured`}
            >
              {t("settings.ask.unmeasured")}
            </span>
          )}
        </div>
        <span
          className={cn(
            "text-[11.5px]",
            setting.hint.destructive
              ? "text-destructive"
              : "text-muted-foreground",
          )}
          data-testid={`${testId}-hint`}
        >
          {setting.hint.text}
        </span>
      </div>
    </Row>
  );
}

/**
 * The "Ask" section of Settings (specs/meeting-chat-agent.md 2.9). The page
 * shows it only while the Ask switch is on.
 */
export function AskSettingsPanel({
  Row,
}: {
  Row: RowComponent;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(settingsQueryOptions());

  const rounds = useTimeoutSetting({
    settingsKey: SETTINGS_KEYS.chatRounds,
    i18nPrefix: "settings.ask.number",
    defaultSeconds: CHAT_SETTING_LIMITS.rounds.default,
    min: CHAT_SETTING_LIMITS.rounds.min,
    max: CHAT_SETTING_LIMITS.rounds.max,
    parse: parseRounds,
  });
  const sourceBudget = useTimeoutSetting({
    settingsKey: SETTINGS_KEYS.chatSourceBudget,
    i18nPrefix: "settings.ask.number",
    defaultSeconds: CHAT_SETTING_LIMITS.sourceBudget.default,
    min: CHAT_SETTING_LIMITS.sourceBudget.min,
    max: CHAT_SETTING_LIMITS.sourceBudget.max,
    parse: parseSourceBudget,
  });
  const k = useTimeoutSetting({
    settingsKey: SETTINGS_KEYS.chatRetrievalK,
    i18nPrefix: "settings.ask.number",
    defaultSeconds: CHAT_SETTING_LIMITS.k.default,
    min: CHAT_SETTING_LIMITS.k.min,
    max: CHAT_SETTING_LIMITS.k.max,
    parse: parseK,
  });
  const deadline = useTimeoutSetting({
    settingsKey: SETTINGS_KEYS.chatDeadlineSeconds,
    i18nPrefix: "settings.ask.number",
    defaultSeconds: CHAT_SETTING_LIMITS.deadlineSeconds.default,
    min: CHAT_SETTING_LIMITS.deadlineSeconds.min,
    max: CHAT_SETTING_LIMITS.deadlineSeconds.max,
    parse: parseDeadline,
  });
  const { applyServerValue: applyRounds } = rounds;
  const { applyServerValue: applySourceBudget } = sourceBudget;
  const { applyServerValue: applyK } = k;
  const { applyServerValue: applyDeadline } = deadline;

  // A missing row means the default. Only "false" turns these two away from it.
  const [searchWider, setSearchWider] = useState<"true" | "false">("true");
  const [nativeTools, setNativeTools] = useState(true);

  useEffect(() => {
    if (!settings) return;
    applyRounds(settings[SETTINGS_KEYS.chatRounds]);
    applySourceBudget(settings[SETTINGS_KEYS.chatSourceBudget]);
    applyK(settings[SETTINGS_KEYS.chatRetrievalK]);
    applyDeadline(settings[SETTINGS_KEYS.chatDeadlineSeconds]);
    setSearchWider(
      settings[SETTINGS_KEYS.chatSearchWider] === "false" ? "false" : "true",
    );
    setNativeTools(settings[SETTINGS_KEYS.chatNativeTools] !== "false");
  }, [settings, applyRounds, applySourceBudget, applyK, applyDeadline]);

  const save = (key: string, value: string): void => {
    void putSetting(key, value).then(() =>
      queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
    );
  };

  return (
    <div className="flex flex-col" data-testid="settings-ask">
      <NumberRow
        Row={Row}
        setting={rounds}
        i18nKey="settings.ask.rounds"
        testId="settings-ask-rounds"
        defaultValue={CHAT_SETTING_LIMITS.rounds.default}
      />
      <NumberRow
        Row={Row}
        setting={sourceBudget}
        i18nKey="settings.ask.sourceBudget"
        testId="settings-ask-source-budget"
        defaultValue={CHAT_SETTING_LIMITS.sourceBudget.default}
        unit={t("settings.ask.tokens")}
      />
      <NumberRow
        Row={Row}
        setting={k}
        i18nKey="settings.ask.k"
        testId="settings-ask-k"
        defaultValue={CHAT_SETTING_LIMITS.k.default}
      />
      <NumberRow
        Row={Row}
        setting={deadline}
        i18nKey="settings.ask.deadline"
        testId="settings-ask-deadline"
        defaultValue={CHAT_SETTING_LIMITS.deadlineSeconds.default}
        unit={t("settings.ask.seconds")}
      />
      <Row
        label={t("settings.ask.searchWider")}
        desc={t("settings.ask.searchWiderDesc")}
      >
        <Select
          value={searchWider}
          onValueChange={(v) => {
            const next = v === "false" ? "false" : "true";
            setSearchWider(next);
            save(SETTINGS_KEYS.chatSearchWider, next);
          }}
        >
          <SelectTrigger
            className="w-56"
            aria-label={t("settings.ask.searchWider")}
            data-testid="settings-ask-search-wider"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">
              {t("settings.ask.searchWiderAsk")}
            </SelectItem>
            <SelectItem value="false">
              {t("settings.ask.searchWiderOff")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row
        label={t("settings.ask.nativeTools")}
        desc={t("settings.ask.nativeToolsDesc")}
        last
      >
        <Switch
          checked={nativeTools}
          onCheckedChange={(on) => {
            setNativeTools(on);
            save(SETTINGS_KEYS.chatNativeTools, String(on));
          }}
          aria-label={t("settings.ask.nativeTools")}
          data-testid="settings-ask-native-tools"
        />
      </Row>
    </div>
  );
}
