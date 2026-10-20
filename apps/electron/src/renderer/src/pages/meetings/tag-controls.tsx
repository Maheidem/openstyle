import { MAX_MEETING_TAGS, MAX_TAG_NAME_LENGTH } from "@openstyle/validations";
import { cn } from "@renderer/lib/utils";
import { Tag, X } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addTag,
  removeTag,
  type TagError,
  tagErrorKey,
  tagSuggestions,
} from "./tags-model";

/**
 * The editable tag chips of the meeting detail header (issue #231). "x"
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
        <li className="relative">
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
          {suggestions.length > 0 && (
            <div
              id={listId}
              className="bg-popover text-popover-foreground border-border absolute top-7 left-0 z-50 min-w-40 rounded-lg border p-1 shadow-md"
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
        </li>
      </ul>
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
