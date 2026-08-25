// Pure-Node core of the self-updater: no `electron` imports so this file can
// be exercised directly (e.g. `tsx self-updater-core.ts`) outside the packaged
// app. `self-updater.ts` wires this into Electron (paths, events, IPC).
//
// Why this exists: every Openstyle build is ad-hoc signed (no paid Apple
// Developer identity yet). Squirrel.Mac — electron-updater's macOS install
// mechanism — deterministically rejects ad-hoc-signed updates after
// downloading them ("Code signature ... did not pass validation"). This
// module replaces that path on macOS: download the release zip ourselves,
// verify its sha512 against the published `latest-mac.yml`, extract with the
// system `ditto` (preserves the xattr/symlink layout code signing depends on
// — a JS unzip library does not), and atomically swap the app bundle.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ManifestFileEntry {
  url: string;
  sha512: string; // base64, matches electron-builder's latest-*.yml format
  size?: number;
}

export interface ParsedManifest {
  version: string;
  files: ManifestFileEntry[];
}

/**
 * Minimal YAML parser for electron-builder's `latest-mac.yml` shape:
 *   version: 1.1.1
 *   files:
 *     - url: Openstyle-1.1.1-arm64.zip
 *       sha512: <base64>
 *       size: 12345
 *   ...
 * We don't pull in a YAML dependency for this one file shape.
 */
export function parseLatestManifest(yaml: string): ParsedManifest {
  const lines = yaml.split("\n");
  let version = "";
  const files: ManifestFileEntry[] = [];
  let current: Partial<ManifestFileEntry> | null = null;
  let inFiles = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (/^version:\s*/.test(line)) {
      version = line.replace(/^version:\s*/, "").trim();
      continue;
    }
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    // A new top-level key (no indent) ends the files list.
    if (/^\S/.test(line)) {
      inFiles = false;
      continue;
    }
    const itemMatch = line.match(/^\s*-\s*url:\s*(.+)$/);
    if (itemMatch) {
      if (current?.url && current.sha512)
        files.push(current as ManifestFileEntry);
      current = { url: itemMatch[1].trim() };
      continue;
    }
    const shaMatch = line.match(/^\s*sha512:\s*(.+)$/);
    if (shaMatch && current) {
      current.sha512 = shaMatch[1].trim();
      continue;
    }
    const sizeMatch = line.match(/^\s*size:\s*(\d+)/);
    if (sizeMatch && current) {
      current.size = Number(sizeMatch[1]);
    }
  }
  if (current?.url && current.sha512) files.push(current as ManifestFileEntry);

  if (!version) throw new Error("latest-mac.yml: missing version");
  if (files.length === 0) throw new Error("latest-mac.yml: no files listed");
  return { version, files };
}

