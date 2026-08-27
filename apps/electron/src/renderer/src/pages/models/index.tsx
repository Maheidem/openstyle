import type { LlmTaskId } from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import type { AvailableModel } from "@renderer/lib/models";
import { settingsQueryOptions } from "@renderer/lib/query";
import { cn, ON_DEVICE_PHRASE } from "@renderer/lib/utils";
import { SETTINGS_KEYS } from "@shared/settings-keys";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle,
  Info,
  Key,
  Loader2,
  Pencil,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { MlxWarmingDialog } from "./mlx-memory-section";
import { ConfirmDialog, type ModalState, ModelModal } from "./model-modal";
import { Eyebrow, PageHeader, PageShell } from "./page-chrome";
import { PairCard } from "./pair-card";
import { TaskProfilesSection } from "./task-profiles-section";
import type { ApiKeyEntry, ConfiguredModel } from "./types";
import { useModels } from "./use-models";
import { displayName } from "./utils";

export default function ModelsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const m = useModels();
  const navigate = useNavigate();

  // Advanced mode gates this page in the sidebar. When it's off, the page can
  // still be reached directly (deep link / redirect); surface a banner that
  // points the user to the toggle instead of silently hiding functionality.
  const { data: settings } = useQuery(settingsQueryOptions());
  const advancedMode = settings?.[SETTINGS_KEYS.advancedMode] === "true";

  const [modal, setModal] = useState<ModalState | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const [pendingLocalDelete, setPendingLocalDelete] = useState<{
    defId: string;
    engine?: "whisper" | "mlx";
    name: string;
  } | null>(null);
  const [pendingProviderDelete, setPendingProviderDelete] = useState<
    string | null
  >(null);
  const [warmingOpen, setWarmingOpen] = useState(false);
  // Which task profile row is expanded — lifted here (rather than owned by
  // TaskProfilesSection) so the cleanup PairSide's "Sampling parameters"
  // link (§9.5) can jump straight to the cleanup row from outside the
  // section.
  const [expandedTask, setExpandedTask] = useState<LlmTaskId | null>(null);
  const taskProfilesRef = useRef<HTMLDivElement>(null);
  // Scrolling has to wait for the expanded row to actually be in the DOM —
  // firing scrollIntoView in the same tick as setExpandedTask targets the
  // still-collapsed section, then the row expands underneath it and shifts
  // the layout. A pending flag defers the scroll to the effect that runs
  // after the expand commits.
  const [pendingScrollToCleanup, setPendingScrollToCleanup] = useState(false);
  useEffect(() => {
    if (!pendingScrollToCleanup) return;
    taskProfilesRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    setPendingScrollToCleanup(false);
  }, [pendingScrollToCleanup]);

  // -------------------------------------------------------------------------
  // Modal flow
  // -------------------------------------------------------------------------

  const closeModal = (): void => {
    setModal(null);
    setKeyError(null);
    setSaving(false);
  };

  const configureVoice = (
    model: AvailableModel,
    { closeAfter = false }: { closeAfter?: boolean } = {},
  ): void => {
    const needsKey =
      model.provider_id !== "local-llm" &&
      !m.keyProviders.has(model.provider_id);
    if (needsKey) {
      setKeyError(null);
      setModal({
        kind: "key",
        type: "voice",
        provider: model.provider_id,
        modelName: model.model_name,
        pendingModel: model,
      });
      return;
    }
    void m.configureModel(model, "voice").then(() => {
      if (closeAfter) closeModal();
    });
  };

  const openVoice = (): void =>
    setModal({ kind: "list", type: "voice", voiceView: "tiers" });

  const openLlm = (): void => {
    m.setCleanup(true);
    setModal({ kind: "list", type: "llm", llmView: "tiers" });
  };

  const onToggleCleanup = (next: boolean): void => {
    if (!next) {
      m.setCleanup(false);
      return;
    }
    m.setCleanup(true);
    if (!m.defaultLlm) {
      openLlm();
    }
  };

  const onPickCloud = (model: AvailableModel): void => {
    if (modal?.kind !== "list") return;
    const type = modal.type;

    if (type === "voice") {
      configureVoice(model, { closeAfter: true });
      return;
    }

    const needsKey =
      model.provider_id !== "local-llm" &&
      !m.keyProviders.has(model.provider_id);
    if (needsKey) {
      setKeyError(null);
      setModal({
        kind: "key",
        type,
        provider: model.provider_id,
        modelName: model.model_name,
        pendingModel: model,
      });
      return;
    }
    void m.configureModel(model, type).then(closeModal);
  };

  const onPickLocalVoice = (
    defId: string,
    name: string,
    engine?: "whisper" | "mlx",
  ): void => {
    void m.selectLocalVoice(defId, name, engine).then(() => {
      if (modal?.kind === "list") closeModal();
    });
  };

  const onRequestDeleteLocal = (
    defId: string,
    engine?: "whisper" | "mlx",
  ): void => {
    const item = m.voiceItems.find(
      (row) => row.defId === defId && row.localEngine === engine,
    );
    setPendingLocalDelete({ defId, engine, name: item?.name ?? defId });
  };

  const onBack = (): void => {
    if (modal?.kind !== "key") return;
    if (modal.type === "voice") {
      setModal({ kind: "list", type: "voice", voiceView: "tiers" });
    } else if (modal.type === "llm") {
      setModal({ kind: "list", type: "llm", llmView: "tiers" });
    } else {
      closeModal();
    }
  };

  const onSaveKey = (key: string): void => {
    if (modal?.kind !== "key") return;
    const { provider, pendingModel, type } = modal;
    setSaving(true);
    setKeyError(null);
    void (async () => {
      const err = await m.saveKey(provider, key);
      if (err) {
        setKeyError(err);
        setSaving(false);
        return;
      }
      if (pendingModel && type) {
        await m.configureModel(pendingModel, type);
      }
      closeModal();
    })();
  };

  const showMlxWarming = m.defaultVoice?.provider === "local-mlx";
  // Every task row is meaningful regardless of the effective provider — the
  // mapped-subset tier still applies temperature/max_tokens/top_p to cloud
  // models (specs/llm-task-profiles.md §7, §9.1) — so this is advanced-only,
  // not also gated on `local-llm` the way the retired sampling dialog was.
  const showParams = advancedMode;

  const onOpenCleanupParams = (): void => {
    setExpandedTask("cleanup");
    setPendingScrollToCleanup(true);
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (m.loading) {
    return (
      <PageShell>
        <PageHeader title={t("models.title")} />
        <ModelsLoadingSkeleton />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader title={t("models.title")} />
      {!advancedMode && (
        <AdvancedModeBanner
          onEnable={() => navigate("/settings#application")}
        />
      )}
      <div className="space-y-6">
        <PairCard
          voice={m.defaultVoice}
          llm={m.defaultLlm}
          llmCleanup={m.llmCleanup}
          onToggleCleanup={onToggleCleanup}
          onChangeVoice={openVoice}
          onChangeLlm={openLlm}
          onConfigureWarming={
            showMlxWarming ? () => setWarmingOpen(true) : undefined
          }
          onConfigureSampling={showParams ? onOpenCleanupParams : undefined}
        />

        {showParams && (
          <div ref={taskProfilesRef}>
            <TaskProfilesSection
              taskAssignments={m.taskAssignments}
              userPresets={m.userPresets}
              configured={m.configured}
              defaultLlm={m.defaultLlm}
              cleanupSampling={m.cleanupSampling}
              expandedTask={expandedTask}
              onExpandedTaskChange={setExpandedTask}
              onSaveAssignment={m.saveTaskAssignment}
              onResetAssignment={m.resetTaskAssignment}
              onSavePreset={m.saveUserPreset}
            />
          </div>
        )}

        <KeysSection
          apiKeys={m.apiKeys}
          configured={m.configured}
          deletingProviders={m.deletingProviders}
          onEdit={(provider) =>
            setModal({
              kind: "key",
              type: null,
              provider,
              pendingModel: null,
            })
          }
          onDelete={setPendingProviderDelete}
        />
      </div>

      {warmingOpen && (
        <MlxWarmingDialog
          keepAliveMinutes={m.mlxKeepAliveMinutes}
          blockedReason={m.mlxStatus?.blockedReason ?? null}
          onChange={m.saveMlxKeepAliveMinutes}
          onClose={() => setWarmingOpen(false)}
        />
      )}

      {modal && (
        <ModelModal
          modal={modal}
          m={m}
          saving={saving}
          keyError={keyError}
          onClose={closeModal}
          onPickCloud={onPickCloud}
          onPickLocalVoice={onPickLocalVoice}
          onRequestDeleteLocal={onRequestDeleteLocal}
          onBack={onBack}
          onSaveKey={onSaveKey}
        />
      )}

      {pendingLocalDelete && (
        <ConfirmDialog
          title={t("models.deleteLocalTitle")}
          message={
            <Trans
              i18nKey="models.deleteLocalMsg"
              values={{
                name: pendingLocalDelete.name,
                phrase: ON_DEVICE_PHRASE,
              }}
              components={{
                b: <span className="text-foreground/80 font-medium" />,
              }}
            />
          }
          onCancel={() => setPendingLocalDelete(null)}
          onConfirm={() => {
            const { defId, engine } = pendingLocalDelete;
            setPendingLocalDelete(null);
            void m.deleteLocal(defId, engine);
          }}
        />
      )}

      {pendingProviderDelete && (
        <ConfirmDialog
          title={t("models.deleteProviderTitle")}
          message={
            <>
              <Trans
                i18nKey="models.deleteProviderMsgBase"
                values={{ provider: displayName(pendingProviderDelete) }}
                components={{
                  b: <span className="text-foreground/80 font-medium" />,
                }}
              />
              {(m.defaultVoice?.provider === pendingProviderDelete ||
                m.defaultLlm?.provider === pendingProviderDelete) &&
                t("models.deleteProviderCurrentSuffix")}
              .
            </>
          }
          onCancel={() => setPendingProviderDelete(null)}
          onConfirm={() => {
            const provider = pendingProviderDelete;
            setPendingProviderDelete(null);
            void m.deleteProvider(provider);
          }}
        />
      )}
    </PageShell>
  );
}

function AdvancedModeBanner({
  onEnable,
}: {
  onEnable: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="border-border mb-6 flex items-start gap-3 rounded-lg border bg-muted/40 px-4 py-3">
      <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground/90 text-[13px] leading-relaxed">
          {t("models.advancedModeBanner")}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={onEnable}
      >
        {t("models.advancedModeBannerAction")}
      </Button>
    </div>
  );
}

function SkeletonLine({
  className,
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "bg-muted/60 relative overflow-hidden rounded-full",
        "before:absolute before:inset-0 before:-translate-x-full before:animate-[shimmer_1.4s_infinite] before:bg-gradient-to-r before:from-transparent before:via-white/10 before:to-transparent",
        className,
      )}
    />
  );
}

function ModelsLoadingSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-6" role="status" aria-label="Loading models">
      <style>{`
        @keyframes shimmer {
          100% { transform: translateX(100%); }
        }
      `}</style>
      <section className="border-border bg-card grid grid-cols-1 gap-6 rounded-lg border p-6 min-[820px]:grid-cols-2">
        {["voice", "cleanup"].map((key) => (
          <div
            key={key}
            className={cn(
              "flex min-h-[140px] flex-col gap-3",
              key === "cleanup" &&
                "border-border border-t pt-6 min-[820px]:border-l min-[820px]:border-t-0 min-[820px]:pl-6 min-[820px]:pt-0",
            )}
          >
            <SkeletonLine className="h-3 w-40" />
            <SkeletonLine className="h-6 w-52 max-w-full" />
            <SkeletonLine className="h-3 w-32" />
            <div className="mt-auto flex items-center gap-3">
              <SkeletonLine className="h-9 w-24 rounded-md" />
              <SkeletonLine className="h-5 w-28" />
            </div>
          </div>
        ))}
      </section>

      <section>
        <SkeletonLine className="h-3 w-28" />
        <div className="border-border bg-card mt-3 overflow-hidden rounded-lg border">
          {[0, 1].map((i) => (
            <div
              key={i}
              className={cn(
                "flex items-center justify-between gap-4 px-[18px] py-[13px]",
                i > 0 && "border-border border-t",
              )}
            >
              <SkeletonLine className="h-4 w-40" />
              <SkeletonLine className="h-8 w-16 rounded-md" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KeysSection — compact list of stored provider keys (edit / remove)
// ---------------------------------------------------------------------------

function KeysSection({
  apiKeys,
  configured,
  deletingProviders,
  onEdit,
  onDelete,
}: {
  apiKeys: ApiKeyEntry[];
  configured: ConfiguredModel[];
  deletingProviders: Set<string>;
  onEdit: (provider: string) => void;
  onDelete: (provider: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (apiKeys.length === 0) {
    return (
      <p className="text-muted-foreground text-[13px]">
        {t("models.noApiKeys")}
      </p>
    );
  }

  return (
    <section>
      <div className="mb-3">
        <Eyebrow text={t("models.apiKeys")} />
      </div>
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        {apiKeys.map((entry, i) => (
          <KeyRow
            key={entry.provider}
            entry={entry}
            count={
              configured.filter((c) => c.provider === entry.provider).length
            }
            first={i === 0}
            deleting={deletingProviders.has(entry.provider)}
            onEdit={() => onEdit(entry.provider)}
            onDelete={() => onDelete(entry.provider)}
          />
        ))}
      </div>
    </section>
  );
}

function KeyRow({
  entry,
  count,
  first,
  deleting,
  onEdit,
  onDelete,
}: {
  entry: ApiKeyEntry;
  count: number;
  first: boolean;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const invalid = entry.status === "invalid";
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-[18px] py-[13px]",
        !first && "border-border border-t",
      )}
    >
      <Key className="text-muted-foreground h-[15px] w-[15px] shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground text-[13.5px] font-semibold">
            {displayName(entry.provider)}
          </span>
          {entry.status === "valid" && (
            <CheckCircle className="text-primary h-3.5 w-3.5 shrink-0" />
          )}
          {invalid && (
            <XCircle className="text-destructive h-3.5 w-3.5 shrink-0" />
          )}
        </div>
        <div className="mono text-muted-foreground mt-0.5 text-[11px]">
          {invalid ? (
            <span className="text-destructive">{t("models.keyInvalid")}</span>
          ) : entry.hint ? (
            t("models.keyStoredWithHint", { hint: entry.hint })
          ) : (
            t("models.keyStored")
          )}
        </div>
      </div>
      <span className="text-muted-foreground text-[11.5px]">
        {count}{" "}
        {count === 1 ? t("models.modelSingular") : t("models.modelPlural")}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onEdit}
          disabled={deleting}
          className="text-muted-foreground hover:text-foreground"
          aria-label={t("models.keyUpdate")}
          title={t("models.keyUpdate")}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          disabled={deleting}
          className="text-muted-foreground hover:text-destructive"
          aria-label={t("models.keyDelete")}
          title={t("models.keyDelete")}
        >
          {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </Button>
      </div>
    </div>
  );
}
