import { Button } from "@renderer/components/ui/button";
import { IS_MAC } from "@renderer/lib/platform";
import { configuredModelsQueryOptions } from "@renderer/lib/query";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

function Card({
  testId,
  text,
  action,
  onAction,
}: {
  testId: string;
  text: string;
  action: string;
  onAction: () => void;
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className="border-border bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <p className="text-foreground/90 m-0 text-[13px] leading-snug">
          {text}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={onAction}
      >
        {action}
      </Button>
    </div>
  );
}

/**
 * The cards of an unfinished setup (specs/onboarding.md): no voice model yet
 * ("Decide later" in the first run), or a permission that dictation needs.
 * Each card has one button. A card goes away when the thing is set.
 */
export function SetupCards(): React.JSX.Element | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: configured } = useQuery(configuredModelsQueryOptions());
  const permissions = useQuery({
    queryKey: ["setup-cards", "permissions"],
    enabled: IS_MAC,
    refetchOnWindowFocus: true,
    queryFn: async () => ({
      mic: (await window.api?.checkMicPermission()) ?? "granted",
      accessibility: !!(await window.api?.checkAccessibilityPermission()),
    }),
  });

  const noVoice =
    configured !== undefined &&
    !configured.some((m) => m.type === "voice" && m.is_default === 1);
  const micOff = permissions.data && permissions.data.mic !== "granted";
  const accessibilityOff = permissions.data && !permissions.data.accessibility;
  if (!noVoice && !micOff && !accessibilityOff) return null;

  return (
    <div className="mb-5 space-y-2" data-testid="setup-cards">
      {noVoice && (
        <Card
          testId="setup-card-voice"
          text={t("today.setup.voice")}
          action={t("today.setup.voiceAction")}
          onAction={() => navigate("/settings/models")}
        />
      )}
      {micOff && (
        <Card
          testId="setup-card-microphone"
          text={t("today.setup.microphone")}
          action={t("today.setup.openSettings")}
          onAction={() => window.api?.openMicSettings()}
        />
      )}
      {accessibilityOff && (
        <Card
          testId="setup-card-accessibility"
          text={t("today.setup.accessibility")}
          action={t("today.setup.openSettings")}
          onAction={() => window.api?.openAccessibilitySettings()}
        />
      )}
    </div>
  );
}
