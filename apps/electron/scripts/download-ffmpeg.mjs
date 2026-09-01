#!/usr/bin/env node

/**
 * Download or build the bundled LGPL ffmpeg used by Import (audio decode
 * → 16kHz mono WAV before STT).
 *
 * Usage:
 *   node scripts/download-ffmpeg.mjs            # idempotent: skips if present + working
 *   node scripts/download-ffmpeg.mjs --force    # rebuild/redownload even if present
 *
 * On Windows / Linux: downloads a pinned BtbN LGPL static build (sha256
 * verified against the tag's published checksums.sha256).
 * On macOS: no LGPL prebuilt exists anywhere, so a minimal LGPL ffmpeg is
 * built from the pinned source tarball (requires clang + make; ~2-4 min on
 * Apple Silicon). Same precedent as download-whisper-cpp.mjs.
 *
 * The finished binary is cached under
 * ~/.cache/freestyle/ffmpeg/{platform}-{arch}/{version-tag}/ and copied to
 * resources/bin/{platform}-{arch}/ffmpeg[.exe], which electron-builder
 * already ships as <resources>/bin (electron-builder.yml extraResources).
 *
 * ffmpeg is a hard runtime dependency of Import, so any failure here exits
 * non-zero on every platform (unlike the warn-only diarization models).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { cpus, homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const FFMPEG_VERSION = "9.0.1";
const FFMPEG_SOURCE_URL = `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`;
const FFMPEG_SOURCE_SHA256 =
  "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635";

// Month-end BtbN autobuild tag (retained 2 years). `latest` rebuilds daily,
// so its checksums drift; a fixed tag keeps the hashes below stable.
const BTBN_TAG = "autobuild-2026-08-31-13-27";
const BTBN_BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}`;
const BTBN_ASSETS = {
  "win32-x64": {
    file: "ffmpeg-n9.0.1-11-ge47273f4d9-win64-lgpl-9.0.zip",
    sha256: "2484854ad6988d34560f4e6ea7a6ecb9dde0af7c229d2591815d056b04ec4f56",
  },
  "linux-x64": {
    file: "ffmpeg-n9.0.1-11-ge47273f4d9-linux64-lgpl-9.0.tar.xz",
    sha256: "204fc02692b11249c3e688ad18538ce2939129a1fc6abc32a6b2638a024496cf",
  },
  "linux-arm64": {
    file: "ffmpeg-n9.0.1-11-ge47273f4d9-linuxarm64-lgpl-9.0.tar.xz",
    sha256: "a65d190b2391420583546eb8be0aa36b4c219bbc0060bab3f4fa618f178151c5",
  },
};

const KEY = `${process.platform}-${process.arch}`;
const BIN_NAME = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const VERSION_TAG =
  process.platform === "darwin"
    ? `src-${FFMPEG_VERSION}`
    : `${BTBN_TAG}-${FFMPEG_VERSION}`;

const CACHE_DIR = join(
  homedir(),
  ".cache",
  "freestyle",
  "ffmpeg",
  KEY,
  VERSION_TAG,
);
const CACHED_BIN = join(CACHE_DIR, BIN_NAME);
const WORK_DIR = join(CACHE_DIR, "tmp");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ELECTRON_ROOT = join(__dirname, "..");
const OUT_DIR = join(ELECTRON_ROOT, "resources", "bin", KEY);
const OUT_BIN = join(OUT_DIR, BIN_NAME);

const FORCE = process.argv.includes("--force");

async function fetchToFile(url, dest) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const fileStream = createWriteStream(dest);
  const reader = res.body.getReader();
  const nodeStream = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        this.push(Buffer.from(value));
      } catch (err) {
        this.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
  await pipeline(nodeStream, fileStream);
}

async function sha256File(path, expected) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  const actual = hash.digest("hex");
  if (actual !== expected) {
    throw new Error(
      `sha256 mismatch for ${path}\n  expected ${expected}\n  actual   ${actual}`,
    );
  }
}

/** execFileSync with stdio piped; rethrows with the child's stderr attached. */
function execPiped(file, args, options = {}) {
  try {
    return execFileSync(file, args, { stdio: "pipe", ...options });
  } catch (err) {
    const stderr = err.stderr?.toString().trim();
    throw new Error(
      `${file} ${args.join(" ")} failed: ${err.message}${stderr ? `\n${stderr}` : ""}`,
    );
  }
}

