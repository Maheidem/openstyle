import {
  MAX_MEETING_TAGS,
  MAX_TAG_NAME_LENGTH,
  normalizeTagName,
} from "@openstyle/validations";

/** The most suggestions that the tag input shows. */
const MAX_TAG_SUGGESTIONS = 6;

export type AddTagResult =
  | { ok: true; tags: string[] }
  | { ok: false; error: "empty" | "tooLong" | "tooMany" | "exists" };

/** Add one typed tag to a list. The list stays sorted, like the server sends it. */
export function addTag(
  current: readonly string[],
  input: string,
): AddTagResult {
  const name = normalizeTagName(input);
  if (name.length === 0) return { ok: false, error: "empty" };
  if (name.length > MAX_TAG_NAME_LENGTH) return { ok: false, error: "tooLong" };
  if (current.includes(name)) return { ok: false, error: "exists" };
  if (current.length >= MAX_MEETING_TAGS)
    return { ok: false, error: "tooMany" };
  return { ok: true, tags: [...current, name].sort() };
}

export function removeTag(current: readonly string[], name: string): string[] {
  return current.filter((t) => t !== name);
}

/**
 * Existing tags that match the typed text and that the meeting does not have.
 * A tag that starts with the text comes first, then a tag that contains it.
 * With no text, the most used tags come first.
 */
export function tagSuggestions(
  all: readonly { name: string; meeting_count: number }[],
  current: readonly string[],
  input: string,
): string[] {
  const query = normalizeTagName(input);
  const free = all.filter((t) => !current.includes(t.name));
  if (query.length === 0) {
    return [...free]
      .sort(
        (a, b) =>
          b.meeting_count - a.meeting_count || a.name.localeCompare(b.name),
      )
      .slice(0, MAX_TAG_SUGGESTIONS)
      .map((t) => t.name);
  }
  const starts = free.filter((t) => t.name.startsWith(query));
  const contains = free.filter(
    (t) => !t.name.startsWith(query) && t.name.includes(query),
  );
  return [...starts, ...contains]
    .slice(0, MAX_TAG_SUGGESTIONS)
    .map((t) => t.name);
}

/** An error that the tag input shows. */
export type TagError = "tooLong" | "tooMany" | "saveFailed";

/** The i18n key of a shown error. */
export function tagErrorKey(error: TagError): string {
  return `meetings.tags.${error}`;
}
