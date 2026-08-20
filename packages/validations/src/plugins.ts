import { z } from "zod/v3";

/**
 * A leading URI scheme (`http:`, `https:`, `file:`, `data:`, `node:`, ...).
 * Mirrors the check `packages/sdk`'s loader applies to the same specifier
 * before handing it to a dynamic `import()`, so a bad value is rejected here
 * — at the settings-validation layer — rather than only at load time.
 */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * A plugin specifier: a local file path or a bare/scoped module name. Never a
 * URL — the loader hands this straight to a dynamic `import()`, so allowing a
 * remote or `data:` specifier here would be a code-execution primitive, not
 * just an invalid setting.
 */
const pluginSpecifierSchema = z
  .string()
  .min(1)
  .refine((specifier) => !SCHEME_RE.test(specifier), {
    message:
      "plugin specifier must be a local file path or bare module name, not a URL",
  });

/**
 * A single plugin entry: either a bare package/module specifier, or a
 * `[specifier, options]` tuple carrying free-form configuration. Mirrors the
 * shape OpenCode and Vite accept.
 */
export const pluginEntrySchema = z.union([
  pluginSpecifierSchema,
  z.tuple([pluginSpecifierSchema, z.record(z.unknown())]),
]);

export type PluginEntry = z.infer<typeof pluginEntrySchema>;

/** The persisted `plugins` setting: a list of plugin entries. */
export const pluginsSettingSchema = z.array(pluginEntrySchema);

export type PluginsSetting = z.infer<typeof pluginsSettingSchema>;

/**
 * Coerce a persisted JSON string into a valid {@link PluginsSetting}, returning
 * an empty list when missing or malformed. Invalid *entries* are dropped
 * individually rather than discarding the whole list: this runs on every
 * read (app startup), not just on a user's edit, so a single bad/legacy entry
 * (e.g. a URL specifier written before this validation existed) must not
 * silently disable every other plugin the user has configured. Write-time
 * validation (`apps/server/src/routes/settings.ts`) still rejects the whole
 * update via {@link pluginsSettingSchema} when any entry is invalid, so a user
 * editing the setting gets clear, immediate feedback instead of silent drops.
 */
export function parsePluginsSetting(
  value: string | null | undefined,
): PluginsSetting {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result: PluginsSetting = [];
  for (const item of parsed) {
    const entry = pluginEntrySchema.safeParse(item);
    if (entry.success) result.push(entry.data);
  }
  return result;
}

/** Normalize an entry to its specifier + options. */
export function pluginEntryParts(entry: PluginEntry): {
  specifier: string;
  options?: Record<string, unknown>;
} {
  return typeof entry === "string"
    ? { specifier: entry }
    : { specifier: entry[0], options: entry[1] };
}

/**
 * The persisted `disabled_plugins` setting: a list of plugin specifiers the
 * user has turned off. Disabled plugins remain installed (still shown in the
 * hub) but their hooks don't load and their pages aren't shown.
 */
export const disabledPluginsSettingSchema = z.array(z.string().min(1));

export type DisabledPluginsSetting = z.infer<
  typeof disabledPluginsSettingSchema
>;

/** Coerce a persisted JSON string into a list of disabled plugin specifiers. */
export function parseDisabledPlugins(
  value: string | null | undefined,
): DisabledPluginsSetting {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  const result = disabledPluginsSettingSchema.safeParse(parsed);
  return result.success ? result.data : [];
}
