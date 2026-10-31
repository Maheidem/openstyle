import type {
  ChatBlock,
  ChatCite,
  ChatListItem,
  ChatMessage,
} from "@openstyle/validations";
import { cn } from "@renderer/lib/utils";
import { Check, Circle } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  answerBlocks,
  type CiteTarget,
  citesForLabels,
  citeView,
  summarizeTrace,
} from "./ask-model";

/** How a chip finds its target and opens it. The Ask tab gives both. */
export interface CiteActions {
  resolve: (cite: ChatCite) => CiteTarget;
  open: (target: CiteTarget) => void;
}

/** A cite chip: a real button. Its name has the title and the time. */
function CiteChip({
  cite,
  actions,
}: {
  cite: ChatCite;
  actions: CiteActions;
}): React.JSX.Element {
  const { t } = useTranslation();
  const view = citeView(cite);
  const target = actions.resolve(cite);
  const removed = target.kind === "removed";
  const title = view.title ?? t("meetings.ask.untitled");
  const name = removed
    ? t("meetings.ask.citeRemovedName", { label: view.label })
    : view.time
      ? t("meetings.ask.citeOpen", { title, time: view.time })
      : t("meetings.ask.citeOpenNoTime", { title });
  const visible = removed
    ? t("meetings.ask.citeRemoved")
    : (view.time ?? t("meetings.ask.citeSummary"));
  return (
    <button
      type="button"
      disabled={removed}
      aria-label={name}
      title={name}
      onClick={() => actions.open(target)}
      data-testid="meeting-ask-cite"
      className={cn(
        "border-border bg-muted text-muted-foreground mono rounded-md border px-1.5 py-0.5 text-[10px]",
        "hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {view.label} · {visible}
    </button>
  );
}

function CiteRow({
  cites,
  actions,
}: {
  cites: ChatCite[];
  actions: CiteActions;
}): React.JSX.Element | null {
  if (cites.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {cites.map((c) => (
        <CiteChip key={c.label} cite={c} actions={actions} />
      ))}
    </div>
  );
}

/** One list item. The done state is a word and an icon, never colour alone. */
function ListItemRow({
  item,
  showDone,
  cites,
  actions,
}: {
  item: ChatListItem;
  showDone: boolean;
  cites: ChatCite[];
  actions: CiteActions;
}): React.JSX.Element {
  const { t } = useTranslation();
  const itemCites = item.label ? citesForLabels([item.label], cites) : [];
  return (
    <li className="flex flex-col gap-0.5" data-testid="meeting-ask-list-item">
      <div className="flex items-start gap-2">
        {showDone &&
          (item.done ? (
            <Check
              className="text-foreground mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
          ) : (
            <Circle
              className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
          ))}
        <span className="min-w-0 break-words">{item.text}</span>
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-3 text-[11.5px]">
        {showDone && (
          <span>
            {item.done ? t("meetings.ask.done") : t("meetings.ask.open")}
          </span>
        )}
        {item.owner && (
          <span>{t("meetings.ask.owner", { name: item.owner })}</span>
        )}
        {item.due && <span>{t("meetings.ask.due", { date: item.due })}</span>}
      </div>
      <CiteRow cites={itemCites} actions={actions} />
    </li>
  );
}

function Block({
  block,
  cites,
  actions,
}: {
  block: ChatBlock;
  cites: ChatCite[];
  actions: CiteActions;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  switch (block.kind) {
    case "text":
      return (
        <div data-testid="meeting-ask-block-text">
          <p className="m-0 break-words whitespace-pre-wrap">{block.text}</p>
          <CiteRow
            cites={citesForLabels(block.cites, cites)}
            actions={actions}
          />
        </div>
      );
    case "list":
      return (
        <div data-testid="meeting-ask-block-list">
          <p className="text-muted-foreground m-0 mb-1 text-[11.5px]">
            {t(`meetings.ask.list.${block.list}`, { count: block.total })}
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {block.items.map((item, i) => (
              <ListItemRow
                // The server gives no stable id for every item.
                key={`${item.item_id ?? item.meeting_id ?? "x"}-${i}`}
                item={item}
                showDone={block.list === "action_items"}
                cites={cites}
                actions={actions}
              />
            ))}
          </ul>
        </div>
      );
    case "count":
      return (
        <div
          className="flex items-baseline gap-2"
          data-testid="meeting-ask-block-count"
        >
          <span className="text-foreground text-2xl font-semibold tabular-nums">
            {block.n}
          </span>
          <span className="text-muted-foreground">
            {t(`meetings.ask.count.${block.what}`, { count: block.n })}
          </span>
        </div>
      );
    case "status":
      return (
        <div data-testid="meeting-ask-block-status">
          {block.bullets.length > 0 && (
            <ul className="m-0 list-disc pl-5">
              {block.bullets.map((b) => (
                <li key={b} className="break-words">
                  {b}
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground m-0 mt-1 text-[11.5px]">
            {t("meetings.ask.statusCounts", {
              actions: block.open_actions,
              questions: block.open_questions,
            })}
          </p>
        </div>
      );
    case "not_found":
      return (
        <div data-testid="meeting-ask-block-not-found">
          <p className="m-0">
            {t(
              block.reason === "no_sources"
                ? block.scope.kind === "folder"
                  ? "meetings.ask.notFound.noSourcesFolder"
                  : "meetings.ask.notFound.noSourcesMeeting"
                : `meetings.ask.notFound.${block.reason}`,
            )}
          </p>
          {block.nearest.length > 0 && (
            <>
              <p className="text-muted-foreground m-0 mt-1.5 text-[11.5px]">
                {t("meetings.ask.nearest")}
              </p>
              <CiteRow cites={block.nearest} actions={actions} />
            </>
          )}
        </div>
      );
    case "read_only":
      return (
        <p className="m-0" data-testid="meeting-ask-block-read-only">
          {t("meetings.ask.readOnly")}
        </p>
      );
    default:
      return null;
  }
}

/** The answer of the assistant: its blocks, then the step trail. */
export function AskAnswer({
  message,
  actions,
}: {
  message: ChatMessage;
  actions: CiteActions;
}): React.JSX.Element {
  const { t } = useTranslation();
  const blocks = answerBlocks(message);
  const parts = summarizeTrace(message.trace);
  const dropped = message.trace?.sources_dropped.length ?? 0;
  return (
    <div className="flex flex-col gap-2" data-testid="meeting-ask-answer">
      {blocks.map((block, i) => (
        <Block
          // Blocks have no id. The list does not change after the answer.
          key={i}
          block={block}
          cites={message.cites}
          actions={actions}
        />
      ))}
      {message.trace && (
        <details
          className="text-muted-foreground text-[11.5px]"
          data-testid="meeting-ask-trail"
        >
          <summary className="cursor-pointer select-none">
            {t("meetings.ask.trailTitle")}
          </summary>
          <p className="m-0 mt-1">
            {parts.length === 0
              ? t("meetings.ask.trailNone")
              : parts
                  .map((p) =>
                    t(`meetings.ask.trail.${p.key}`, { count: p.count }),
                  )
                  .join(", ")}
            {dropped > 0 && (
              <>
                {". "}
                {t("meetings.ask.trailDropped", { count: dropped })}
              </>
            )}
          </p>
        </details>
      )}
    </div>
  );
}
