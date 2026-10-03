import { z } from "zod/v3";

const VOCABULARY_TERM_MAX = 200;
const VOCABULARY_NOTES_MAX = 2_000;
const VOCABULARY_IMPORT_MAX = 1_000;

const vocabularyTermSchema = z
  .string()
  .trim()
  .min(1, "Term is required")
  .max(VOCABULARY_TERM_MAX, "Term is too long");

const vocabularyNotesSchema = z
  .string()
  .trim()
  .max(VOCABULARY_NOTES_MAX, "Notes are too long");

export const createVocabularySchema = z.object({
  term: vocabularyTermSchema,
  notes: vocabularyNotesSchema.optional(),
});

export const updateVocabularySchema = z.object({
  term: vocabularyTermSchema.optional(),
  notes: vocabularyNotesSchema.optional(),
});

export const importVocabularySchema = z
  .array(
    z.object({
      term: vocabularyTermSchema,
      notes: vocabularyNotesSchema.nullable().optional(),
    }),
  )
  .max(VOCABULARY_IMPORT_MAX, "Too many vocabulary entries");

/** Upper bound on ids accepted by a single bulk-delete action. */
const VOCABULARY_BULK_MAX = 1_000;

/**
 * `POST /vocabulary/actions` payload. The only action today is `bulk-delete`.
 * It takes an array of row ids and removes them in a single transaction.
 * Import and export have their own routes: `/import` and `/export`.
 */
export const vocabularyActionSchema = z.object({
  action: z.literal("bulk-delete"),
  ids: z
    .array(z.number().int().positive())
    .min(1, "No entries selected")
    .max(VOCABULARY_BULK_MAX, "Too many entries selected"),
});

export type CreateVocabularyInput = z.infer<typeof createVocabularySchema>;
