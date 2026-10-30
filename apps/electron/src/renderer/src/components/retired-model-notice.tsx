import { Button } from "@renderer/components/ui/button";
import { getClient } from "@renderer/lib/api";
import { PROVIDER_DISPLAY_NAMES } from "@renderer/lib/models";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

const NOTICES_KEY = ["models", "retired-notices"] as const;

/**
 * One-time notice on the Today page: the saved cloud model was retired by its
 * provider and the server replaced it (lib/cloud-models.ts). The notice shows
 * once for each replaced id. Change opens the AI model picker.
 */
export function RetiredModelNotice(): React.JSX.Element | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: NOTICES_KEY,
    queryFn: async () => {
      const res = await getClient().api.models["retired-notices"].$get();
      if (!res.ok) throw new Error("Failed to load model notices");
      return await res.json();
    },
  });
  const notice = data?.[0];
  if (!notice) return null;

  const dismiss = async (): Promise<void> => {
    await getClient().api.models["retired-notices"].dismiss.$post({
      json: { provider: notice.provider, from: notice.from },
    });
    await queryClient.invalidateQueries({ queryKey: NOTICES_KEY });
  };

  return (
    <div
      role="status"
      className="border-yellow-500/35 bg-yellow-300/15 mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-yellow-950 dark:border-yellow-300/35 dark:bg-yellow-400/15 dark:text-yellow-100"
    >
      <div className="min-w-0">
        <div className="text-[13px] font-semibold">
          {t("models.retiredNotice.title", {
            provider:
              PROVIDER_DISPLAY_NAMES[notice.provider] ?? notice.provider,
            from: notice.from,
          })}
        </div>
        <p className="mt-0.5 text-[12px] leading-snug opacity-80">
          {t("models.retiredNotice.desc", { to: notice.to })}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void dismiss();
            navigate("/settings/models?pick=llm");
          }}
        >
          {t("models.retiredNotice.action")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void dismiss()}>
          {t("models.retiredNotice.dismiss")}
        </Button>
      </div>
    </div>
  );
}