export async function fetchLatestManifest(
  manifestUrl: string,
): Promise<ParsedManifest> {
  const res = await fetch(manifestUrl, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${manifestUrl}: HTTP ${res.status}`);
  }
  const text = await res.text();
  return parseLatestManifest(text);
}

/** Pick the .zip entry for the running arch, excluding blockmaps. */
export function selectZipEntry(
  manifest: ParsedManifest,
  arch: string,
): ManifestFileEntry {
  const candidates = manifest.files.filter(
    (f) => f.url.endsWith(".zip") && !f.url.endsWith(".blockmap"),
  );
  const archMatch = candidates.find(
    (f) => f.url.includes(`-${arch}.`) || f.url.includes(`-${arch}-`),
  );
  const chosen =
    archMatch ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!chosen) {
    throw new Error(
      `No matching update asset for arch "${arch}" in latest-mac.yml (candidates: ${candidates
        .map((c) => c.url)
        .join(", ")})`,
    );
  }
  return chosen;
}

export interface DownloadProgress {
  percent: number; // 0-100, or -1 if total is unknown
  transferred: number;
  total: number;
}

/**
 * Download `url` to `destPath`, streaming the sha512 hash alongside the
 * write so we never buffer the whole file. Throws if the computed hash
 * (base64) doesn't match `expectedSha512Base64`.
 */
export async function downloadAndVerify(
  url: string,
  expectedSha512Base64: string,
  destPath: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed for ${url}: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get("content-length") ?? 0);
  const hash = createHash("sha512");
  let transferred = 0;
  // Throttle progress callbacks: a raw fetch stream yields ~16-64KB chunks,
  // which is thousands of callbacks for a ~160MB zip. Each one becomes an
  // IPC send to the renderer in the caller, so cap it to ~5/sec plus whole
  // percentage-point changes.
  let lastEmitMs = 0;
  let lastEmittedWholePercent = -1;

  const reader = res.body.getReader();
  const fileStream = createWriteStream(destPath);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(value);
        transferred += value.byteLength;
        await new Promise<void>((resolve, reject) => {
          fileStream.write(value, (err) => (err ? reject(err) : resolve()));
        });
        const percent =
          total > 0 ? Math.min(100, (transferred / total) * 100) : -1;
        const now = Date.now();
        const wholePercent = Math.floor(percent);
        const isDone = transferred === total;
        if (
          now - lastEmitMs >= 200 ||
          wholePercent !== lastEmittedWholePercent ||
          isDone
        ) {
          lastEmitMs = now;
          lastEmittedWholePercent = wholePercent;
          onProgress?.({ percent, transferred, total });
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      fileStream.end((err: unknown) => (err ? reject(err) : resolve()));
    });
  }

  const actual = hash.digest("base64");
  if (actual !== expectedSha512Base64) {
    rmSync(destPath, { force: true });
    throw new Error(
      `sha512 mismatch for ${url}: expected ${expectedSha512Base64}, got ${actual}`,
    );
  }
}

/**
 * Probe whether `dir` (which must already exist) can actually be written to
 * by creating and removing a temp entry in it — more reliable than
 * `fs.access(W_OK)`, which doesn't account for ACLs some macOS locations
 * (like /Applications under certain configurations) apply.
 */
export function probeWritable(dir: string): boolean {
  try {
    const probe = mkdtempSync(join(dir, ".openstyle-write-probe-"));
    rmdirSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Walk up from an executable path to find the containing `.app` bundle. */
export function findAppBundle(exePath: string): string | null {
  let dir = dirname(exePath);
  while (dir !== dirname(dir)) {
    if (dir.endsWith(".app")) return dir;
    dir = dirname(dir);
  }
  return null;
}

/** Extract a zip with `ditto` (preserves xattrs/symlinks/code-signature layout). */
export async function extractZip(
  zipPath: string,
  stagingDir: string,
): Promise<string> {
  mkdirSync(stagingDir, { recursive: true });
  await execFileAsync("/usr/bin/ditto", ["-x", "-k", zipPath, stagingDir]);
  const entries = await readdir(stagingDir, { withFileTypes: true });
  const appDir = entries.find(
    (e) => e.isDirectory() && e.name.endsWith(".app"),
  );
  if (!appDir) {
    throw new Error(`ditto extraction of ${zipPath} produced no .app bundle`);
  }
  return join(stagingDir, appDir.name);
}

/** Read CFBundleShortVersionString out of an extracted bundle's Info.plist. */
export async function readBundleVersion(appPath: string): Promise<string> {
  const plistPath = join(appPath, "Contents", "Info.plist");
  const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    plistPath,
  ]);
  return stdout.trim();
}

/** Sanity-check that an extracted bundle looks like a real, runnable app. */
export function sanityCheckBundle(
  appPath: string,
  executableName: string,
): void {
  const exe = join(appPath, "Contents", "MacOS", executableName);
  if (!existsSync(exe)) {
    throw new Error(`Extracted bundle is missing its executable at ${exe}`);
  }
  if (!existsSync(join(appPath, "Contents", "Info.plist"))) {
    throw new Error(`Extracted bundle is missing Contents/Info.plist`);
  }
}

export interface SwapResult {
  oldBundleBackupPath: string;
}

/**
 * Atomically-as-possible swap `currentAppPath` for `newAppPath` (both must be
 * on the same filesystem, i.e. `newAppPath` should be staged as a sibling of
 * `currentAppPath`, not under a different mount like userData):
 *   1. rename current -> <parent>/.<name>.old-<ts>
 *   2. rename new -> current's original path
 * On failure of step 2, step 1 is rolled back (old renamed back into place).
 */
export function swapBundle(
  currentAppPath: string,
  newAppPath: string,
): SwapResult {
  const parent = dirname(currentAppPath);
  const name = currentAppPath.split("/").pop() ?? "App.app";
  const backupPath = join(parent, `.${name}.old-${Date.now()}`);

  renameSync(currentAppPath, backupPath);
  try {
    renameSync(newAppPath, currentAppPath);
  } catch (err) {
    // Roll back: put the old bundle back where it was.
    try {
      renameSync(backupPath, currentAppPath);
    } catch (rollbackErr) {
      throw new Error(
        `Swap failed AND rollback failed. App may be missing from ${currentAppPath}. ` +
          `Backup left at ${backupPath}. Original error: ${
            err instanceof Error ? err.message : String(err)
          }. Rollback error: ${
            rollbackErr instanceof Error
              ? rollbackErr.message
              : String(rollbackErr)
          }`,
      );
    }
    throw new Error(
      `Failed to move new app into place, rolled back to previous version: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return { oldBundleBackupPath: backupPath };
}

/** Best-effort quarantine removal; failures are logged by the caller, not thrown. */
export async function removeQuarantine(appPath: string): Promise<void> {
  await execFileAsync("/usr/bin/xattr", [
    "-dr",
    "com.apple.quarantine",
    appPath,
  ]).catch(() => {});
}

/** Delete a `.old-<ts>` backup bundle. Swallows errors — best-effort cleanup. */
export async function cleanupBackup(backupPath: string): Promise<void> {
  await rm(backupPath, { recursive: true, force: true }).catch(() => {});
}

/**
 * Sweep leftover `.<name>.app.old-*` backups next to `appPath` (e.g. left
 * behind by a previous update whose cleanup didn't run because the app quit
 * immediately after swapping). Call once on startup.
 */
export async function sweepOldBackups(appPath: string): Promise<void> {
  const parent = dirname(appPath);
  const name = appPath.split("/").pop() ?? "";
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return;
  }
  const prefix = `.${name}.old-`;
  await Promise.all(
    entries
      .filter((e) => e.startsWith(prefix))
      .map((e) =>
        rm(join(parent, e), { recursive: true, force: true }).catch(() => {}),
      ),
  );
}
