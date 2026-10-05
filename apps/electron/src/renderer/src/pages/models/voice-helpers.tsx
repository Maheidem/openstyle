import { Button } from "@renderer/components/ui/button";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

export function recommendedVoiceKey(
  items: { key: string; localEngine?: string }[],
): string {
  return items.some((it) => it.localEngine === "mlx")
    ? "local-mlx/qwen3-0.6b-8bit"
    : "local-whisper/small-q5_1";
}

export function OpenModelSourceButton({
  url,
}: {
  url: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        void window.api?.openExternal(url);
      }}
    >
      <ExternalLink data-icon="inline-start" />
      {t("models.picker.openModelSource")}
    </Button>
  );
}
