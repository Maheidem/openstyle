// Update channels (specs/update-channels.md). Two channels:
// - "stable": GitHub releases that are not prereleases (version X.Y.Z).
// - "dev": also the prereleases of electron-updater channel "alpha"
//   (version X.Y.Z-alpha.N).
// This file has no Electron import, so the unit tests can load it.
import { gt, prerelease, valid } from "semver";

export type UpdateChannel = "stable" | "dev";

const GITHUB_RELEASES_URL = "https://github.com/Maheidem/openstyle/releases";

function e2eOn(): boolean {
  return (process.env.OPENSTYLE_E2E ?? process.env.FREESTYLE_E2E) === "1";
}

/**
 * The local fake release feed of an E2E run, or null. Only a run with
 * OPENSTYLE_E2E=1 can set it. The form is
 * `http://127.0.0.1:<port>/Maheidem/openstyle/releases`.
 */
export function e2eReleasesUrl(): string | null {
  return (e2eOn() && process.env.OPENSTYLE_E2E_RELEASES_URL) || null;
}

/** The releases URL: the E2E feed when set, else GitHub. */
export function releasesUrl(): string {
  return e2eReleasesUrl() ?? GITHUB_RELEASES_URL;
}

/**
 * The version of the running app. An E2E run with a fake feed can set
 * OPENSTYLE_E2E_APP_VERSION, because an unpackaged app has no release version.
 */
export function runningVersion(appVersion: string): string {
  const override = e2eReleasesUrl()
    ? process.env.OPENSTYLE_E2E_APP_VERSION
    : undefined;
  return override && valid(override) ? override : appVersion;
}

/**
 * The electron-updater GitHub options for a releases URL that is not
 * github.com (the E2E feed). Returns null for an URL that is not of the form
 * `<protocol>://<host>/<owner>/<repo>/releases`.
 */
export function githubFeedOptions(url: string): {
  provider: "github";
  protocol: string;
  host: string;
  owner: string;
  repo: string;
} | null {
  const parsed = new URL(url);
  const match = /^\/([^/]+)\/([^/]+)\/releases\/?$/.exec(parsed.pathname);
  if (!match) return null;
  return {
    provider: "github",
    protocol: parsed.protocol.replace(/:$/, ""),
    host: parsed.host,
    owner: match[1],
    repo: match[2],
  };
}

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "stable" || value === "dev";
}

/** True when the version has a prerelease part, for example "-alpha.1". */
export function isPrerelease(version: string): boolean {
  return (prerelease(version)?.length ?? 0) > 0;
}

/**
 * The channel to use: the saved setting, else the channel of the running
 * version (an alpha build starts on "dev", all other builds on "stable").
 */
export function resolveChannel(saved: unknown, version: string): UpdateChannel {
  if (isUpdateChannel(saved)) return saved;
  return isPrerelease(version) ? "dev" : "stable";
}

/** True only when `candidate` is a valid semver version above `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  if (!valid(candidate) || !valid(current)) return false;
  return gt(candidate, current);
}

/** The electron-updater fields that a channel controls. */
export interface ChannelTarget {
  channel: string | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
}

/**
 * Set the electron-updater fields for a channel. The `channel` setter of
 * electron-updater sets allowDowngrade to true, so this function sets
 * allowDowngrade AFTER it. Only the explicit switch to Stable passes
 * `allowDowngrade: true`.
 */
export function applyChannel(
  updater: ChannelTarget,
  channel: UpdateChannel,
  options: { allowDowngrade?: boolean } = {},
): void {
  updater.channel = channel === "dev" ? "alpha" : "latest";
  updater.allowPrerelease = channel === "dev";
  updater.allowDowngrade = options.allowDowngrade === true;
}

/**
 * True when a switch to `channel` must install an older version: the switch
 * to Stable from a prerelease build (owner decision D4).
 */
export function switchNeedsDowngrade(
  channel: UpdateChannel,
  version: string,
): boolean {
  return channel === "stable" && isPrerelease(version);
}

/**
 * What "Restart & Update" does for a meeting recorder status:
 * - "install": no meeting records. Install at once.
 * - "ask": a meeting records and the user did not agree yet. Ask first.
 * - "stop-then-install": the user agreed. Stop and save the recording, then
 *   install.
 */
export function restartDecision(
  recorderStatus: string,
  stopRecording: boolean,
): "install" | "ask" | "stop-then-install" {
  if (recorderStatus !== "recording") return "install";
  return stopRecording ? "stop-then-install" : "ask";
}
