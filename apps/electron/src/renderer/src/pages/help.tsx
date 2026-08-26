import { Kbd } from "@renderer/components/ui/kbd";
import {
  formatAcceleratorKeys,
  keyDisplayLabel,
} from "@renderer/hooks/use-hotkey-recorder";
import { LINKS } from "@renderer/lib/links";
import { IS_MAC } from "@renderer/lib/platform";
import { configQueryOptions, settingsQueryOptions } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import {
  Eyebrow,
  PageHeader,
  PageShell,
} from "@renderer/pages/models/page-chrome";
import { getDefaultHotkey } from "@shared/hotkey-defaults";
import { getDefaultRemixHotkey } from "@shared/remix";
import { SETTINGS_KEYS } from "@shared/settings-keys";
import { useQuery } from "@tanstack/react-query";
import { Bug, ExternalLink, Heart } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { IconType } from "react-icons";

type CardIcon = React.ComponentType<{ className?: string }> | IconType;

function HelpCard({
  href,
  icon: Icon,
  title,
  desc,
}: {
  href: string;
  icon: CardIcon;
  title: string;
  desc: string;
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="border-border bg-card hover:bg-card/70 flex items-start gap-3 rounded-lg border px-4 py-3.5 transition-colors"
    >
      <div className="bg-background text-foreground flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px]">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-foreground flex items-center gap-1.5 text-[13px] font-medium">
          {title}
          <ExternalLink className="text-muted-foreground h-3 w-3" />
        </div>
        <p className="text-muted-foreground mt-1 text-[12px] leading-[1.5]">
          {desc}
        </p>
      </div>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Hotkeys — 4 static, read-only rows mirroring the recorder UI in Settings
// (settings.tsx), but display-only: no recording affordance here.
// ---------------------------------------------------------------------------

/** One key badge, styled to match key-combo.tsx's KeyBadge "default" variant so
 *  standalone/paired badges built outside KeyComboDisplay still look identical. */
function KbdBadge({ label }: { label: string }): React.JSX.Element {
  return (
    <Kbd className="min-w-[26px] rounded-md border border-border bg-muted px-1.5 py-1 font-mono leading-none text-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
      {label}
    </Kbd>
  );
}

function KbdSep({ label }: { label: string }): React.JSX.Element {
  return <span className="text-muted-foreground text-[10px]">{label}</span>;
}

function HotkeyRow({
  label,
  desc,
  last,
  children,
}: {
  label: string;
  desc: string;
  last?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-6 py-[15px]",
        !last && "border-border border-b",
      )}
    >
      <div>
        <div className="text-foreground text-[13px] font-medium">{label}</div>
        <p className="text-muted-foreground mt-[3px] max-w-[380px] text-[12px] leading-[1.5]">
          {desc}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

/**
 * Quick-route chord: mirrors REMIX_ROUTE_MODIFIER / REMIX_ROUTE_DIGITS in
 * main/index.ts (Control on macOS, Control+Alt elsewhere; digits 1-3).
 * Not exported from main for the renderer to import, so the platform branch
 * is duplicated here rather than pulled in — see the return summary.
 */
const QUICK_ROUTE_MODIFIER_ACCEL = IS_MAC ? "Control" : "Control+Alt";
const QUICK_ROUTE_FIRST_DIGIT = "1";
const QUICK_ROUTE_LAST_DIGIT = "3";

/**
 * Mirrors shell.tsx's STATIC_NAV order + labelKeys + visibility gates (icons
 * omitted — the mockup's nav-shortcut-item has no icon, only label + kbd),
 * since that list isn't exported for reuse. Gating matches shell.tsx
 * exactly: Models only when advanced mode is on, Meetings only when the
 * server's `meetings` flag is on.
 */
const NAV_SHORTCUT_ITEMS: {
  labelKey: string;
  hidden?: (ctx: {
    advancedMode: boolean;
    meetingsEnabled: boolean;
  }) => boolean;
}[] = [
  { labelKey: "shell.nav.today" },
  { labelKey: "shell.nav.remix" },
  { labelKey: "shell.nav.meetings", hidden: (ctx) => !ctx.meetingsEnabled },
  { labelKey: "shell.nav.vocabulary" },
  { labelKey: "shell.nav.dictionary" },
  { labelKey: "shell.nav.tone" },
  { labelKey: "shell.nav.models", hidden: (ctx) => !ctx.advancedMode },
  { labelKey: "shell.nav.settings" },
  { labelKey: "shell.nav.help" },
];

export default function HelpPage(): React.JSX.Element {
  const { t } = useTranslation();

  // Real persisted hotkeys (falls back to the platform default, same as
  // settings.tsx's initial useState before the settings query resolves).
  const settingsQuery = useQuery(settingsQueryOptions());
  const settings = settingsQuery.data;
  const hotkey =
    settings?.[SETTINGS_KEYS.hotkey] ??
    window.api?.defaultHotkey ??
    getDefaultHotkey();
  const remixHotkey =
    settings?.[SETTINGS_KEYS.remixHotkey] ??
    window.api?.defaultRemixHotkey ??
    getDefaultRemixHotkey();

  // Same visibility gates shell.tsx uses to filter+renumber its Cmd+N list.
  const advancedMode = settings?.[SETTINGS_KEYS.advancedMode] === "true";
  const { data: config } = useQuery(configQueryOptions());
  const meetingsEnabled = config?.flags?.meetings === true;

  const navShortcuts = useMemo(
    () =>
      NAV_SHORTCUT_ITEMS.filter(
        (item) => !item.hidden?.({ advancedMode, meetingsEnabled }),
      ).map((item, idx) => ({ ...item, shortcut: idx + 1 })),
    [advancedMode, meetingsEnabled],
  );

  // Matches shell.tsx's Cmd/Ctrl+1..9 handler, which accepts metaKey OR
  // ctrlKey — so the display key is Command on macOS, Control elsewhere
  // (not MOD_LABEL's "Ctrl+" text run, which isn't a standalone badge).
  const navModifierLabel = keyDisplayLabel(IS_MAC ? "Command" : "Control");

  return (
    <PageShell>
      <PageHeader
        title="Help"
        subtitle="Documentation and ways to contribute to Openstyle."
      />

      <section className="mb-8">
        <Eyebrow text={t("help.hotkeys.eyebrow")} />
        <div className="border-border bg-card mt-3 rounded-lg border px-[18px]">
          <HotkeyRow
            label={t("help.hotkeys.hotkeyLabel")}
            desc={t("help.hotkeys.hotkeyDesc")}
          >
            {formatAcceleratorKeys(hotkey).map((key, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <KbdSep label="+" />}
                <KbdBadge label={key} />
              </span>
            ))}
          </HotkeyRow>

          <HotkeyRow
            label={t("help.hotkeys.remixLabel")}
            desc={t("help.hotkeys.remixDesc")}
          >
            {formatAcceleratorKeys(remixHotkey).map((key, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <KbdSep label="+" />}
                <KbdBadge label={key} />
              </span>
            ))}
          </HotkeyRow>

          <HotkeyRow
            label={t("help.hotkeys.quickRoutesLabel")}
            desc={t("help.hotkeys.quickRoutesDesc")}
          >
            {formatAcceleratorKeys(QUICK_ROUTE_MODIFIER_ACCEL).map((key, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <KbdSep label="+" />}
                <KbdBadge label={key} />
              </span>
            ))}
            <KbdSep label="+" />
            <KbdBadge label={QUICK_ROUTE_FIRST_DIGIT} />
            <KbdSep label="–" />
            <KbdBadge label={QUICK_ROUTE_LAST_DIGIT} />
          </HotkeyRow>

          <HotkeyRow
            label={t("help.hotkeys.cancelLabel")}
            desc={t("help.hotkeys.cancelDesc")}
            last
          >
            <KbdBadge label={keyDisplayLabel("Escape")} />
          </HotkeyRow>
        </div>
      </section>

      <section className="mb-8">
        <Eyebrow text={t("help.navigate.eyebrow")} />
        <div className="border-border bg-border mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg border">
          {navShortcuts.map((item) => (
            <div
              key={item.labelKey}
              className="bg-card flex items-center justify-between gap-2 px-3.5 py-2.5"
            >
              <span className="text-foreground text-[12.5px]">
                {t(item.labelKey)}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <KbdBadge label={navModifierLabel} />
                <KbdBadge label={String(item.shortcut)} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <Eyebrow text="Get help" />
        <div className="mt-3 grid grid-cols-1 gap-3">
          <HelpCard
            href={LINKS.newIssue}
            icon={Bug}
            title="Report an issue"
            desc="Found a bug or have a feature request? Open a GitHub issue."
          />
        </div>
      </section>

      <section className="mb-8">
        <Eyebrow text="Contributing" />
        <div className="mt-3">
          <HelpCard
            href={LINKS.contributing}
            icon={Heart}
            title="Contribute to Openstyle"
            desc="PRs are welcome. Start with CONTRIBUTING.md for local setup."
          />
        </div>
      </section>
    </PageShell>
  );
}
