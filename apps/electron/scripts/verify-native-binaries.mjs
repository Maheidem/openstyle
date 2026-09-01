#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const platform = process.platform;
const arch = process.arch;
const sourceOnly = process.argv.includes("--source-only");

const EXPECTED = {
  darwin: [
    "macos-key-listener",
    "macos-fast-paste",
    "macos-mic-listener",
    "macos-output-volume",
    "macos-media-control",
    // SwiftPM package (specs/meeting-diarization.md §3); compile-native.js
    // builds it warn-only so a broken Swift toolchain doesn't block the
    // other seven binaries, which means nothing else fails CI if it's
    // silently missing. Require it here so that gap is loud instead of
    // silent. Deliberately NOT pairing this with resources/models/
    // speaker-diarization: those model files are fetched from HuggingFace
    // over the network at build time (also warn-only, see
    // fetchDiarizationModels() in compile-native.js) and are gitignored,
    // not vendored — a transient HF hiccup shouldn't fail the whole mac
    // build the way a missing pre-built, network-independent binary should.
    "fluidaudio-diarize",
    // ffmpeg IS network-fetched/built (scripts/download-ffmpeg.mjs) but is
    // a hard runtime dependency of Import, so a failed fetch/build must
    // fail CI rather than ship a build that cannot decode audio.
    "ffmpeg",
  ],
  win32: [
    "windows-key-listener.exe",
    "windows-fast-paste.exe",
    "windows-mic-listener.exe",
    "windows-output-volume.exe",
    "ffmpeg.exe",
  ],
  linux: ["linux-key-listener", "linux-fast-paste", "ffmpeg"],
};

const expected = EXPECTED[platform];
if (!expected) {
  console.log(`[verify-native] Unsupported platform ${platform}, skipping.`);
  process.exit(0);
}

function findPackagedBinDir() {
  const dist = join(ROOT, "dist");
  try {
    if (platform === "darwin") {
      for (const entry of readdirSync(dist)) {
        if (!entry.startsWith("mac")) continue;
        const macDir = join(dist, entry);
        for (const app of readdirSync(macDir)) {
          if (!app.endsWith(".app")) continue;
          return join(macDir, app, "Contents", "Resources", "bin");
        }
      }
    } else if (platform === "win32") {
      return join(dist, "win-unpacked", "resources", "bin");
    } else {
      return join(dist, "linux-unpacked", "resources", "bin");
    }
  } catch {}
  return null;
}

function checkDir(label, dir) {
  const missing = [];
  for (const name of expected) {
    const path = join(dir, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.size === 0) missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    console.error(
      `[verify-native] MISSING in ${label} (${dir}): ${missing.join(", ")}`,
    );
    return false;
  }
  console.log(
    `[verify-native] OK: ${label} has all ${expected.length} binaries.`,
  );
  return true;
}

let ok = checkDir(
  "source",
  join(ROOT, "resources", "bin", `${platform}-${arch}`),
);

if (!sourceOnly) {
  const packagedBinDir = findPackagedBinDir();
  if (!packagedBinDir) {
    console.error(
      "[verify-native] Could not locate the unpacked package under dist/. Did electron-builder run?",
    );
    ok = false;
  } else {
    ok = checkDir("packaged app", packagedBinDir) && ok;
  }
}

process.exit(ok ? 0 : 1);
