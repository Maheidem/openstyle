/**
 * UI contribution descriptors. A plugin may declare one or more pages in its
 * `package.json` under `openstyle.contributes.pages`; the host renders each in a
 * sandboxed web view and lists it in the Plugins hub.
 */

/** A single page a plugin contributes to the app's UI. */
export interface PluginUIPage {
  /** Stable, plugin-unique id (used in the page route). */
  id: string;
  /** Display title, shown in the hub and as the page heading. */
  title: string;
  /** Optional lucide-react icon name. */
  icon?: string;
  /**
   * Path to the page's HTML entry, relative to the plugin package root
   * (e.g. `"ui/dist/index.html"`).
   */
  entry: string;
}

/**
 * A single declarative settings field a plugin contributes. The host renders
 * these in the plugin's detail page and persists values to this plugin's
 * namespaced settings (`ctx.settings.getOwn(key)`), so a plugin gets
 * configuration without building a full UI page.
 */
export type PluginSettingField =
  | {
      key: string;
      type: "string" | "number";
      label: string;
      description?: string;
      default?: string;
    }
  | {
      key: string;
      type: "boolean";
      label: string;
      description?: string;
      default?: boolean;
    }
  | {
      key: string;
      type: "select";
      label: string;
      description?: string;
      options: { value: string; label: string }[];
      default?: string;
    };

/** The `openstyle.contributes` block of a plugin's `package.json`. */
export interface PluginContributes {
  pages?: PluginUIPage[];
  settings?: PluginSettingField[];
}

/** The `openstyle` block of a plugin's `package.json`. */
export interface PluginManifest {
  /**
   * Human-readable name shown in the Plugins hub. When omitted, the app
   * derives a display name from the package name (stripping scope and
   * `freestyle-plugin-` prefix, then Title Casing).
   */
  displayName?: string;
  /**
   * Icon shown for the plugin in the Plugins hub. Must be the name of an icon
   * from the app's icon set (lucide), in PascalCase (e.g. `"FileMusic"`) or
   * kebab-case (e.g. `"file-music"`). Falls back to a default when omitted or
   * unknown.
   */
  icon?: string;
  contributes?: PluginContributes;
}

/**
 * Derive a URL- and route-safe slug from a package name, e.g.
 * `@openstyle/plugin-audio-transcription` →
 * `openstyle-plugin-audio-transcription`.
 * Used as the `/plugins/:slug/...` route segment, the on-disk package dir, and
 * the per-plugin session partition, since package names can contain `@` and `/`
 * which are unsafe in those contexts.
 */
export function pluginSlug(name: string): string {
  return name
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate the `openstyle` field of a plugin's `package.json` into a
 * normalized list of {@link PluginUIPage}. Tolerant of missing/malformed input:
 * unknown shapes and invalid page entries are dropped rather than throwing, so a
 * bad manifest can never crash plugin discovery.
 */
export function parsePluginPages(openstyleField: unknown): PluginUIPage[] {
  if (!isRecord(openstyleField)) return [];
  const contributes = openstyleField.contributes;
  if (!isRecord(contributes)) return [];
  const pages = contributes.pages;
  if (!Array.isArray(pages)) return [];

  const result: PluginUIPage[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (!isRecord(page)) continue;
    const { id, title, entry, icon } = page;
    if (typeof id !== "string" || !id) continue;
    if (typeof title !== "string" || !title) continue;
    if (typeof entry !== "string" || !entry) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      title,
      entry,
      ...(typeof icon === "string" && icon ? { icon } : {}),
    });
  }
  return result;
}

type SettingFieldType = PluginSettingField["type"];

function isSettingFieldType(value: string): value is SettingFieldType {
  return (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "select"
  );
}

/**
 * Parse and validate the `openstyle` field's `contributes.settings` into a
 * normalized list of {@link PluginSettingField}. Tolerant of missing/malformed
 * input, mirroring {@link parsePluginPages}: unknown shapes, invalid fields,
 * and duplicate keys are dropped rather than throwing.
 */
export function parsePluginSettingsFields(
  openstyleField: unknown,
): PluginSettingField[] {
  if (!isRecord(openstyleField)) return [];
  const contributes = openstyleField.contributes;
  if (!isRecord(contributes)) return [];
  const fields = contributes.settings;
  if (!Array.isArray(fields)) return [];

  const result: PluginSettingField[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (!isRecord(field)) continue;
    const { key, type, label } = field;
    if (typeof key !== "string" || !key) continue;
    if (typeof type !== "string" || !isSettingFieldType(type)) continue;
    if (typeof label !== "string" || !label) continue;
    if (seen.has(key)) continue;

    const description =
      typeof field.description === "string" && field.description
        ? field.description
        : undefined;

    if (type === "select") {
      const options = field.options;
      if (!Array.isArray(options)) continue;
      const parsedOptions = options
        .filter(isRecord)
        .filter(
          (o): o is { value: string; label: string } =>
            typeof o.value === "string" && typeof o.label === "string",
        )
        .map((o) => ({ value: o.value, label: o.label }));
      if (parsedOptions.length === 0) continue;
      seen.add(key);
      result.push({
        key,
        type,
        label,
        options: parsedOptions,
        ...(description ? { description } : {}),
        ...(typeof field.default === "string"
          ? { default: field.default }
          : {}),
      });
      continue;
    }

    if (type === "boolean") {
      seen.add(key);
      result.push({
        key,
        type,
        label,
        ...(description ? { description } : {}),
        ...(typeof field.default === "boolean"
          ? { default: field.default }
          : {}),
      });
      continue;
    }

    // "string" | "number"
    seen.add(key);
    result.push({
      key,
      type,
      label,
      ...(description ? { description } : {}),
      ...(typeof field.default === "string" ? { default: field.default } : {}),
    });
  }
  return result;
}

/**
 * Read the plugin-level `openstyle.icon` from a `package.json`'s `openstyle`
 * field. Returns `undefined` when absent or not a non-empty string.
 */
export function parsePluginIcon(openstyleField: unknown): string | undefined {
  if (!isRecord(openstyleField)) return undefined;
  const { icon } = openstyleField;
  return typeof icon === "string" && icon ? icon : undefined;
}

/**
 * Read the plugin-level `openstyle.displayName` from a `package.json`'s
 * `openstyle` field. Returns `undefined` when absent or not a non-empty string.
 */
export function parsePluginDisplayName(
  openstyleField: unknown,
): string | undefined {
  if (!isRecord(openstyleField)) return undefined;
  const { displayName } = openstyleField;
  return typeof displayName === "string" && displayName.trim()
    ? displayName.trim()
    : undefined;
}
