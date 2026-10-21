import { MAX_MEETING_TAGS, MAX_TAG_NAME_LENGTH } from "@openstyle/validations";
import { Button } from "@renderer/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";
import { Plus, Tag, X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fitTagCount } from "./header-model";
import {
  addTag,
  removeTag,
  type TagError,
  tagErrorKey,
  tagSuggestions,
} from "./tags-model";

/**
 * The editable tag chips of a meeting (issue #231). The tag line of the
 * detail header opens them in a popover (issue #262). "x"
 * removes a tag, Enter adds the typed tag, and a click on a suggestion adds
 * an existing tag. It needs no LLM model.
 */
export function MeetingTagChips({
  tags,
  allTags,
  onSave,
}: {
  tags: readonly string[];
  allTags: readonly { name: string; meeting_count: number }[];
  onSave: (tags: string[]) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TagError | null>(null);
  const listId = useId();
  const hintId = useId();
  const suggestions = focused ? tagSuggestions(allTags, tags, input) : [];

  const save = async (next: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
      return true;
    } catch {
      setError("saveFailed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (value: string) => {
    const result = addTag(tags, value);
    if (!result.ok) {
      // A tag that the meeting has already is not an error to show.
      if (result.error === "exists") setInput("");
      else if (result.error !== "empty") setError(result.error);
      return;
    }
    if (await save(result.tags)) setInput("");
  };

  return (
    <div className="mt-2">
      <ul
        className="flex flex-wrap items-center gap-1"
        aria-label={t("meetings.tags.label")}
      >
        {tags.map((name) => (
          <li
            key={name}
            className="bg-secondary text-secondary-foreground inline-flex h-6 max-w-full items-center gap-1 rounded-[5px] pr-0.5 pl-2 text-[11.5px]"
          >
            <span className="truncate">{name}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(removeTag(tags, name))}
              aria-label={t("meetings.tags.remove", { name })}
              className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex size-5 items-center justify-center rounded-[4px] outline-none focus-visible:ring-2 disabled:opacity-50"
            >
              <X className="size-3" />
            </button>
          </li>
        ))}
        <li>
          <div
            className={cn(
              "border-border text-muted-foreground inline-flex h-6 items-center gap-1 rounded-[5px] border border-dashed px-1.5",
              focused && "border-solid",
            )}
          >
            <Tag className="size-3 shrink-0" />
            <input
              value={input}
              disabled={busy}
              maxLength={MAX_TAG_NAME_LENGTH + 10}
              placeholder={t("meetings.tags.placeholder")}
              aria-label={t("meetings.tags.add")}
              aria-describedby={error ? hintId : undefined}
              aria-invalid={Boolean(error)}
              aria-controls={suggestions.length > 0 ? listId : undefined}
              className="placeholder:text-muted-foreground text-foreground w-28 bg-transparent text-[11.5px] outline-none"
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(event) => {
                setInput(event.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void add(input);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setInput("");
                  setError(null);
                }
              }}
            />
          </div>
        </li>
      </ul>
      {/* In the flow under the chips, not over the page: the list pushes the
          context line down and never covers it (issue #238). */}
      {suggestions.length > 0 && (
        <div
          id={listId}
          className="bg-popover text-popover-foreground border-border mt-1 w-fit min-w-40 rounded-lg border p-1 shadow-md"
        >
          <p className="text-muted-foreground px-2 py-1 text-[10.5px]">
            {t("meetings.tags.suggestions")}
          </p>
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              // Keep the focus in the input, so the list stays open.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void add(name)}
              className="hover:bg-accent focus-visible:bg-accent flex w-full items-center rounded-md px-2 py-1 text-left text-[12px] outline-none"
            >
              {name}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p
          id={hintId}
          role="alert"
          className="text-destructive mt-1 text-[10.5px]"
        >
          {t(tagErrorKey(error), {
            max: error === "tooLong" ? MAX_TAG_NAME_LENGTH : MAX_MEETING_TAGS,
          })}
        </p>
      )}
    </div>
  );
}

