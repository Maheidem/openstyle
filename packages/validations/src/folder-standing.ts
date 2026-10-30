import { z } from "zod";

// "Where things stand" of a folder (issue #374, specs/folder-project-page.md
// 6). One narrow LLM call writes a few bullets from the open action items,
// the recent decisions and the open questions. The text is saved with the
// hash of its input. The Overview never waits for it.

/** Bullets in the text, at most. */
export const FOLDER_STANDING_MAX_BULLETS = 6;
/** Characters of one bullet, at most. Code cuts a longer one. */
export const FOLDER_STANDING_BULLET_MAX_CHARS = 240;

export const folderStandingSchema = z.object({
  bullets: z
    .array(z.string().min(1).max(FOLDER_STANDING_BULLET_MAX_CHARS))
    .min(1)
    .max(FOLDER_STANDING_MAX_BULLETS),
  generated_at: z.number().int(),
  /** The folder changed after the text was written. */
  stale: z.boolean(),
});
export type FolderStanding = z.infer<typeof folderStandingSchema>;

/** The saved text (null when none) and whether the folder has input for one. */
export const folderStandingStateSchema = z.object({
  standing: folderStandingSchema.nullable(),
  can_generate: z.boolean(),
});
export type FolderStandingState = z.infer<typeof folderStandingStateSchema>;

export const FOLDER_STANDING_ERROR_CODES = [
  "folder_not_found",
  "no_content",
  "no_llm",
  "llm_failed",
] as const;
export type FolderStandingErrorCode =
  (typeof FOLDER_STANDING_ERROR_CODES)[number];

export const folderStandingErrorSchema = z.object({
  error: z.string(),
  code: z.enum(FOLDER_STANDING_ERROR_CODES),
});
