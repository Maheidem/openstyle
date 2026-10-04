import { getClient } from "@renderer/lib/api";
import { queryKeys } from "@renderer/lib/query";
import { putSetting } from "@renderer/lib/settings";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type CommitTrigger,
  displayValueFor,
  inspectNumericDraft,
  resolveCommitIntent,
  sanitizeDigits,
} from "./settings-numeric-commit";

export interface TimeoutSettingOptions {
  /** The settings key that holds the timeout, in seconds. */
  settingsKey: string;
  /**
   * Prefix of the i18n keys. The hook adds the suffixes `SaveFailed`,
   * `Invalid`, `Stripped` and `Range`.
   */
  i18nPrefix: string;
  defaultSeconds: number;
  min: number;
  max: number;
  parse: (value: string | null | undefined) => number | null;
}

/**
 * State and handlers of one numeric timeout control in Settings → Data.
 *
 * `seconds` mirrors what the server holds. An unset setting means the
 * default, so the field shows the default too. `draft` is the local text
 * being typed: it shows in the field and writes NOTHING. The PUT fires on an
 * explicit commit (blur, Enter or Reset), never mid-keystroke. An invalid
 * draft on blur reverts to the saved value. `stripped` holds the characters
 * the renderer dropped, so the hint can name them. `saveError` holds the
 * server value after a rejected write, so a failure cannot look like a
 * success. See `settings-numeric-commit.ts` for the decision table.
 */
export function useTimeoutSetting({
  settingsKey,
  i18nPrefix,
  defaultSeconds,
  min,
  max,
  parse,
}: TimeoutSettingOptions) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [seconds, setSeconds] = useState(String(defaultSeconds));
  const [draft, setDraft] = useState<null | string>(null);
  const [stripped, setStripped] = useState("");
  const [saveError, setSaveError] = useState<null | string>(null);

  // The input's `maxLength` and the sanitizer share this cap, so a digit past
  // it is refused by the browser and not dropped later by the renderer.
  const maxDigits = String(max).length;

  /** Show a value loaded from the settings query. Unset or out of bounds keeps the default. */
  const applyServerValue = useCallback(
    (raw: string | null | undefined) => {
      const parsed = parse(raw);
      if (parsed !== null) setSeconds(String(parsed));
    },
    [parse],
  );

  /**
   * Read the value that the server ACTUALLY holds for this key. The hook calls
   * this after a failed write, so the field shows the budget that the lane
   * will really get. A failed read falls back to the default. Because of this,
   * two failures in a row cannot put a wrong number on screen.
   */
  const readFromServer = useCallback(async (): Promise<string> => {
    const fallback = displayValueFor(null, defaultSeconds, parse);
    try {
      const res = await getClient().api.settings[":key"].$get({
        param: { key: settingsKey },
      });
      if (!res.ok) return fallback;
      const body = (await res.json()) as { value?: string | null };
      return displayValueFor(body.value ?? null, defaultSeconds, parse);
    } catch {
      return fallback;
    }
  }, [defaultSeconds, parse, settingsKey]);

  /**
   * The ONE write path. Only blur, Enter and Reset reach it, never
   * `onChange`. A rejected write re-reads the key and shows the server value
   * in the destructive hint.
   */
  const commit = useCallback(
    async (value: string | null, trigger: CommitTrigger): Promise<void> => {
      const intent = resolveCommitIntent({
        trigger,
        draft: value,
        saved: seconds,
        parse,
      });
      setDraft(null);
      setStripped("");
      setSaveError(null);
      if (intent.kind !== "write" && intent.kind !== "reset") return;
      const next = intent.kind === "reset" ? "" : intent.value;
      if (await putSetting(settingsKey, next)) {
        setSeconds(displayValueFor(next, defaultSeconds, parse));
        // Keep the shared settings cache correct. Other readers of this key
        // must not see a value that the server never stored.
        queryClient.setQueryData<Record<string, string>>(
          queryKeys.settings,
          (prev) => ({ ...(prev ?? {}), [settingsKey]: next }),
        );
        return;
      }
      const held = await readFromServer();
      setSeconds(held);
      setSaveError(held);
    },
    [defaultSeconds, parse, queryClient, readFromServer, seconds, settingsKey],
  );

  /** Typing updates the LOCAL DRAFT only. This handler never writes. */
  const onChange = useCallback(
    (raw: string) => {
      setDraft(sanitizeDigits(raw, maxDigits));
      setStripped(inspectNumericDraft(raw, maxDigits).stripped);
      setSaveError(null);
    },
    [maxDigits],
  );

  const onBlur = useCallback(
    (raw: string) => {
      void commit(sanitizeDigits(raw, maxDigits), "blur");
    },
    [commit, maxDigits],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void commit(event.currentTarget.value, "enter");
      }
    },
    [commit],
  );

  const onReset = useCallback(() => {
    void commit(draft, "reset");
  }, [commit, draft]);

  /** Mid-typing only: the persisted value is always in bounds. */
  const invalid = draft !== null && parse(draft) === null;

  /**
   * Hint priority, highest first:
   * 1. A failed save. The hint names the value that the server holds.
   * 2. A draft that is out of bounds. The hint names the bound.
   * 3. A stripped entry. The hint names what the user typed and what the
   *    field now holds.
   * 4. The neutral range line.
   */
  const hint: { destructive: boolean; text: string } =
    saveError !== null
      ? {
          destructive: true,
          text: t(`${i18nPrefix}SaveFailed`, { value: saveError }),
        }
      : invalid
        ? {
            destructive: true,
            text: t(`${i18nPrefix}Invalid`, { min, max }),
          }
        : stripped !== ""
          ? {
              destructive: true,
              text: t(`${i18nPrefix}Stripped`, {
                dropped: stripped,
                value: draft ?? "",
              }),
            }
          : {
              destructive: false,
              text: t(`${i18nPrefix}Range`, { min, max }),
            };

  return {
    shown: draft ?? seconds,
    invalid,
    hint,
    maxDigits,
    applyServerValue,
    onChange,
    onBlur,
    onKeyDown,
    onReset,
  };
}
