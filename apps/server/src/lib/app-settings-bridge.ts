// The app-shell settings (pill position, auto-update, update channel, launch
// at login) live in the Electron main process, not in the server DB
// (specs/mcp.md 6.4). The server asks main over the utility-process
// parentPort. The entry file of the utility process sets the sender and
// gives each answer to `handleAppSettingsResult`. A standalone server has no
// sender: `requestAppSettings` then throws `NoAppShellError`.

/** A change of the app-shell settings. A field that is left out stays. */
export interface AppSettingsPatch {
  pill_position?: "top-center" | "top-right" | "bottom-center" | "bottom-right";
  auto_update?: boolean;
  update_channel?: "stable" | "dev";
  launch_at_login?: boolean;
}

/** The message to main. `patch` is null for a read. */
export interface AppSettingsRequest {
  type: "app-settings-request";
  id: number;
  patch: AppSettingsPatch | null;
}

/** The answer of main. */
export type AppSettingsResult =
  | {
      type: "app-settings-result";
      id: number;
      ok: true;
      settings: Record<string, unknown>;
    }
  | { type: "app-settings-result"; id: number; ok: false; error: string };

/** The longest wait for main, the same as the model-cache-dirs request. */
export const APP_SETTINGS_WAIT_MS = 5000;

export class NoAppShellError extends Error {
  constructor() {
    super("App settings need the Openstyle app. This server runs without it.");
  }
}

export class AppShellTimeoutError extends Error {
  constructor() {
    super("The Openstyle app did not answer in time. Try again.");
  }
}

type Sender = (message: AppSettingsRequest) => void;

let sender: Sender | null = null;
let nextId = 1;
const pending = new Map<
  number,
  (result: AppSettingsResult | "timeout") => void
>();

/** The entry file sets this. null removes it (tests). */
export function setAppSettingsSender(fn: Sender | null): void {
  sender = fn;
}

/** The entry file calls this for each `app-settings-result` message. */
export function handleAppSettingsResult(result: AppSettingsResult): void {
  pending.get(result.id)?.(result);
}

/** Ask main to read (patch null) or change the app-shell settings. */
export function requestAppSettings(
  patch: AppSettingsPatch | null,
  waitMs = APP_SETTINGS_WAIT_MS,
): Promise<Record<string, unknown>> {
  const send = sender;
  if (!send) return Promise.reject(new NoAppShellError());
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish("timeout"), waitMs);
    function finish(result: AppSettingsResult | "timeout") {
      clearTimeout(timer);
      pending.delete(id);
      if (result === "timeout") reject(new AppShellTimeoutError());
      else if (result.ok) resolve(result.settings);
      else reject(new Error(result.error));
    }
    pending.set(id, finish);
    try {
      send({ type: "app-settings-request", id, patch });
    } catch {
      // The parent is gone.
      clearTimeout(timer);
      pending.delete(id);
      reject(new NoAppShellError());
    }
  });
}
