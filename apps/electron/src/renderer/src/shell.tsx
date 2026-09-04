import { Badge } from "@renderer/components/ui/badge";
import { UpdateBanner } from "@renderer/components/update-banner";
import { LINKS } from "@renderer/lib/links";
import { IS_MAC, MOD_LABEL } from "@renderer/lib/platform";
import { configQueryOptions, settingsQueryOptions } from "@renderer/lib/query";
import { cn } from "@renderer/lib/utils";
import { SETTINGS_KEYS } from "@shared/settings-keys";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
  Book,
  BookOpen,
  CircleHelp,
  Cpu,
  FileText,
  Settings,
  Upload,
  Wand2,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useNavigate } from "react-router";

/** GitHub mark — the Simple Icons path react-icons' SiGithub rendered, kept
 *  glyph-identical. Inlined because lucide dropped brand icons and pulling
 *  the whole react-icons package for one logo was the last non-vendored use. */
function GitHubMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Keyboard shortcut digit (e.g. "1" for Cmd+1). */
  shortcut?: string;
  /** Renders in the bottom group of the sidebar instead of the top. */
  footer?: boolean;
};

const STATIC_NAV: {
  to: string;
  icon: LucideIcon;
  shortcut: string;
  labelKey: string;
  footer?: boolean;
}[] = [
  { to: "/today", icon: BookOpen, shortcut: "1", labelKey: "shell.nav.today" },
  {
    to: "/remix",
    icon: Wand2,
    shortcut: "2",
    labelKey: "shell.nav.remix",
  },
  {
    to: "/meetings",
    icon: AudioLines,
    shortcut: "3",
    labelKey: "shell.nav.meetings",
  },
  {
    to: "/import",
    icon: Upload,
    shortcut: "8",
    labelKey: "shell.nav.import",
  },
  {
    to: "/settings/vocabulary",
    icon: Book,
    shortcut: "3",
    labelKey: "shell.nav.vocabulary",
  },
  {
    to: "/settings/dictionary",
    icon: Zap,
    shortcut: "3",
    labelKey: "shell.nav.dictionary",
  },
  {
    to: "/settings/tone",
    icon: FileText,
    shortcut: "4",
    labelKey: "shell.nav.tone",
  },
  {
    to: "/settings/models",
    icon: Cpu,
    shortcut: "5",
    labelKey: "shell.nav.models",
  },
  {
    to: "/settings",
    icon: Settings,
    shortcut: "6",
    labelKey: "shell.nav.settings",
    footer: true,
  },
  {
    to: "/help",
    icon: CircleHelp,
    shortcut: "7",
    labelKey: "shell.nav.help",
    footer: true,
  },
];

function NavList({ items }: { items: NavItem[] }): React.JSX.Element {
  return (
    <nav
      className="flex flex-col gap-px px-3"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/settings"}
            className="block"
          >
            {({ isActive }) => (
              <div
                className={cn(
                  "flex items-center gap-2.5 rounded-[7px] border px-2.5 py-1.5 text-[13px] transition-colors",
                  isActive
                    ? "glass-nav-active text-[color:var(--accent-passive-ink)] font-medium"
                    : "text-secondary-foreground/80 hover:bg-card/50 border-transparent font-normal",
                )}
              >
                <Icon
                  size={14}
                  className={
                    isActive ? "text-sidebar-primary" : "text-muted-foreground"
                  }
                />
                <span className="flex-1 truncate">{item.label}</span>
                {item.shortcut ? (
                  <span
                    className={cn(
                      "mono shrink-0 text-[9.5px] tabular-nums",
                      isActive
                        ? "text-[color:var(--accent-passive-ink)] opacity-[0.72]"
                        : "text-muted-foreground/60",
                    )}
                  >
                    {MOD_LABEL}
                    {item.shortcut}
                  </span>
                ) : null}
              </div>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}

export default function AppShell(): React.JSX.Element {
  const navigate = useNavigate();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { t } = useTranslation();

  // Advanced mode gates the Models page. Read from the shared settings cache so
  // toggling it in Settings updates the sidebar without a full refetch.
  const { data: settings } = useQuery(settingsQueryOptions());
  const advancedMode = settings?.[SETTINGS_KEYS.advancedMode] === "true";

  // Meeting Mode is behind the server-owned `meetings` feature flag.
  const { data: config } = useQuery(configQueryOptions());
  const meetingsEnabled = config?.flags?.meetings === true;

  // Filter the static nav (hide Models when advanced mode is off, Meetings
  // when its flag is off) and re-number the Cmd+N shortcuts sequentially so
  // there's no gap when an item is hidden (e.g. Settings becomes Cmd+5 when
  // Models is absent).
  const staticNav = useMemo(
    () =>
      STATIC_NAV.filter(
        (item) =>
          (item.to !== "/settings/models" || advancedMode) &&
          (item.to !== "/meetings" || meetingsEnabled),
      ).map((item, idx) => ({ ...item, shortcut: String(idx + 1) })),
    [advancedMode, meetingsEnabled],
  );

  const navItems: NavItem[] = useMemo(
    () =>
      staticNav.map((item) => ({
        ...item,
        label: t(item.labelKey) as string,
      })),
    [staticNav, t],
  );
  const mainNav = navItems.filter((item) => !item.footer);
  const footerNav = navItems.filter((item) => item.footer);

  // Cmd/Ctrl+1..9 jumps between sidebar items
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < staticNav.length) {
        e.preventDefault();
        navigate(staticNav[idx].to);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate, staticNav]);

  useEffect(() => {
    return window.api?.onFullscreenChanged(setIsFullscreen);
  }, []);

  return (
    <div className="glass-window-shell flex h-screen min-h-0">
      <aside
        className="glass-sidebar flex min-h-0 w-[220px] shrink-0 flex-col border-r"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {/* Brand row — top padding leaves space for macOS traffic lights */}
        <div
          className={cn(
            "flex items-center gap-2.5 px-3.5 pb-6",
            !IS_MAC || isFullscreen ? "pt-4" : "pt-[44px]",
          )}
        >
          <div
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-foreground"
            aria-hidden="true"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-background" />
          </div>
          <span className="display text-foreground text-[19px] font-medium tracking-tight">
            Openstyle
          </span>
          {import.meta.env.DEV && (
            <Badge
              variant="outline"
              className="mono h-4 border-yellow-500/30 bg-yellow-500/15 px-1.5 text-[9px] text-yellow-700 uppercase tracking-[0.12em] dark:text-yellow-300"
            >
              dev
            </Badge>
          )}
        </div>

        <div
          className="no-scrollbar min-h-0 flex-1 overflow-y-auto"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <NavList items={mainNav} />
        </div>
        <NavList items={footerNav} />
        <div className="h-3" />
      </aside>

      <div className="glass-content relative z-0 flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "glass-topbar absolute top-0 right-0 z-40 flex items-center gap-1.5 rounded-bl-[14px] border-b border-l px-3 py-2",
          )}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <a
            href={LINKS.repo}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub repo"
            className="text-muted-foreground hover:text-foreground inline-flex items-center justify-center rounded-md p-1.5 transition-colors"
          >
            <GitHubMark className="h-3.5 w-3.5" />
          </a>
        </div>

        <UpdateBanner className="relative z-50 mt-14 w-[calc(100%-3rem)] max-w-2xl self-center" />

        <main
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          style={{ scrollbarWidth: "none" } as React.CSSProperties}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
