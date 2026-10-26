import {
  parseServerModelId,
  SERVER_PROVIDER_ID,
  serverModelId,
} from "@openstyle/validations";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@renderer/components/ui/input-group";
import { Progress } from "@renderer/components/ui/progress";
import type {
  AvailableModel,
  LocalEngine,
  WhisperModelDownloadState,
} from "@renderer/lib/models";
import {
  diskUseKey,
  displayProviderName,
  formatBytes,
  formatSpeed,
} from "@renderer/lib/models";
import { cn } from "@renderer/lib/utils";
import type { TFunction } from "i18next";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  Key,
  Loader2,
  Mic,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AddCustomModelDialog } from "./add-custom-model-dialog";
import { kindFitsRole, type ModelRole, type ServerView } from "./server-roles";
import { ServersSection } from "./servers-section";
import { type PickerGroup, SourcePicker } from "./source-picker";
import type { UseModels } from "./use-models";
import { OpenModelSourceButton, recommendedVoiceKey } from "./voice-helpers";

// ---------------------------------------------------------------------------
// Normalized row — one shape for cloud + local, voice + LLM.
// ---------------------------------------------------------------------------

export interface Row {
  key: string;
  name: string;
  source: "cloud" | "local" | "server";
  meta: string;
  selected: boolean;
  /** Shown by default; non-curated rows live behind "Show all models". */
  curated?: boolean;
  /** Own-server rows only: the model fits the role of this list. */
  fits?: boolean;
  /** Own-server rows only: kind label of a model that does not fit the role. */
  kindBadge?: string;
  /** A problem with this row, shown under the name. */
  warning?: string;
  /** LLM gateway display name (e.g. "OpenRouter"); rendered as a meta badge. */
  gateway?: string;
  recommended?: boolean;
  /** An MLX model the user added from Hugging Face. */
  custom?: boolean;
  hasKey?: boolean;
  status?: WhisperModelDownloadState["status"];
  state?: WhisperModelDownloadState;
  /** A delete request for this local model is in flight. */
  deleting?: boolean;
  /** Show the delete button also when the row is selected (the search model). */
  deleteWhenSelected?: boolean;
  onSelect?: () => void;
  onDownload?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onRetry?: () => void;
}

/**
 * The single recommended on-device model: MLX Qwen3 on Apple Silicon,
 * Whisper Balanced everywhere else. One badge per list, ever.
 */
interface VoiceHandlers {
  onPickCloud: (model: AvailableModel) => void;
  onPickLocalVoice: (
    defId: string,
    name: string,
    engine?: "whisper" | "mlx",
  ) => void;
  onRequestDeleteLocal: (defId: string, engine?: LocalEngine) => void;
  onClose: () => void;
}

function buildVoiceRows(m: UseModels, h: VoiceHandlers, t: TFunction): Row[] {
  const recommendedKey = recommendedVoiceKey(m.voiceItems);
  const rows = m.voiceItems.map((it): Row => {
    if (it.kind === "local") {
      const status = it.status ?? "not_downloaded";
      const defId = it.defId;
      const engine = it.localEngine;
      const deleteKey = `${engine ?? "whisper"}:${defId}`;
      const row: Row = {
        key: it.key,
        name: it.name,
        source: "local",
        meta: localMeta(
          t,
          status,
          it.sizeBytes,
          it.note,
          defId
            ? m.diskBytes.get(diskUseKey(engine ?? "whisper", defId))
            : undefined,
        ),
        recommended: it.key === recommendedKey,
        custom: it.custom,
        selected: it.selected && status === "ready",
        status,
        state: it.state,
        deleting: false,
      };
      // A row without a definition id has nothing to select, fetch or delete.
      if (defId) {
        row.deleting = m.deletingKeys.has(deleteKey);
        row.warning = m.deleteErrors.get(deleteKey);
        // The selected MLX voice model can be deleted too (the app then
        // switches to the recommended model, or to no model).
        row.deleteWhenSelected = engine === "mlx";
        row.onSelect = () => h.onPickLocalVoice(defId, it.name, engine);
        row.onDownload = () => m.downloadLocal(defId, engine);
        row.onCancel = () => m.cancelLocal(defId, engine);
        row.onDelete = () => h.onRequestDeleteLocal(defId, engine);
        row.onRetry = () =>
          engine === "mlx"
            ? void m.retryLocalMlx(defId)
            : m.downloadLocal(defId, "whisper");
      }
      return row;
    }

    const providerId = it.available?.provider_id ?? "";
    const cost = it.cost != null ? ` · $${it.cost.toFixed(2)}/hr` : "";
    const note = it.note ? ` · ${it.note}` : "";
    return {
      key: it.key,
      name: it.name,
      source: "cloud",
      meta: `${displayProviderName(providerId, it.provider)}${note}${cost}`,
      selected: it.selected,
      hasKey: it.hasKey,
      onSelect: it.available
        ? () => h.onPickCloud(it.available as AvailableModel)
        : undefined,
    };
  });

  return rows;
}

