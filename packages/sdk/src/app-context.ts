/**
 * Best-effort description of the application the user was dictating into,
 * captured per recording. Every field is optional because OS introspection
 * can fail or be unavailable.
 */
export interface AppContext {
  appName?: string;
  windowTitle?: string;
  url?: string;
  bundleId?: string;
}

/**
 * The raw app-context payload captured at record time: the frontmost app,
 * window, and (for browsers) URL. Sent by the client as a JSON string, or
 * occasionally as a bare application-name string by simpler captures.
 */
export interface AppContextPayload {
  app?: string;
  url?: string;
  title?: string;
  windowTitle?: string;
  bundleId?: string;
}

/**
 * Parse the raw app-context value handed to the pipeline into the
 * {@link AppContext} shape. Tolerant of missing, malformed, or bare-string
 * input. Every host shares this one parser, so the interpretation does not
 * change between hosts.
 */
export function parseAppContext(
  raw: string | null | undefined,
): AppContext | undefined {
  if (!raw) return undefined;

  let payload: AppContextPayload;
  try {
    payload = JSON.parse(raw) as AppContextPayload;
  } catch {
    // Simpler captures send a bare application name rather than JSON.
    return { appName: raw };
  }

  const result: AppContext = {};
  if (payload.app) result.appName = payload.app;
  const windowTitle = payload.windowTitle ?? payload.title;
  if (windowTitle) result.windowTitle = windowTitle;
  if (payload.url) result.url = payload.url;
  if (payload.bundleId) result.bundleId = payload.bundleId;
  return result;
}
