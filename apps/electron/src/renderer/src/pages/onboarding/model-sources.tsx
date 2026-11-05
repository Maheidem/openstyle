import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import {
  InputGroup,
  InputGroupInput,
} from "@renderer/components/ui/input-group";
import { RevealToggle } from "@renderer/components/ui/reveal-toggle";
import {
  displayProviderName,
  formatBytes,
  type LocalLlmItem,
  PROVIDER_KEY_URLS,
  type VoiceItem,
} from "@renderer/lib/models";
import { cn } from "@renderer/lib/utils";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelRole } from "../models/server-roles";
import type { RemoteSource } from "./use-remote-source";

// ---------------------------------------------------------------------------
// The parts of "Choose another" (specs/onboarding.md section 3). One source
// picker for the voice model and the same one for the text model. Each has the
// sources "On this Mac", "My own server" and "Cloud provider".
// ---------------------------------------------------------------------------

export function SourcePills<T extends string>({
  value,
  options,
  onChange,
  testId,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
  testId: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2" data-testid={testId}>
      {options.map((o) => (
        <Button
          key={o.id}
          size="sm"
          variant={value === o.id ? "default" : "outline"}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          data-testid={`${testId}-${o.id}`}
          className="rounded-full px-4 text-[13px]"
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

function Chip({
  tone,
  children,
}: {
  tone: "ok" | "rec" | "warn" | "plain";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "mono rounded-[6px] px-1.5 py-0.5 text-[10px] tracking-[0.08em] whitespace-nowrap uppercase",
        tone === "ok" &&
          "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        tone === "rec" && "bg-primary/10 text-primary",
        tone === "warn" && "bg-amber-500/15 text-amber-800 dark:text-amber-300",
        tone === "plain" && "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function Row({
  on,
  onPick,
  testId,
  children,
}: {
  on: boolean;
  onPick: () => void;
  testId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      data-testid={testId}
      className={cn(
        "bg-card mb-2 flex w-full items-start gap-3 rounded-[12px] border-[1.5px] px-3.5 py-3 text-left transition-colors",
        on
          ? "border-primary"
          : "border-border hover:border-muted-foreground/50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 size-4 shrink-0 rounded-full border-[1.5px]",
          on ? "border-foreground border-[5px]" : "border-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

function fitChip(
  label: string | undefined,
  t: (key: string) => string,
): React.JSX.Element | null {
  if (!label) return null;
  return (
    <Chip tone={label === "runs_well" ? "ok" : "warn"}>
      {t(`onboarding.model.fit.${label}`)}
    </Chip>
  );
}

/** The voice models on this Mac. A row that "Won't fit" shows only in the long list. */
export function VoiceMacRows({
  items,
  selectedKey,
  recommendedKey,
  fit,
  expanded,
  onToggleExpanded,
  onPick,
  workerBytes,
}: {
  items: VoiceItem[];
  selectedKey: string | null;
  recommendedKey: string | undefined;
  fit: Record<string, string> | undefined;
  expanded: boolean;
  onToggleExpanded: () => void;
  onPick: (item: VoiceItem) => void;
  workerBytes: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  const shown = items.filter((i) => expanded || i.key === selectedKey);
  return (
    <div>
      {shown.map((item) => {
        const on = item.key === selectedKey;
        const meta = [
          item.sizeBytes ? formatBytes(item.sizeBytes) : null,
          item.speed ? t(`onboarding.model.speed.${item.speed}`) : null,
          item.quality ? t(`onboarding.model.quality.${item.quality}`) : null,
          item.localEngine === "whisper"
            ? t("onboarding.model.languages99")
            : null,
          item.localEngine === "mlx" && workerBytes > 0
            ? t("onboarding.model.helper", { size: formatBytes(workerBytes) })
            : null,
        ].filter(Boolean);
        return (
          <Row
            key={item.key}
            on={on}
            onPick={() => onPick(item)}
            testId={`onboarding-voice-row-${item.defId}`}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-foreground text-[14px] font-semibold">
                {item.name}
              </span>
              {item.key === recommendedKey && (
                <Chip tone="rec">{t("onboarding.model.recommended")}</Chip>
              )}
              {fitChip(fit?.[item.modelId], t)}
            </span>
            <span className="text-muted-foreground mt-1 block text-[12.5px] leading-snug">
              {meta.join(" · ")}
            </span>
          </Row>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        onClick={onToggleExpanded}
        data-testid="onboarding-voice-alt"
      >
        {expanded
          ? t("onboarding.model.showFewer")
          : t("onboarding.model.changeVoice")}
      </Button>
    </div>
  );
}

/** The text models on this Mac, with "Not now" as the last row. */
export function TextMacRows({
  items,
  selectedDefId,
  recommendedDefId,
  none,
  expanded,
  onToggleExpanded,
  onPick,
}: {
  items: LocalLlmItem[];
  /** The catalog id of the chosen model, or null. */
  selectedDefId: string | null;
  recommendedDefId: string | undefined;
  /** "Not now" is the choice. */
  none: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onPick: (pick: string | "none") => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const ordered = [...items].sort(
    (a, b) =>
      Number(b.defId === recommendedDefId) -
      Number(a.defId === recommendedDefId),
  );
  const shown = ordered.filter((i) =>
    expanded ? true : !none && i.defId === selectedDefId,
  );
  return (
    <div>
      {shown.map((item) => (
        <Row
          key={item.key}
          on={!none && item.defId === selectedDefId}
          onPick={() => onPick(item.defId)}
          testId={`onboarding-text-row-${item.defId}`}
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-foreground text-[14px] font-semibold">
              {item.name}
            </span>
            {item.defId === recommendedDefId && (
              <Chip tone="rec">{t("onboarding.model.recommended")}</Chip>
            )}
            {fitChip(item.fit.label, t)}
          </span>
          <span className="text-muted-foreground mt-1 block text-[12.5px] leading-snug">
            {t("onboarding.model.textMeta", {
              size: formatBytes(item.sizeBytes),
            })}
          </span>
        </Row>
      ))}
      {(expanded || none) && (
        <Row
          on={none}
          onPick={() => onPick("none")}
          testId="onboarding-text-row-none"
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-foreground text-[14px] font-semibold">
              {t("onboarding.model.notNow")}
            </span>
            <Chip tone="plain">{t("onboarding.model.optional")}</Chip>
          </span>
          <span className="text-muted-foreground mt-1 block text-[12.5px] leading-snug">
            {t("onboarding.model.notNowDesc")}
          </span>
        </Row>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={onToggleExpanded}
        data-testid="onboarding-text-alt"
      >
        {expanded
          ? t("onboarding.model.showFewer")
          : t("onboarding.model.changeText")}
      </Button>
    </div>
  );
}

const SERVER_ERROR_KEYS: Record<string, string> = {
  unreachable: "models.servers.unreachable",
  unauthorized: "models.servers.unauthorized",
  not_openai: "models.servers.notOpenai",
  duplicate: "models.servers.duplicate",
  invalid: "models.servers.addFailed",
  failed: "models.servers.addFailed",
};

/** "My own server": address, key, test, then the models of that server. */
export function ServerForm({
  kind,
  remote,
}: {
  kind: ModelRole;
  remote: RemoteSource;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [showKey, setShowKey] = useState(false);
  const testing = remote.serverTest.state === "testing";
  const prefix = kind === "voice" ? "voice" : "text";
  return (
    <div data-testid={`onboarding-${prefix}-server`}>
      <p className="text-muted-foreground mt-1 mb-0 text-[12.5px]">
        {t(
          `onboarding.model.server.${kind === "voice" ? "voiceNote" : "textNote"}`,
        )}
      </p>
      <label
        htmlFor={`onboarding-${prefix}-server-url`}
        className="text-muted-foreground mt-3 mb-1 block text-[12.5px]"
      >
        {t("models.servers.address")}
      </label>
      <div>
        <Input
          id={`onboarding-${prefix}-server-url`}
          type="text"
          className="mt-1"
          value={remote.serverUrl}
          onChange={(e) => remote.setServerUrl(e.target.value)}
          placeholder="http://127.0.0.1:8123"
          data-testid={`onboarding-${prefix}-server-url`}
        />
      </div>
      <label
        htmlFor={`onboarding-${prefix}-server-key`}
        className="text-muted-foreground mt-3 mb-1 block text-[12.5px]"
      >
        {t("models.servers.keyOptional")}
      </label>
      <div>
        <InputGroup className="mt-1">
          <InputGroupInput
            id={`onboarding-${prefix}-server-key`}
            type={showKey ? "text" : "password"}
            value={remote.serverKey}
            onChange={(e) => remote.setServerKey(e.target.value)}
            data-testid={`onboarding-${prefix}-server-key`}
          />
          <RevealToggle
            revealed={showKey}
            onToggle={() => setShowKey(!showKey)}
            label={t("common.reveal.apiKey")}
          />
        </InputGroup>
      </div>
      <div className="mt-2.5">
        <Button
          size="sm"
          variant="outline"
          disabled={testing || !remote.serverUrl.trim()}
          onClick={() => void remote.testServer()}
          data-testid={`onboarding-${prefix}-server-test`}
        >
          {testing && (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          )}
          {testing
            ? t("onboarding.model.testing")
            : t("onboarding.model.testConnection")}
        </Button>
      </div>
      {remote.serverTest.state === "fail" && (
        <p
          role="alert"
          data-testid={`onboarding-${prefix}-server-error`}
          className="bg-destructive/10 text-destructive mt-2.5 rounded-[10px] px-3 py-2.5 text-[12.5px] leading-snug"
        >
          {t(
            SERVER_ERROR_KEYS[remote.serverTest.error] ??
              "models.servers.addFailed",
          )}{" "}
          {t("onboarding.model.server.failHint")}
        </p>
      )}
      {remote.serverTest.state === "ok" && (
        <div data-testid={`onboarding-${prefix}-server-ok`}>
          <p className="mt-2.5 mb-2 rounded-[10px] bg-emerald-500/10 px-3 py-2.5 text-[12.5px] text-emerald-800 dark:text-emerald-300">
            {t("onboarding.model.server.connected", {
              count: remote.serverModels.length,
            })}
          </p>
          {remote.serverModels.length === 0 ? (
            <p className="text-muted-foreground text-[12.5px]">
              {t(`onboarding.model.server.noModels.${kind}`)}
            </p>
          ) : (
            <>
              <div className="text-muted-foreground mono mb-1.5 text-[10.5px] tracking-[0.1em] uppercase">
                {t(`onboarding.model.server.pick.${kind}`)}
              </div>
              {remote.serverModels.map((name) => (
                <Row
                  key={name}
                  on={remote.serverModel === name}
                  onPick={() => remote.setServerModel(name)}
                  testId={`onboarding-${prefix}-server-model-${name}`}
                >
                  <span className="text-foreground text-[13.5px] font-medium">
                    {name}
                  </span>
                </Row>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** "Cloud provider": provider, key, test. The key is saved when the user continues. */
export function CloudForm({
  kind,
  remote,
  providers,
  loading,
  modelName,
}: {
  kind: ModelRole;
  remote: RemoteSource;
  providers: string[];
  /** The list of cloud models is not there yet. */
  loading: boolean;
  /** The model that the provider gives by default, for the "Key works" line. */
  modelName: string | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [showKey, setShowKey] = useState(false);
  const prefix = kind === "voice" ? "voice" : "text";
  const testing = remote.keyTest.state === "testing";
  const providerName = displayProviderName(remote.provider);
  return (
    <div data-testid={`onboarding-${prefix}-cloud`}>
      <p className="text-muted-foreground mt-1 mb-0 text-[12.5px]">
        {t(
          `onboarding.model.cloud.${kind === "voice" ? "voiceNote" : "textNote"}`,
        )}
      </p>
      {loading && providers.length === 0 && (
        <p className="text-muted-foreground mt-3 mb-0 text-[12.5px]">
          {t("models.loading")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {providers.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={remote.provider === p ? "default" : "outline"}
            aria-pressed={remote.provider === p}
            onClick={() => remote.setProvider(p)}
            data-testid={`onboarding-${prefix}-provider-${p}`}
            className="rounded-full px-4 text-[13px]"
          >
            {displayProviderName(p)}
          </Button>
        ))}
      </div>
      <label
        htmlFor={`onboarding-${prefix}-cloud-key`}
        className="text-muted-foreground mt-3 mb-1 block text-[12.5px]"
      >
        {t("onboarding.model.cloud.keyLabel", { provider: providerName })}
      </label>
      <div>
        <InputGroup className="mt-1">
          <InputGroupInput
            id={`onboarding-${prefix}-cloud-key`}
            type={showKey ? "text" : "password"}
            value={remote.cloudKey}
            onChange={(e) => remote.setCloudKey(e.target.value)}
            placeholder={t("models.modal.keyPlaceholder")}
            data-testid={`onboarding-${prefix}-cloud-key`}
          />
          <RevealToggle
            revealed={showKey}
            onToggle={() => setShowKey(!showKey)}
            label={t("common.reveal.apiKey")}
          />
        </InputGroup>
      </div>
      <div className="mt-2.5 flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={testing || !remote.cloudKey.trim()}
          onClick={() => void remote.testCloud()}
          data-testid={`onboarding-${prefix}-cloud-test`}
        >
          {testing && (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          )}
          {testing
            ? t("onboarding.model.testing")
            : t("onboarding.model.testKey")}
        </Button>
        {PROVIDER_KEY_URLS[remote.provider] && (
          <a
            href={PROVIDER_KEY_URLS[remote.provider]}
            target="_blank"
            rel="noreferrer"
            className="text-primary text-[12px] underline underline-offset-2"
          >
            {t("models.modal.keyGet", { provider: providerName })}
          </a>
        )}
      </div>
      {remote.keyTest.state === "ok" && (
        <p
          data-testid={`onboarding-${prefix}-cloud-ok`}
          className="mt-2.5 rounded-[10px] bg-emerald-500/10 px-3 py-2.5 text-[12.5px] text-emerald-800 dark:text-emerald-300"
        >
          {t(`onboarding.model.cloud.works.${kind}`, {
            model: modelName ?? providerName,
          })}
        </p>
      )}
      {remote.keyTest.state === "refused" && (
        <p
          role="alert"
          data-testid={`onboarding-${prefix}-cloud-error`}
          className="bg-destructive/10 text-destructive mt-2.5 rounded-[10px] px-3 py-2.5 text-[12.5px] leading-snug"
        >
          <strong>{t("onboarding.model.cloud.refusedTitle")}</strong>
          <br />
          {remote.keyTest.message}
        </p>
      )}
      {remote.keyTest.state === "offline" && (
        <p
          role="alert"
          data-testid={`onboarding-${prefix}-cloud-offline`}
          className="mt-2.5 rounded-[10px] bg-amber-500/10 px-3 py-2.5 text-[12.5px] leading-snug text-amber-900 dark:text-amber-200"
        >
          {t("onboarding.model.cloud.offline")}
        </p>
      )}
    </div>
  );
}