function ffmpegVersionLine(bin) {
  const out = execPiped(bin, ["-version"], {
    timeout: 15_000,
    encoding: "utf8",
  });
  return out.split(/\r?\n/)[0];
}

/**
 * True when `bin` exists, runs, and reports the pinned version. A stale
 * binary from an earlier pin is treated as missing so a bump rebuilds it.
 * (BtbN reports e.g. `ffmpeg version n9.0.1-11-g...`, hence `includes`.)
 */
function ffmpegWorks(bin) {
  if (!existsSync(bin)) return false;
  let line;
  try {
    line = ffmpegVersionLine(bin);
  } catch {
    return false;
  }
  if (!line.includes("ffmpeg version")) return false;
  if (!line.includes(FFMPEG_VERSION)) {
    console.log(`ffmpeg at ${bin} is stale (${line}), rebuilding`);
    return false;
  }
  return true;
}

function resetWorkDir() {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
}

function cacheBinary(built) {
  copyFileSync(built, CACHED_BIN);
  if (process.platform !== "win32") chmodSync(CACHED_BIN, 0o755);
}

function installFromCache() {
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(CACHED_BIN, OUT_BIN);
  if (process.platform !== "win32") chmodSync(OUT_BIN, 0o755);
}

async function downloadPrebuilt() {
  const asset = BTBN_ASSETS[KEY];
  if (!asset) {
    throw new Error(`No ffmpeg build configured for ${KEY}`);
  }
  resetWorkDir();
  const archive = join(WORK_DIR, asset.file);
  console.log(`Downloading ${BTBN_BASE}/${asset.file} ...`);
  await fetchToFile(`${BTBN_BASE}/${asset.file}`, archive);
  await sha256File(archive, asset.sha256);

  const extractDir = join(WORK_DIR, "extract");
  mkdirSync(extractDir, { recursive: true });
  if (process.platform === "win32") {
    // Single-quoted PowerShell strings: escape ' as '' (same as
    // download-whisper-cpp.mjs, paths like C:\Users\O'Brien would break).
    const ps = (s) => s.replace(/'/g, "''");
    execPiped(
      "powershell",
      [
        "-Command",
        `Expand-Archive -Force -Path '${ps(archive)}' -DestinationPath '${ps(extractDir)}'`,
      ],
      { timeout: 120_000 },
    );
    // The zip nests everything under ffmpeg-<tag>-win64-lgpl-9.0/bin/.
    const top = asset.file.replace(/\.zip$/, "");
    cacheBinary(join(extractDir, top, "bin", BIN_NAME));
  } else {
    execPiped(
      "tar",
      ["-xJf", archive, "-C", extractDir, "--strip-components=1"],
      { timeout: 120_000 },
    );
    cacheBinary(join(extractDir, "bin", BIN_NAME));
  }
  rmSync(WORK_DIR, { recursive: true, force: true });
}

async function buildFromSource() {
  resetWorkDir();
  const tarPath = join(WORK_DIR, `ffmpeg-${FFMPEG_VERSION}.tar.xz`);
  const srcDir = join(WORK_DIR, "src");

  console.log(`Downloading ${FFMPEG_SOURCE_URL} ...`);
  await fetchToFile(FFMPEG_SOURCE_URL, tarPath);
  await sha256File(tarPath, FFMPEG_SOURCE_SHA256);

  console.log("Extracting...");
  mkdirSync(srcDir, { recursive: true });
  execPiped("tar", ["-xJf", tarPath, "-C", srcDir, "--strip-components=1"], {
    timeout: 120_000,
  });

  // Minimal LGPL decode-only build: only what Import needs to turn
  // wav/mp3/m4a/aac/ogg/mp4/flac/mkv audio into 16kHz mono PCM16 WAV.
  // `--enable-parser` is required after `--disable-everything` or mp3/aac
  // input silently fails to decode.
  const configureArgs = [
    "--cc=clang",
    "--disable-gpl",
    "--disable-nonfree",
    "--disable-autodetect",
    "--disable-x86asm",
    "--disable-everything",
    "--disable-shared",
    "--enable-static",
    "--enable-pic",
    "--disable-doc",
    "--disable-programs",
    "--enable-ffmpeg",
    "--disable-ffplay",
    "--disable-ffprobe",
    "--disable-network",
    "--disable-debug",
    "--enable-avcodec",
    "--enable-avformat",
    "--enable-avfilter",
    "--enable-swresample",
    "--enable-protocol=file,pipe",
    "--enable-demuxer=wav,mp3,mov,aac,ogg,flac,matroska",
    "--enable-decoder=pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_u8,pcm_alaw,pcm_mulaw,mp3float,aac,vorbis,opus,alac,flac",
    "--enable-parser=aac,mpegaudio,vorbis,opus,flac",
    "--enable-encoder=pcm_s16le",
    "--enable-muxer=wav",
    "--enable-filter=aresample,aformat,anull,atrim",
    "--extra-cflags=-mmacosx-version-min=11.0",
    "--extra-ldflags=-mmacosx-version-min=11.0",
  ];

  console.log("Configuring...");
  // Resolved (not a literal "./configure") so static analysis (knip) does
  // not mistake this shell invocation for a module import.
  const configureBin = join(srcDir, "configure");
  execFileSync(configureBin, configureArgs, {
    cwd: srcDir,
    stdio: "inherit",
    timeout: 600_000,
  });

  console.log("Building ffmpeg (this may take a few minutes)...");
  execFileSync("make", [`-j${cpus().length}`, "ffmpeg"], {
    cwd: srcDir,
    stdio: "inherit",
    timeout: 1_800_000,
  });

  const built = join(srcDir, "ffmpeg");
  if (!existsSync(built)) throw new Error("make finished but no ffmpeg binary");

  // Guard against accidentally linking Homebrew/MacPorts libs: the bundled
  // binary must only depend on system dylibs or it breaks on user machines.
  const otool = execPiped("otool", ["-L", built], { encoding: "utf8" });
  const foreign = otool
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !/^(\/usr\/lib\/|\/System\/)/.test(line));
  if (foreign.length > 0) {
    throw new Error(
      `ffmpeg links non-system libraries (would not run on user machines):\n  ${foreign.join("\n  ")}`,
    );
  }

  cacheBinary(built);
  rmSync(WORK_DIR, { recursive: true, force: true });
}

async function main() {
  if (!FORCE && ffmpegWorks(OUT_BIN)) {
    console.log(`ffmpeg already present at ${OUT_BIN}`);
    console.log(`  ${ffmpegVersionLine(OUT_BIN)}`);
    return;
  }

  if (FORCE || !ffmpegWorks(CACHED_BIN)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    if (process.platform === "darwin") {
      await buildFromSource();
    } else {
      await downloadPrebuilt();
    }
    if (!ffmpegWorks(CACHED_BIN)) {
      throw new Error(`Built/downloaded ffmpeg at ${CACHED_BIN} does not run`);
    }
  } else {
    console.log(`Using cached ffmpeg from ${CACHE_DIR}`);
  }

  installFromCache();
  console.log(`Installed ffmpeg to ${OUT_BIN}`);
  console.log(`  ${ffmpegVersionLine(OUT_BIN)}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