/**
 * The download size shows until the model is on disk. Then the row shows the
 * real disk use of the model folder (from the server), when it is known.
 */
export function localMeta(
  t: TFunction,
  status: Row["status"],
  sizeBytes: number | undefined,
  note?: string,
  diskBytes?: number,
): string {
  let sizeNote = "";
  if (status !== "ready" && sizeBytes != null) {
    sizeNote = ` · ${formatBytes(sizeBytes)}`;
  } else if (status === "ready" && diskBytes != null) {
    sizeNote = ` · ${t("models.diskUse.onDisk", { size: formatBytes(diskBytes) })}`;
  }
  return `${note ?? t("models.onDevice")}${sizeNote}`;
}

function buildLlmRows(
  m: UseModels,
  h: {
    onPickCloud: (model: AvailableModel) => void;
    onRequestDeleteLocal: (defId: string, engine?: LocalEngine) => void;
    onClose: () => void;
  },
  t: TFunction,
): Row[] {
  // The built-in rows (specs/local-mlx-llm.md section 4) use the voice row.
  const rows: Row[] = m.localLlmItems.map((it) => ({
    key: it.key,
    name: it.name,
    source: "local",
    meta: localMeta(
      t,
      it.status,
      it.sizeBytes,
      undefined,
      m.diskBytes.get(diskUseKey("mlx-llm", it.defId)),
    ),
    recommended: it.recommended,
    selected: it.selected && it.status === "ready",
    status: it.status,
    state: it.state,
    deleting: m.deletingKeys.has(`mlx-llm:${it.defId}`),
    warning: m.deleteErrors.get(`mlx-llm:${it.defId}`),
    // The selected built-in LLM can be deleted too (the app then switches to
    // the recommended model, or to no model).
    deleteWhenSelected: true,
    onSelect: () => void m.selectLocalLlm(it.defId, it.name).then(h.onClose),
    onDownload: () => m.downloadLocal(it.defId, "mlx-llm"),
    onCancel: () => m.cancelLocal(it.defId, "mlx-llm"),
    onDelete: () => h.onRequestDeleteLocal(it.defId, "mlx-llm"),
    onRetry: () => void m.retryLocalMlxLlm(it.defId),
  }));

  for (const [providerId, { providerName, models }] of m.llmModelsByProvider) {
    for (const model of models) {
      // For gateway models the meta line reads "<vendor> via <gateway>"
      // (e.g. "Microsoft via OpenRouter"). Vendor is the model_id prefix; some
      // gateway IDs carry a "~" alias prefix ("~openai/...") — strip it.
      const vendor = model.model_id.replace(/^~/, "").split("/")[0] ?? "";
      const meta = model.gateway
        ? vendor.charAt(0).toUpperCase() + vendor.slice(1)
        : providerName;
      rows.push({
        key: model.model_id,
        name: model.model_name,
        source: "cloud",
        meta,
        curated: model.curated === true,
        gateway: model.gateway,
        selected:
          m.defaultLlm?.model_id === model.model_id &&
          m.defaultLlm?.provider === model.provider_id,
        hasKey: m.keyProviders.has(providerId),
        onSelect: () => h.onPickCloud(model),
      });
    }
  }

  return rows;
}

