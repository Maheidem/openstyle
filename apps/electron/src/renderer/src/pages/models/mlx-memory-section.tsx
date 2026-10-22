import {
  MLX_KEEP_ALIVE_ALWAYS,
  MLX_KEEP_ALIVE_MAX_MINUTES,
} from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Slider } from "@renderer/components/ui/slider";
import type { TFunction } from "i18next";
import { Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Which MLX worker the dialog configures: speech (ASR) or the local LLM. */
type WarmingKind = "asr" | "llm";

function mlxKeepAliveDescription(
  minutes: number,
  kind: WarmingKind,
  t: TFunction,
): string {
  const ns = kind === "llm" ? "models.mlxLlm" : "models.mlx";
  if (minutes === MLX_KEEP_ALIVE_ALWAYS) {
    return t(`${ns}.descAlways`);
  }
  if (minutes === 0) {
    return t(`${ns}.descCold`);
  }
  if (minutes === 1) {
    return t(`${ns}.descOneMinute`);
  }
  return t(`${ns}.descMinutes`, { minutes });
}

// ---------------------------------------------------------------------------
// MlxWarmingDialog — modal to configure the MLX keep-alive (cold start ↔ warm)
// ---------------------------------------------------------------------------

export function MlxWarmingDialog({
  kind = "asr",
  keepAliveMinutes,
  blockedReason,
  onChange,
  onClose,
}: {
  kind?: WarmingKind;
  keepAliveMinutes: number;
  blockedReason: string | null;
  onChange: (minutes: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  // The slider gets one extra step past the max minutes to represent "Always on".
  const alwaysPos = MLX_KEEP_ALIVE_MAX_MINUTES + 1;
  const sliderPos =
    keepAliveMinutes === MLX_KEEP_ALIVE_ALWAYS ? alwaysPos : keepAliveMinutes;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-2.5">
            <Cpu className="text-primary h-4 w-4 shrink-0" />
            <DialogTitle>
              {t(kind === "llm" ? "models.mlxLlm.title" : "models.mlx.title")}
            </DialogTitle>
          </div>
        </DialogHeader>

        <p className="text-muted-foreground text-[12.5px] leading-relaxed">
          {mlxKeepAliveDescription(keepAliveMinutes, kind, t)}
        </p>

        <div>
          <Slider
            value={[sliderPos]}
            onValueChange={([v]) =>
              onChange(
                v > MLX_KEEP_ALIVE_MAX_MINUTES ? MLX_KEEP_ALIVE_ALWAYS : v,
              )
            }
            min={0}
            max={alwaysPos}
            step={1}
            aria-label={t(
              kind === "llm" ? "models.mlxLlmKeepAlive" : "models.mlxKeepAlive",
            )}
          />
          <div className="text-muted-foreground mt-2 flex justify-between text-[11px]">
            <span>{t("models.mlx.coldStart")}</span>
            <span>{t("models.mlx.alwaysOn")}</span>
          </div>
        </div>

        {blockedReason && (
          <p className="text-destructive text-[12px] leading-relaxed">
            {blockedReason}
          </p>
        )}

        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            {t("common.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
