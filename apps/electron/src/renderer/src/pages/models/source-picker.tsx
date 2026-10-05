import { SERVER_PROVIDER_ID } from "@openstyle/validations";
import type { ConfiguredModel } from "@renderer/lib/models";
import { displayProviderName } from "@renderer/lib/models";
import { ON_DEVICE_PHRASE } from "@renderer/lib/utils";
import {
  Cloud,
  Laptop,
  type LucideIcon,
  Mic,
  Server,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  PICKER_MODAL_BODY,
  PickerModalHeader,
  PickerOption,
} from "./picker-option";
import { kindFitsRole, type ModelRole } from "./server-roles";
import type { UseModels } from "./use-models";

/** Who runs the model (specs/model-picker-groups.md section 1). */
export type PickerGroup = "builtin" | "server" | "cloud";

const BUILTIN_PROVIDERS = new Set(["local-whisper", "local-mlx"]);

function groupOf(model: ConfiguredModel | undefined): PickerGroup | null {
  if (!model) return null;
  if (BUILTIN_PROVIDERS.has(model.provider)) return "builtin";
  if (model.provider === SERVER_PROVIDER_ID) return "server";
  return "cloud";
}

interface GroupRow {
  group: PickerGroup;
  icon: LucideIcon;
  title: string;
  description: string;
  hint: string;
  browseLabel: string;
}

/**
 * Top level of a model picker: one row per group. Transcription shows three
 * groups. The LLM roles show two, because Openstyle has no built-in LLM.
 */
export function SourcePicker({
  role,
  m,
  onClose,
  onBrowse,
}: {
  role: ModelRole;
  m: UseModels;
  onClose: () => void;
  onBrowse: (group: PickerGroup) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const selected = role === "voice" ? m.defaultVoice : m.defaultLlm;
  const activeGroup = groupOf(selected);
  const selectedName = selected?.model_name ?? "";

  const rows: GroupRow[] = [];

  if (role === "voice") {
    const localItems = m.voiceItems.filter((it) => it.kind === "local");
    const selectedLocal = localItems.find((it) => it.selected);
    rows.push({
      group: "builtin",
      icon: Laptop,
      title: t("models.picker.builtIn"),
      description: t("models.picker.builtInDesc", { phrase: ON_DEVICE_PHRASE }),
      hint:
        activeGroup === "builtin"
          ? (selectedLocal?.name ?? selectedName)
          : localItems.length > 0
            ? t("models.picker.modelCount", { count: localItems.length })
            : t("models.picker.unavailableOnDevice"),
      browseLabel: t("models.picker.browseBuiltIn"),
    });
  }

  const reachable = m.servers.servers.filter((s) => s.reachable);
  const serverModelCount = reachable.reduce(
    (sum, s) =>
      sum + s.models.filter((it) => kindFitsRole(it.kind, role)).length,
    0,
  );
  rows.push({
    group: "server",
    icon: Server,
    title: t("models.picker.ownServer"),
    description: t("models.picker.ownServerDesc"),
    hint:
      activeGroup === "server"
        ? selectedName
        : m.servers.loading
          ? t("common.checking")
          : reachable.length > 0
            ? t("models.picker.modelCount", { count: serverModelCount })
            : t("models.picker.ownServerNone"),
    browseLabel: t("models.picker.browseOwnServer"),
  });

  rows.push({
    group: "cloud",
    icon: Cloud,
    title: t("models.picker.cloud"),
    description: t("models.picker.cloudDesc"),
    hint:
      activeGroup === "cloud" && selected
        ? selectedName || displayProviderName(selected.provider)
        : t("models.picker.byokProviders"),
    browseLabel: t("models.picker.browseCloud"),
  });

  return (
    <>
      <PickerModalHeader
        icon={role === "voice" ? Mic : Sparkles}
        title={
          role === "voice"
            ? t("models.picker.transcription")
            : t("models.picker.cleanup")
        }
        onClose={onClose}
      />
      <div className={PICKER_MODAL_BODY}>
        <div className="border-border divide-border overflow-hidden rounded-lg border divide-y">
          {rows.map((row) => (
            <PickerOption
              key={row.group}
              icon={row.icon}
              title={row.title}
              description={row.description}
              hint={row.hint}
              active={activeGroup === row.group}
              onClick={() => onBrowse(row.group)}
              browseLabel={row.browseLabel}
            />
          ))}
        </div>
      </div>
    </>
  );
}