/** The gap between the items of the tag line, in px (`gap-1`). */
const TAG_GAP = 4;
/** The narrowest width of a chip, in px: about 6 characters. */
const MIN_CHIP_WIDTH = 56;
/** The width that the "+N" chip needs, in px. */
const MORE_CHIP_WIDTH = 34;
/** The width of the "+" button and its gap, in px (`icon-xs`). */
const ADD_BUTTON_WIDTH = 24 + TAG_GAP;
const chipClass =
  "bg-secondary text-secondary-foreground inline-flex h-6 max-w-40 items-center rounded-[5px] px-2 text-[11.5px]";

/**
 * The tags of the detail header on one line (issue #262). As many chips as
 * the width allows show, at least 3, then a "+N" chip for the rest. "+N"
 * and the small "+" open the full tag editor (remove, add, suggestions) in
 * a popover. A hidden copy of the chips gives their widths.
 */
export function MeetingTagLine({
  tags,
  allTags,
  onSave,
  trailing,
}: {
  tags: readonly string[];
  allTags: readonly { name: string; meeting_count: number }[];
  onSave: (tags: string[]) => Promise<unknown>;
  /** One more icon button after "+", for example "Add context". */
  trailing?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(tags.length);
  const [widths, setWidths] = useState<number[]>([]);
  const lineRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  const hasTrailing = trailing != null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the tags change
  useLayoutEffect(() => {
    const line = lineRef.current;
    const measure = measureRef.current;
    if (!line || !measure) return;
    const update = () => {
      const widths = [...measure.children].map(
        (chip) => (chip as HTMLElement).offsetWidth,
      );
      setWidths(widths);
      setVisible(
        fitTagCount(
          widths,
          TAG_GAP,
          line.clientWidth - ADD_BUTTON_WIDTH * (hasTrailing ? 2 : 1),
          MORE_CHIP_WIDTH + TAG_GAP,
          3,
          MIN_CHIP_WIDTH,
        ),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(line);
    return () => observer.disconnect();
  }, [tags, hasTrailing]);

  const shown = tags.slice(0, visible);
  const rest = tags.length - shown.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          ref={lineRef}
          className="relative flex min-w-0 flex-1 items-center"
        >
          {/* The hidden copy measures the full chip widths. It is clipped
              to the line, so it does not make the detail column wider
              (issue #266). The chips do not shrink, so the widths stay. */}
          <div
            ref={measureRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute top-0 left-0 flex max-w-full gap-1 overflow-hidden"
          >
            {tags.map((name) => (
              <span key={name} className={cn(chipClass, "shrink-0")}>
                <span className="truncate">{name}</span>
              </span>
            ))}
          </div>
          <ul
            className="flex min-w-0 items-center gap-1 overflow-hidden"
            aria-label={t("meetings.tags.label")}
            data-testid="meetings-tag-line"
          >
            {shown.map((name, i) => (
              <li
                key={name}
                className={cn(chipClass, "shrink")}
                // A chip shrinks, but never below about 6 characters.
                style={{
                  minWidth: Math.min(widths[i] ?? 0, MIN_CHIP_WIDTH),
                }}
              >
                <span className="truncate">{name}</span>
              </li>
            ))}
            {rest > 0 && (
              <li className="shrink-0">
                <button
                  type="button"
                  onClick={() => setOpen(true)}
                  className="border-border text-muted-foreground hover:text-foreground inline-flex h-6 items-center rounded-[5px] border px-1.5 text-[11.5px]"
                  aria-label={t("meetings.tags.showAll")}
                  title={tags.slice(visible).join(", ")}
                >
                  +{rest}
                </button>
              </li>
            )}
            <li className="shrink-0">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setOpen(true)}
                aria-label={t("meetings.tags.add")}
                title={t("meetings.tags.add")}
                className="text-muted-foreground"
              >
                {tags.length === 0 ? <Tag /> : <Plus />}
              </Button>
            </li>
            {trailing && <li className="shrink-0">{trailing}</li>}
          </ul>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-80">
        <MeetingTagChips tags={tags} allTags={allTags} onSave={onSave} />
      </PopoverContent>
    </Popover>
  );
}
