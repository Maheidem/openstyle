import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@renderer/components/ui/input-group";
import {
  type CustomModelCheck,
  type CustomModelFailure,
  type CustomModelResult,
  customModelFailureText,
  type MlxSearchHit,
  searchMlxModels,
  validateCustomMlxModel,
} from "@renderer/lib/custom-models";
import { formatBytes } from "@renderer/lib/models";
import { cn } from "@renderer/lib/utils";
import { AlertTriangle, CheckCircle2, Loader2, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Wait this long after the last key press before the search runs. */
const SEARCH_DEBOUNCE_MS = 400;

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; hits: MlxSearchHit[] }
  | { status: "error"; failure: CustomModelFailure };

type CheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; result: CustomModelCheck }
  | { status: "blocked"; failure: CustomModelFailure };

/**
 * "Add model" dialog for local MLX models (specs/custom-mlx-models.md 3.2).
 * A search box and a paste field feed one validation. The Add button runs only
 * on a model that passed it.
 */
export function AddCustomModelDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (model: string) => Promise<CustomModelResult<{ id: string }>>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [pasted, setPasted] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const [adding, setAdding] = useState(false);
  // Only the newest check may set the state: a slow answer must not replace it.
  const checkSeq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearch({ status: "idle" });
      return;
    }
    setSearch({ status: "loading" });
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      const result = await searchMlxModels(q, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setSearch(
        result.ok
          ? { status: "ok", hits: result.data }
          : { status: "error", failure: result.failure },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  const runCheck = async (model: string) => {
    const seq = ++checkSeq.current;
    setCheck({ status: "checking" });
    const result = await validateCustomMlxModel(model);
    if (seq !== checkSeq.current) return;
    setCheck(
      result.ok
        ? { status: "ok", result: result.data }
        : { status: "blocked", failure: result.failure },
    );
  };

  const pickHit = (id: string) => {
    setSelectedId(id);
    void runCheck(id);
  };

  const submitPasted = () => {
    const model = pasted.trim();
    if (!model) return;
    setSelectedId(null);
    void runCheck(model);
  };

  const add = async () => {
    if (check.status !== "ok") return;
    setAdding(true);
    const result = await onAdd(check.result.hfId);
    setAdding(false);
    if (result.ok) onClose();
    else setCheck({ status: "blocked", failure: result.failure });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[80vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <header className="border-border flex shrink-0 items-start gap-3 border-b px-5 py-4">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[14px] font-semibold">
              {t("models.custom.title")}
            </DialogTitle>
            <DialogDescription className="mt-1 text-[12.5px]">
              {t("models.custom.description")}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="shrink-0"
            aria-label={t("models.custom.close")}
          >
            <X />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <InputGroup className="h-9 rounded-md">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("models.custom.searchPlaceholder")}
              aria-label={t("models.custom.searchPlaceholder")}
              maxLength={100}
              autoFocus
              className="text-[12.5px]"
            />
          </InputGroup>

          <SearchResults
            search={search}
            selectedId={selectedId}
            onPick={pickHit}
          />

          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitPasted();
            }}
          >
            <Input
              type="text"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={t("models.custom.pastePlaceholder")}
              aria-label={t("models.custom.pastePlaceholder")}
              maxLength={300}
              className="min-w-0 flex-1 text-[12.5px]"
            />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={!pasted.trim() || check.status === "checking"}
              className="shrink-0"
            >
              {t("models.custom.check")}
            </Button>
          </form>

          <CheckPanel check={check} />
        </div>

        <footer className="border-border flex shrink-0 justify-end gap-2 border-t px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("models.custom.cancel")}
          </Button>
          <Button
            variant="ink"
            size="sm"
            onClick={() => void add()}
            disabled={check.status !== "ok" || adding}
          >
            {adding ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("models.custom.adding")}
              </span>
            ) : (
              t("models.custom.addAndDownload")
            )}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function SearchResults({
  search,
  selectedId,
  onPick,
}: {
  search: SearchState;
  selectedId: string | null;
  onPick: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();

  if (search.status === "idle") {
    return <Note>{t("models.custom.emptySearch")}</Note>;
  }
  if (search.status === "loading") {
    return (
      <Note>
        <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
        {t("models.custom.searching")}
      </Note>
    );
  }
  if (search.status === "error") {
    const { key, values } = customModelFailureText(search.failure);
    return <Note tone="error">{t(key, values)}</Note>;
  }
  if (search.hits.length === 0) {
    return <Note>{t("models.custom.noResults")}</Note>;
  }
  return (
    <ul className="border-border max-h-56 divide-border divide-y overflow-y-auto rounded-md border">
      {search.hits.map((hit) => (
        <li key={hit.id}>
          <button
            type="button"
            onClick={() => onPick(hit.id)}
            aria-pressed={hit.id === selectedId}
            className={cn(
              "hover:bg-secondary/40 flex w-full items-center justify-between gap-3 px-3 py-2 text-left",
              hit.id === selectedId && "bg-primary/[0.06]",
            )}
          >
            <span className="text-foreground min-w-0 truncate text-[12.5px] font-medium">
              {hit.id}
            </span>
            <span className="text-muted-foreground mono shrink-0 text-[11px]">
              {t("models.custom.downloads", {
                downloads: hit.downloads.toLocaleString(),
              })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function CheckPanel({
  check,
}: {
  check: CheckState;
}): React.JSX.Element | null {
  const { t } = useTranslation();

  if (check.status === "idle") return null;
  if (check.status === "checking") {
    return (
      <Note>
        <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
        {t("models.custom.checking")}
      </Note>
    );
  }
  if (check.status === "blocked") {
    const { key, values } = customModelFailureText(check.failure);
    return (
      <div className="bg-destructive/10 flex items-start gap-2 rounded-md px-3 py-2">
        <AlertTriangle className="text-destructive mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-destructive text-[12px] font-semibold">
            {t("models.custom.blocked")}
          </p>
          <p className="text-destructive text-[12px] leading-snug">
            {t(key, values)}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="bg-primary/[0.06] flex items-start gap-2 rounded-md px-3 py-2">
      <CheckCircle2 className="text-primary mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-primary text-[12px] font-semibold">
          {t("models.custom.supported")}
        </p>
        <p className="text-foreground break-all text-[12px] leading-snug">
          {check.result.hfId}
        </p>
        <p className="text-muted-foreground text-[12px]">
          {t("models.custom.details", {
            family: check.result.family,
            size: formatBytes(check.result.totalBytes),
          })}
        </p>
        {check.result.processorSource && (
          <p className="text-muted-foreground text-[12px]">
            {t("models.custom.standardTokenizer")}
          </p>
        )}
      </div>
    </div>
  );
}

function Note({
  tone,
  children,
}: {
  tone?: "error";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p
      className={cn(
        "px-1 py-2 text-center text-[12.5px] leading-snug",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}