function buildServerRows(
  m: UseModels,
  role: ModelRole,
  t: TFunction,
  onPickServerModel: (serverId: string, modelId: string) => void,
): Row[] {
  const { servers } = m.servers;
  const selected = role === "voice" ? m.defaultVoice : m.defaultLlm;
  const selectedId =
    selected?.provider === SERVER_PROVIDER_ID ? selected.model_id : null;
  const misfit = t(
    role === "voice"
      ? "models.servers.cannotTranscribe"
      : "models.servers.cannotWrite",
  );

  const rows: Row[] = [];
  for (const server of servers) {
    for (const model of server.models) {
      const id = serverModelId(server.id, model.id);
      const fits = kindFitsRole(model.kind, role);
      const isSelected = id === selectedId;
      rows.push({
        key: id,
        name: model.id,
        source: "server",
        meta: servers.length > 1 ? server.name : "",
        selected: isSelected,
        fits,
        kindBadge: fits ? undefined : t(`models.servers.kind.${model.kind}`),
        warning: isSelected && !fits ? misfit : undefined,
        hasKey: true,
        onSelect: () => onPickServerModel(server.id, model.id),
      });
    }
  }

  // The selected model stays visible, even when its server does not list it.
  if (selectedId && selected && !rows.some((r) => r.key === selectedId)) {
    const parsed = parseServerModelId(selectedId);
    const server = servers.find((s) => s.id === parsed?.serverId);
    rows.push({
      key: selectedId,
      name: parsed?.model ?? selected.model_name,
      source: "server",
      meta: servers.length > 1 && server ? server.name : "",
      selected: true,
      fits: true,
      warning: server?.reachable ? t("models.servers.modelMissing") : undefined,
      hasKey: true,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ModelList: header and rows
// ---------------------------------------------------------------------------

export function ModelList({
  type,
  m,
  onClose,
  onPickCloud,
  onPickLocalVoice,
  onPickServerModel,
  onRequestDeleteLocal,
  onRequestRemoveServer,
}: {
  type: "voice" | "llm";
  m: UseModels;
  onClose: () => void;
  onPickCloud: (model: AvailableModel) => void;
  onPickLocalVoice: (
    defId: string,
    name: string,
    engine?: "whisper" | "mlx",
  ) => void;
  onPickServerModel: (serverId: string, modelId: string) => void;
  onRequestDeleteLocal: (defId: string, engine?: LocalEngine) => void;
  onRequestRemoveServer: (server: ServerView) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"tiers" | PickerGroup>("tiers");
  const [showAll, setShowAll] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
  const { t } = useTranslation();

  if (view === "tiers") {
    return (
      <SourcePicker role={type} m={m} onClose={onClose} onBrowse={setView} />
    );
  }

  const group = view;
  const rows =
    group === "server"
      ? buildServerRows(m, type, t, onPickServerModel)
      : type === "voice"
        ? buildVoiceRows(
            m,
            {
              onPickCloud,
              onPickLocalVoice,
              onRequestDeleteLocal,
              onClose,
            },
            t,
          )
        : buildLlmRows(m, { onPickCloud, onRequestDeleteLocal, onClose }, t);

  const q = search.toLowerCase();
  // Some rows wait behind "Show all models": the models of an own server that
  // do not fit the role, and the non-curated LLM registry models. Searching
  // always searches everything. The selected model of a server stays visible.
  const collapsed = !showAll && !q;
  const isHidden = (r: Row): boolean =>
    group === "server"
      ? r.fits === false && !r.selected
      : type === "llm" && r.source === "cloud" && r.curated !== true;
  const filteredRows = rows.filter((r) => {
    if (group === "builtin" && r.source !== "local") return false;
    if (group === "cloud" && r.source !== "cloud") return false;
    if (
      q &&
      !`${r.name} ${r.meta} ${r.gateway ?? ""}`.toLowerCase().includes(q)
    )
      return false;
    return true;
  });
  const visible = collapsed
    ? filteredRows.filter((r) => !isHidden(r))
    : filteredRows;
  const hiddenCount = filteredRows.length - visible.length;

  // Same gate as the MLX rows: Apple Silicon only.
  const showAddModel =
    type === "voice" &&
    group === "builtin" &&
    m.mlxStatus?.platformSupported === true;

  const scopedTitle =
    group === "builtin"
      ? t("models.picker.builtIn")
      : group === "server"
        ? t("models.picker.ownServer")
        : t("models.picker.cloudPlural");

  // Servers that answer but have no model for this role (specs 3.4).
  const noFitServers =
    group === "server" && collapsed
      ? m.servers.servers.filter(
          (s) =>
            s.reachable &&
            s.models.length > 0 &&
            !s.models.some((it) => kindFitsRole(it.kind, type)),
        )
      : [];

  return (
    <>
      <header className="border-border shrink-0 border-b px-5 py-3.5">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setView("tiers")}
            className="shrink-0 gap-1.5"
            aria-label={t("models.picker.backToSimple")}
          >
            <ArrowLeft data-icon="inline-start" />
            {type === "voice" ? <Mic /> : <Sparkles />}
          </Button>
          <span className="text-foreground min-w-0 flex-1 text-[13px] font-semibold">
            {scopedTitle}
          </span>
          {showAddModel && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddingModel(true)}
              className="shrink-0"
            >
              <Plus data-icon="inline-start" />
              {t("models.custom.addModel")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="shrink-0"
            aria-label={t("common.close")}
          >
            <X />
          </Button>
        </div>
        <InputGroup className="mt-3 h-9 rounded-md">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("models.list.searchPlaceholder")}
            className="placeholder:text-muted-foreground/70 text-[12.5px]"
          />
        </InputGroup>
      </header>

      {type === "voice" &&
        group === "builtin" &&
        m.whisperStatus?.binaryDownloading && (
          <div className="border-border flex items-center gap-2.5 border-b px-5 py-3">
            <Loader2 className="text-primary h-3.5 w-3.5 shrink-0 animate-spin" />
            <span className="text-muted-foreground text-[12px]">
              Building whisper.cpp from source — this may take a minute…
            </span>
          </div>
        )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {group === "server" && (
          <ServersSection
            servers={m.servers}
            onRequestRemove={onRequestRemoveServer}
          />
        )}
        {noFitServers.map((server) => (
          <p
            key={server.id}
            className="text-muted-foreground border-border border-b px-5 py-3 text-[12.5px] leading-snug"
          >
            {t(
              type === "voice"
                ? "models.servers.noSpeechModel"
                : "models.servers.noChatModel",
              { server: server.name },
            )}
          </p>
        ))}
        {visible.length === 0 ? (
          <ListEmptyState
            role={type}
            group={group}
            hasServers={m.servers.servers.length > 0}
            hasHidden={hiddenCount > 0 || noFitServers.length > 0}
          />
        ) : (
          visible.map((row, i) => (
            <ModelRow key={row.key} row={row} first={i === 0} />
          ))
        )}
        {hiddenCount > 0 && (
          <Button
            variant="ghost"
            onClick={() => setShowAll(true)}
            className="border-border text-muted-foreground hover:text-foreground h-auto w-full justify-start rounded-none px-5 py-3 text-left text-[12.5px] font-normal border-x-0 border-b-0"
          >
            {group === "server"
              ? t("models.servers.showAll", { count: hiddenCount })
              : t("models.list.showAll", { count: hiddenCount })}
          </Button>
        )}
      </div>

      {addingModel && (
        <AddCustomModelDialog
          onClose={() => setAddingModel(false)}
          onAdd={m.addCustomModel}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

export function ModelRow({
  row,
  first,
}: {
  row: Row;
  first: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const local = row.source === "local";
  const status = row.status ?? "not_downloaded";
  const downloading =
    local && (status === "downloading" || status === "verifying");
  const deleteButton = row.onDelete && (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={row.onDelete}
      disabled={row.deleting}
      className="text-muted-foreground hover:text-destructive"
      aria-label={t("models.removeDownloaded")}
      title={t("models.removeDownloaded")}
    >
      {row.deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
    </Button>
  );

  return (
    <div
      className={cn(
        "group grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-3.5",
        !first && "border-border border-t",
        row.selected && "bg-primary/[0.06]",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-[14px] font-medium">
            {row.name}
          </span>
          {row.selected && (
            <Check size={14} className="text-primary shrink-0" />
          )}
          {row.recommended && !row.selected && (
            <Badge
              variant="secondary"
              className="shrink-0 text-[10px] font-semibold"
            >
              {t("models.list.recommended")}
            </Badge>
          )}
          {row.custom && (
            <Badge
              variant="outline"
              className="shrink-0 text-[10px] font-semibold"
            >
              {t("models.custom.badge")}
            </Badge>
          )}
          {row.kindBadge && (
            <Badge
              variant="outline"
              className="shrink-0 text-[10px] font-semibold"
            >
              {row.kindBadge}
            </Badge>
          )}
        </div>
        {(row.meta || row.gateway) && (
          <div className="text-muted-foreground mt-0.5 text-[12px]">
            {row.gateway ? (
              <>
                {row.meta}
                {row.meta && " "}
                <span className="text-muted-foreground/70">
                  {t("models.list.via")}
                </span>{" "}
                {row.gateway}
              </>
            ) : (
              row.meta
            )}
          </div>
        )}
        {row.warning && (
          <div className="text-destructive mt-1 flex items-start gap-1.5 text-[11.5px] leading-snug">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            {row.warning}
          </div>
        )}
        {local && status === "error" && row.state?.error && (
          <div className="text-destructive mt-1 text-[11.5px] leading-snug">
            {row.state.error}
          </div>
        )}
        {downloading && <DownloadProgress state={row.state} />}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 justify-self-end">
        {row.selected ? (
          <>
            <span className="text-primary text-[11px] font-semibold">
              {t("models.list.selected")}
            </span>
            {row.deleteWhenSelected && deleteButton}
          </>
        ) : local ? (
          <>
            {status === "ready" && (
              <>
                <Button size="sm" onClick={row.onSelect}>
                  {t("models.list.use")}
                </Button>
                {deleteButton}
              </>
            )}
            {status === "not_downloaded" && (
              <>
                <Button variant="outline" size="sm" onClick={row.onDownload}>
                  <Download data-icon="inline-start" />
                  {t("models.list.download")}
                </Button>
                {/* A custom row leaves the list on delete, so a failed or cancelled add can be removed. */}
                {row.custom && deleteButton}
              </>
            )}
            {downloading && (
              <Button variant="outline" size="sm" onClick={row.onCancel}>
                <X data-icon="inline-start" />
                {t("common.cancel")}
              </Button>
            )}
            {status === "error" && (
              <>
                {row.state?.errorSourceUrl && (
                  <OpenModelSourceButton url={row.state.errorSourceUrl} />
                )}
                <Button variant="outline" size="sm" onClick={row.onRetry}>
                  <RefreshCw data-icon="inline-start" />
                  {t("models.list.retry")}
                </Button>
                {row.custom && deleteButton}
              </>
            )}
          </>
        ) : row.hasKey ? (
          <Button size="sm" onClick={row.onSelect}>
            {t("models.list.use")}
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={row.onSelect}>
            <Key data-icon="inline-start" />
            {t("models.list.addKey")}
          </Button>
        )}
      </div>
    </div>
  );
}

function DownloadProgress({
  state,
}: {
  state?: WhisperModelDownloadState;
}): React.JSX.Element {
  const { t } = useTranslation();
  const p = state?.downloadProgress;
  return (
    <div className="mt-2 space-y-1">
      <Progress
        value={p ? p.percent : 100}
        className={cn(
          "h-[5px] [&>[data-slot=progress-indicator]]:bg-[var(--live)]",
          !p && "animate-pulse",
        )}
      />
      <div className="text-muted-foreground mono flex justify-between text-[10px]">
        {p ? (
          <>
            <span>
              {formatBytes(p.bytesDownloaded)} / {formatBytes(p.bytesTotal)}
            </span>
            <span>
              {p.speedBps > 0 && formatSpeed(p.speedBps)}
              {p.percent > 0 && ` · ${p.percent}%`}
            </span>
          </>
        ) : (
          <span>
            {state?.phase === "building_binary"
              ? t("models.list.preparingRuntime")
              : t("models.list.verifying")}
          </span>
        )}
      </div>
    </div>
  );
}

function ListEmptyState({
  role,
  group,
  hasServers,
  hasHidden,
}: {
  role: ModelRole;
  group: PickerGroup;
  hasServers: boolean;
  /** Models wait behind "Show all models", or a server has none for the role. */
  hasHidden: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (group === "builtin") {
    return (
      <p className="text-muted-foreground px-5 py-8 text-center text-[13px]">
        {t(
          role === "voice"
            ? "models.list.noBuiltin"
            : "models.list.noBuiltinLlm",
        )}
      </p>
    );
  }

  if (group === "server") {
    // The role messages and the Show all button already explain this state.
    if (hasHidden) return null;
    return (
      <p className="text-muted-foreground px-5 py-8 text-center text-[13px]">
        {hasServers ? t("models.list.noMatch") : t("models.servers.noServer")}
      </p>
    );
  }

  return (
    <p className="text-muted-foreground px-5 py-10 text-center text-[13px]">
      {t("models.list.noMatch")}
    </p>
  );
}
