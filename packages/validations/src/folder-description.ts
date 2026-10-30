import { z } from "zod";

// The "Suggest" button of the folder description (issue #373,
// specs/folder-description-suggest.md). The server writes a short project
// description from the stored summaries of the folder's meetings. The app
// shows it in the description field and never saves it alone.

/** The longest suggestion, in characters. Code cuts a longer answer. */
export const FOLDER_DESCRIPTION_SUGGEST_MAX_CHARS = 600;

export const folderDescriptionSuggestionSchema = z.object({
  description: z.string().min(1).max(FOLDER_DESCRIPTION_SUGGEST_MAX_CHARS),
  /** The summarized meetings that the suggestion used. */
  meeting_count: z.number().int().positive(),
});
export type FolderDescriptionSuggestion = z.infer<
  typeof folderDescriptionSuggestionSchema
>;

export const FOLDER_DESCRIPTION_SUGGEST_ERROR_CODES = [
  "folder_not_found",
  "no_summaries",
  "no_llm",
  "llm_failed",
] as const;
export type FolderDescriptionSuggestErrorCode =
  (typeof FOLDER_DESCRIPTION_SUGGEST_ERROR_CODES)[number];

export const folderDescriptionSuggestErrorSchema = z.object({
  error: z.string(),
  code: z.enum(FOLDER_DESCRIPTION_SUGGEST_ERROR_CODES),
});
