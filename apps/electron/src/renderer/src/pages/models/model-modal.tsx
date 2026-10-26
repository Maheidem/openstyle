import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@renderer/components/ui/input-group";
import { RevealToggle } from "@renderer/components/ui/reveal-toggle";
import {
  type AvailableModel,
  displayProviderName,
  type LocalEngine,
  type LocalLlmItem,
  PROVIDER_KEY_URLS,
} from "@renderer/lib/models";
import { AlertTriangle, Key, Loader2, X } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { ModelList } from "./model-list";
import type { ServerView } from "./server-roles";
import type { UseModels } from "./use-models";

// ---------------------------------------------------------------------------
// Modal state — owned by the page; the modal renders from it.
// ---------------------------------------------------------------------------

export type ModalState =
  | { kind: "list"; type: "voice" | "llm" }
  | {
      kind: "key";
      /** Slot to return to on Back; null = standalone key edit. */
      type: "voice" | "llm" | null;
      provider: string;
      modelName?: string;
      /** Model to configure after the key is saved (null for edits). */
      pendingModel: AvailableModel | null;
    };

// ---------------------------------------------------------------------------
// Shared modal shell
// ---------------------------------------------------------------------------

function Backdrop({
  onClose,
  label,
  children,
}: {
  onClose: () => void;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-label={label}
        showCloseButton={false}
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden p-0 sm:max-w-2xl"
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ModelModal
// ---------------------------------------------------------------------------

export function ModelModal({
  modal,
  m,
  saving,
  keyError,
  onClose,
  onPickCloud,
  onPickLocalVoice,
  onPickServerModel,
  onRequestDeleteLocal,
  onRequestWontFitDownload,
  onRequestRemoveServer,
  onBack,
  onSaveKey,
}: {
  modal: ModalState;
  m: UseModels;
  saving: boolean;
  keyError: string | null;
  onClose: () => void;
  onPickCloud: (model: AvailableModel) => void;
  onPickLocalVoice: (
    defId: string,
    name: string,
    engine?: "whisper" | "mlx",
  ) => void;
  onPickServerModel: (serverId: string, modelId: string) => void;
  onRequestDeleteLocal: (defId: string, engine?: LocalEngine) => void;
  onRequestWontFitDownload: (item: LocalLlmItem) => void;
  onRequestRemoveServer: (server: ServerView) => void;
  onBack: () => void;
  onSaveKey: (key: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (modal.kind === "key") {
    return (
      <Backdrop onClose={onClose} label={t("models.modal.addApiKey")}>
        <KeyStep
          provider={modal.provider}
          modelName={modal.modelName}
          canGoBack={modal.type !== null}
          saving={saving}
          error={keyError}
          onBack={onBack}
          onClose={onClose}
          onSave={onSaveKey}
        />
      </Backdrop>
    );
  }

  return (
    <Backdrop
      onClose={onClose}
      label={
        modal.type === "voice"
          ? t("models.modal.chooseVoice")
          : t("models.modal.pickLlm")
      }
    >
      <ModelList
        type={modal.type}
        m={m}
        onClose={onClose}
        onPickCloud={onPickCloud}
        onPickLocalVoice={onPickLocalVoice}
        onPickServerModel={onPickServerModel}
        onRequestDeleteLocal={onRequestDeleteLocal}
        onRequestWontFitDownload={onRequestWontFitDownload}
        onRequestRemoveServer={onRequestRemoveServer}
      />
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Key step
// ---------------------------------------------------------------------------

function KeyStep({
  provider,
  modelName,
  canGoBack,
  saving,
  error,
  onBack,
  onClose,
  onSave,
}: {
  provider: string;
  modelName?: string;
  canGoBack: boolean;
  saving: boolean;
  error: string | null;
  onBack: () => void;
  onClose: () => void;
  onSave: (key: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const providerLabel = displayProviderName(provider);

  return (
    <div className="p-7">
      <div className="mb-4 flex items-start gap-3.5">
        <div className="bg-accent/60 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border">
          <Key className="text-accent-foreground h-[18px] w-[18px]" />
        </div>
        <div className="flex-1">
          <h3 className="text-foreground m-0 text-[17px] font-semibold">
            {t("models.modal.keyTitle", { provider: providerLabel })}
          </h3>
          <p className="text-muted-foreground mt-1 text-[13px] leading-relaxed">
            {modelName ? (
              <Trans
                i18nKey="models.modal.keyNeeded"
                values={{ provider: providerLabel, name: modelName }}
                components={{
                  model: (
                    <span className="text-foreground/80 font-medium">
                      {modelName}
                    </span>
                  ),
                }}
              />
            ) : (
              t("models.modal.keyNew", { provider: providerLabel })
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <X />
        </Button>
      </div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSave(value.trim());
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <Key />
          </InputGroupAddon>
          <InputGroupInput
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("models.modal.keyPlaceholder")}
            aria-invalid={!!error}
            autoFocus
            className="mono"
          />
          <RevealToggle
            revealed={show}
            onToggle={() => setShow(!show)}
            label={t("common.reveal.apiKey")}
          />
        </InputGroup>
        {error && (
          <div className="bg-destructive/10 flex items-start gap-2 rounded-md px-3 py-2">
            <AlertTriangle className="text-destructive mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p className="text-destructive text-xs">{error}</p>
          </div>
        )}
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-[11px] font-medium">
            {t("models.modal.keyStoredNote")}
          </p>
          {PROVIDER_KEY_URLS[provider] && (
            <a
              href={PROVIDER_KEY_URLS[provider]}
              target="_blank"
              rel="noreferrer"
              className="text-primary text-[12px] underline underline-offset-2"
            >
              {t("models.modal.keyGet", { provider: providerLabel })}
            </a>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={canGoBack ? onBack : onClose}
          >
            {canGoBack ? t("common.back") : t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={!value.trim() || saving}>
            {saving ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("models.modal.keyChecking")}
              </span>
            ) : (
              t("models.modal.keySaveUse")
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfirmDialog — single reusable confirm (destructive by default)
// ---------------------------------------------------------------------------

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmVariant = "destructive",
  onCancel,
  onConfirm,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  /** "default" for a confirm that deletes nothing (a download warning). */
  confirmVariant?: "destructive" | "default";
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant={confirmVariant} onClick={onConfirm}>
            {confirmLabel ?? t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
