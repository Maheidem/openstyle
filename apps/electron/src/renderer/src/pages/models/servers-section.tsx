import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import {
  InputGroup,
  InputGroupInput,
} from "@renderer/components/ui/input-group";
import { RevealToggle } from "@renderer/components/ui/reveal-toggle";
import { Loader2, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ServerView } from "./server-roles";
import type { AddServerResult, UseServers } from "./use-servers";

const ERROR_KEYS: Record<string, string> = {
  unreachable: "models.servers.unreachable",
  unauthorized: "models.servers.unauthorized",
  not_openai: "models.servers.notOpenai",
};

/** Part 1 of the own-server screen: the servers, their status and the add form. */
export function ServersSection({
  servers,
  onRequestRemove,
}: {
  servers: UseServers;
  onRequestRemove: (server: ServerView) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);

  return (
    <section className="border-border border-b px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-foreground text-[13px] font-semibold">
          {t("models.servers.title")}
        </span>
        {!adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" />
            {t("models.servers.add")}
          </Button>
        )}
      </div>
      {servers.servers.length > 0 && (
        <div className="border-border divide-border mb-3 divide-y overflow-hidden rounded-lg border">
          {servers.servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              onRetry={() => void servers.refetch()}
              onRemove={() => onRequestRemove(server)}
            />
          ))}
        </div>
      )}
      {adding && (
        <AddServerForm
          onAdd={servers.addServer}
          onDone={() => setAdding(false)}
        />
      )}
    </section>
  );
}

function ServerRow({
  server,
  onRetry,
  onRemove,
}: {
  server: ServerView;
  onRetry: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const errorKey = server.reachable
    ? null
    : (ERROR_KEYS[server.error ?? ""] ?? ERROR_KEYS.unreachable);
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Server className="text-muted-foreground size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-[13px] font-medium">
          {server.name}
        </div>
        <div className="mono text-muted-foreground truncate text-[11px]">
          {server.base_url}
        </div>
        <div
          className={
            errorKey
              ? "text-destructive mt-0.5 text-[12px] leading-snug"
              : "text-muted-foreground mt-0.5 text-[12px]"
          }
        >
          {errorKey
            ? t(errorKey)
            : t("models.picker.modelCount", { count: server.models.length })}
        </div>
      </div>
      {errorKey && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw data-icon="inline-start" />
          {t("models.servers.retry")}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        className="text-muted-foreground hover:text-destructive"
        aria-label={t("models.servers.remove")}
        title={t("models.servers.remove")}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

function AddServerForm({
  onAdd,
  onDone,
}: {
  onAdd: (url: string, apiKey: string) => Promise<AddServerResult>;
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (): Promise<void> => {
    setConnecting(true);
    setError(null);
    const result = await onAdd(url, apiKey);
    setConnecting(false);
    if (result.ok) {
      onDone();
      return;
    }
    setError(
      result.error === "duplicate"
        ? t("models.servers.duplicate")
        : result.error === "invalid"
          ? (result.message ?? t("models.servers.addFailed"))
          : result.error === "failed"
            ? t("models.servers.addFailed")
            : t(ERROR_KEYS[result.error]),
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
      className="space-y-3"
    >
      <Input
        type="text"
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          setError(null);
        }}
        placeholder="http://127.0.0.1:8123"
        aria-label={t("models.servers.address")}
        aria-invalid={error ? true : undefined}
      />
      <InputGroup>
        <InputGroupInput
          type={showKey ? "text" : "password"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t("models.servers.keyOptional")}
          aria-label={t("models.servers.keyOptional")}
        />
        <RevealToggle
          revealed={showKey}
          onToggle={() => setShowKey(!showKey)}
          label="API key"
        />
      </InputGroup>
      {error && (
        <p className="text-destructive text-[12px] leading-snug">{error}</p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={connecting || !url.trim()}>
          {connecting ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : null}
          {t("models.servers.connect")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDone}
          disabled={connecting}
        >
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
