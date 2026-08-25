#!/usr/bin/env node

/**
 * Native Binary Compilation Script
 *
 * Compiles platform-specific native binaries from source files in native/.
 * Runs during dev (predev) and build (prebuild) steps.
 *
 * macOS:  swiftc for Swift sources (universal arm64+x86_64)
 * Windows: cl.exe (MSVC) or gcc (MinGW) for C sources
 * Linux:  gcc for C sources with X11/XTest/GIO/uinput support
 */

import { execFileSync, execSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const NATIVE_DIR = join(ROOT, "native");
const BIN_DIR = join(ROOT, "resources", "bin");
// Pre-bundled offline diarization models (specs/meeting-diarization.md §4,
// amended 2026-08-25). Not platform/arch-scoped like BIN_DIR — the .mlmodelc
// bundles are the same ~22MB set regardless of host arch, and diarization is
// macOS-only already, so there's nothing to key this directory on.
const DIARIZATION_MODELS_DIR = join(
  ROOT,
  "resources",
  "models",
  "speaker-diarization",
);

const platform = process.platform;
const arch = process.arch;
const outputDir = join(BIN_DIR, `${platform}-${arch}`);

const failures = [];

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  try {
    execFileSync(cmd, args, { stdio: "inherit", ...opts });
    return true;
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
    return false;
  }
}

function runShell(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", ...opts });
    return true;
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
    return false;
  }
}

function compileMacOS() {
  console.log("\n[compile:native] Building macOS binaries...\n");

  const swiftcArgs = (src, out, frameworks, minTarget) => {
    const args = ["-O", src, "-o", out];
    if (minTarget) {
      const swiftArch = arch === "arm64" ? "arm64" : "x86_64";
      args.push("-target", `${swiftArch}-apple-macos${minTarget}`);
    }
    for (const fw of frameworks) {
      args.push("-framework", fw);
    }
    return args;
  };

  const binaries = [
    {
      name: "macos-key-listener",
      src: "macos-key-listener.swift",
      frameworks: ["Cocoa"],
    },
    {
      name: "macos-fast-paste",
      src: "macos-fast-paste.swift",
      frameworks: ["Cocoa", "Carbon"],
    },
    {
      name: "macos-mic-listener",
      src: "macos-mic-listener.swift",
      frameworks: ["CoreAudio", "Foundation"],
    },
    {
      name: "macos-output-volume",
      src: "macos-output-volume.swift",
      frameworks: ["CoreAudio", "Foundation"],
    },
    {
      name: "macos-media-control",
      src: "macos-media-control.swift",
      frameworks: ["AppKit", "Foundation"],
    },
    {
      name: "macos-system-audio",
      src: "macos-system-audio.swift",
      frameworks: ["CoreAudio", "AudioToolbox", "AVFAudio", "Foundation"],
      // AudioHardwareCreateProcessTap and friends need a 14.2+ deployment
      // target; the binary self-gates to 14.4 at runtime (ERR_UNSUPPORTED_OS).
      minTarget: "14.2",
    },
    {
      name: "macos-ax",
      src: "macos-ax.swift",
      frameworks: ["ApplicationServices", "Carbon", "Foundation"],
    },
  ];

  for (const bin of binaries) {
    console.log(`  Compiling ${bin.name}...`);
    const src = join(NATIVE_DIR, bin.src);
    const out = join(outputDir, bin.name);

    const ok = run(
      "swiftc",
      swiftcArgs(src, out, bin.frameworks, bin.minTarget),
    );
    if (ok) {
      chmodSync(out, 0o755);
      console.log(`  -> ${out}`);
    } else {
      failures.push(bin.name);
      console.warn(
        `  WARNING: Failed to compile ${bin.name}. Hotkey/paste may fall back to legacy mode.`,
      );
    }
  }

  compileFluidAudioDiarizer();
  fetchDiarizationModels();
}

/**
 * fluidaudio-diarize (specs/meeting-diarization.md §3) is a SwiftPM package
 * depending on FluidAudio, not a single .swift file — swiftc invoked
 * directly (the `binaries` loop above) has no way to resolve or link a
 * package dependency. Built as its own branch via `swift build`.
 *
 * Deliberately NOT recorded in the shared `failures` array the way the
 * `binaries` loop above records its failures — see the bottom of this file:
 * `if (failures.length > 0 && process.env.CI) process.exit(1)` turns any
 * `failures` entry into a hard CI build blocker. That's correct for the
 * other seven binaries (core functionality: hotkeys, paste, audio capture),
 * but wrong for this one specifically — it's an opt-in, default-off feature,
 * and building it needs strictly more than the others (a Swift 6 toolchain,
 * plus network access at build time to fetch the FluidAudio dependency
 * graph). A CI runner that can't satisfy that shouldn't fail the whole
 * `build:mac` over a feature nobody has enabled yet. Warn-only instead, so a
 * missing helper degrades exactly like every other diarization failure mode
 * (spec §10): the flag stays effectively unusable, existing Meeting Mode is
 * unaffected. (Deviation from the spec's own text, which claims this
 * pattern "never aborts the rest of compile:native" — true for the
 * in-process loop, not true for the CI exit gate once pushed into
 * `failures`; see specs/meeting-diarization.md deviations.)
 */
function compileFluidAudioDiarizer() {
  console.log("\n[compile:native] Building fluidaudio-diarize (SwiftPM)...\n");
  const pkgDir = join(NATIVE_DIR, "fluidaudio-diarize");
  const swiftArch = arch === "arm64" ? "arm64" : "x86_64";
  const ok = runShell(
    `swift build -c release --arch ${swiftArch} --package-path "${pkgDir}"`,
  );
  if (!ok) {
    console.warn(
      "  WARNING: diarization helper failed to build. " +
        "Diarization will be unavailable; existing Meeting Mode is unaffected.",
    );
    return;
  }
  const builtBin = join(pkgDir, ".build", "release", "fluidaudio-diarize");
  const out = join(outputDir, "fluidaudio-diarize");
  ensureDir(outputDir);
  copyFileSync(builtBin, out);
  chmodSync(out, 0o755);
  console.log(`  -> ${out}`);
}

// ---------------------------------------------------------------------------
// Diarization model bundling (specs/meeting-diarization.md §4, amended
// 2026-08-25 — pre-bundled models replacing the earlier download-on-first-
// enable design).
//
// Five artifacts, ~22MB total: four .mlmodelc bundles (Segmentation, FBank,
// Embedding, PldaRho) + plda-parameters.json, from HuggingFace repo
// FluidInference/speaker-diarization-coreml — the exact set
// OfflineDiarizerModels.load(from:) looks for under
// `<dir>/speaker-diarization/`. Idempotent (skips when already present) and
// sourced from a local FluidAudio cache when one exists on this machine
// (fast path for dev checkouts that have already run the offline diarizer
// once), else fetched from HuggingFace.
// ---------------------------------------------------------------------------

const DIARIZATION_MLMODELC_NAMES = [
  "Segmentation",
  "FBank",
  "Embedding",
  "PldaRho",
];
// Every .mlmodelc bundle FluidAudio ships for this repo has this exact file
// set (verified against a real downloaded cache) — a compiled CoreML model
// directory, not a single file, hence one URL/copy per relative path rather
// than per bundle.
const MLMODELC_RELATIVE_FILES = [
  "metadata.json",
  "model.mil",
  "coremldata.bin",
  "weights/weight.bin",
  "analytics/coremldata.bin",
];
const DIARIZATION_HF_BASE_URL =
  "https://huggingface.co/FluidInference/speaker-diarization-coreml/resolve/main";
const FLUIDAUDIO_CACHE_DIARIZATION_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "FluidAudio",
  "Models",
  "speaker-diarization",
);

/** True when every required artifact is present at `dir` (cheap existence check, not a full validity check — matches the level of confidence `--probe` gives at runtime). */
function diarizationModelsPresent(dir) {
  if (!existsSync(join(dir, "plda-parameters.json"))) return false;
  return DIARIZATION_MLMODELC_NAMES.every((name) =>
    existsSync(join(dir, `${name}.mlmodelc`, "coremldata.bin")),
  );
}

function fetchDiarizationModels() {
  console.log(
    "\n[compile:native] Fetching diarization models (speaker-diarization)...\n",
  );

  if (diarizationModelsPresent(DIARIZATION_MODELS_DIR)) {
    console.log(`  Already present at ${DIARIZATION_MODELS_DIR}, skipping.`);
    return;
  }

  if (diarizationModelsPresent(FLUIDAUDIO_CACHE_DIARIZATION_DIR)) {
    console.log(
      `  Copying from local FluidAudio cache: ${FLUIDAUDIO_CACHE_DIARIZATION_DIR}`,
    );
    try {
      ensureDir(dirname(DIARIZATION_MODELS_DIR));
      cpSync(FLUIDAUDIO_CACHE_DIARIZATION_DIR, DIARIZATION_MODELS_DIR, {
        recursive: true,
      });
      // The cache also holds config.json/xvector-transform.json, used only
      // by the streaming DiarizerManager (not OfflineDiarizerManager, which
      // is all this CLI helper uses) — trim the copy to the five artifacts
      // the app actually ships.
      for (const extra of ["config.json", "xvector-transform.json"]) {
        const p = join(DIARIZATION_MODELS_DIR, extra);
        if (existsSync(p)) rmSync(p);
      }
      console.log(`  -> ${DIARIZATION_MODELS_DIR}`);
      return;
    } catch (err) {
      console.warn(
        `  WARNING: failed to copy from local cache: ${err.message}`,
      );
      rmSync(DIARIZATION_MODELS_DIR, { recursive: true, force: true });
    }
  }

  console.log(`  Downloading from ${DIARIZATION_HF_BASE_URL} ...`);
  ensureDir(DIARIZATION_MODELS_DIR);
  let ok = true;
  for (const name of DIARIZATION_MLMODELC_NAMES) {
    for (const rel of MLMODELC_RELATIVE_FILES) {
      const url = `${DIARIZATION_HF_BASE_URL}/${name}.mlmodelc/${rel}`;
      const dest = join(DIARIZATION_MODELS_DIR, `${name}.mlmodelc`, rel);
      ensureDir(dirname(dest));
      if (!run("curl", ["-fsSL", "-o", dest, url])) {
        ok = false;
      }
    }
  }
  if (
    !run("curl", [
      "-fsSL",
      "-o",
      join(DIARIZATION_MODELS_DIR, "plda-parameters.json"),
      `${DIARIZATION_HF_BASE_URL}/plda-parameters.json`,
    ])
  ) {
    ok = false;
  }

  if (!ok || !diarizationModelsPresent(DIARIZATION_MODELS_DIR)) {
    console.warn(
      "  WARNING: failed to download diarization models. " +
        "Diarization will be unavailable; existing Meeting Mode is unaffected.",
    );
    rmSync(DIARIZATION_MODELS_DIR, { recursive: true, force: true });
    return;
  }
  console.log(`  -> ${DIARIZATION_MODELS_DIR}`);
}

function compileWindows() {
  console.log("\n[compile:native] Building Windows binaries...\n");

  const binaries = [
    {
      name: "windows-key-listener.exe",
      src: "windows-key-listener.c",
      libs: ["user32.lib"],
    },
    {
      name: "windows-fast-paste.exe",
      src: "windows-fast-paste.c",
      libs: ["user32.lib"],
    },
    {
      name: "windows-mic-listener.exe",
      src: "windows-mic-listener.c",
      libs: ["ole32.lib", "oleaut32.lib"],
    },
    {
      name: "windows-output-volume.exe",
      src: "windows-output-volume.c",
      libs: ["ole32.lib"],
    },
  ];

  for (const bin of binaries) {
    console.log(`  Compiling ${bin.name}...`);
    const src = join(NATIVE_DIR, bin.src);
    const out = join(outputDir, bin.name);

    // Try MSVC first (cl.exe), fall back to gcc (MinGW)
    const clArgs = ["/O2", src, `/Fe:${out}`, ...bin.libs];
    let ok = run("cl", clArgs);

    if (!ok) {
      console.log("  MSVC not found, trying MinGW gcc...");
      const gccLibs = bin.libs.map((l) => `-l${l.replace(".lib", "")}`);
      ok = run("gcc", ["-O2", "-static-libgcc", src, "-o", out, ...gccLibs]);
    }

    if (!ok) {
      failures.push(bin.name);
      console.warn(
        `  WARNING: Failed to compile ${bin.name}. Feature may fall back to legacy mode.`,
      );
    } else {
      console.log(`  -> ${out}`);
    }
  }
}

function compileLinux() {
  console.log("\n[compile:native] Building Linux binaries...\n");

  // Check for required dev packages
  const hasPkgConfig = (() => {
    try {
      execSync("pkg-config --version", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  const hasGio =
    hasPkgConfig &&
    (() => {
      try {
        execSync("pkg-config --exists gio-2.0", { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();

  // linux-fast-paste (full build with uinput + portal if possible)
  console.log("  Compiling linux-fast-paste...");
  {
    const src = join(NATIVE_DIR, "linux-fast-paste.c");
    const out = join(outputDir, "linux-fast-paste");
    const defines = ["-DHAVE_UINPUT"];
    let cflags = "";
    let libs = "-lX11 -lXtst";

    if (hasGio) {
      defines.push("-DHAVE_GIO");
      try {
        cflags = execSync("pkg-config --cflags gio-2.0", {
          encoding: "utf8",
        }).trim();
        libs +=
          " " +
          execSync("pkg-config --libs gio-2.0", { encoding: "utf8" }).trim();
      } catch {
        // Fall through without GIO
      }
    }

    const cmd = `gcc -O2 ${defines.join(" ")} ${cflags} ${src} -o ${out} ${libs}`;
    const ok = runShell(cmd);
    if (ok) {
      chmodSync(out, 0o755);
      console.log(`  -> ${out}`);
    } else {
      // Fallback: minimal build without GIO/uinput
      console.log("  Retrying with minimal build (XTest only)...");
      const minCmd = `gcc -O2 ${src} -o ${out} -lX11 -lXtst`;
      const minOk = runShell(minCmd);
      if (minOk) {
        chmodSync(out, 0o755);
        console.log(`  -> ${out} (XTest only)`);
      } else {
        failures.push("linux-fast-paste");
        console.warn("  WARNING: Failed to compile linux-fast-paste.");
      }
    }
  }

  // linux-key-listener
  console.log("  Compiling linux-key-listener...");
  {
    const src = join(NATIVE_DIR, "linux-key-listener.c");
    const out = join(outputDir, "linux-key-listener");
    const ok = runShell(`gcc -O2 ${src} -o ${out}`);
    if (ok) {
      chmodSync(out, 0o755);
      console.log(`  -> ${out}`);
    } else {
      failures.push("linux-key-listener");
      console.warn("  WARNING: Failed to compile linux-key-listener.");
    }
  }
}

// Main
ensureDir(outputDir);
console.log(`[compile:native] Platform: ${platform}, Arch: ${arch}`);
console.log(`[compile:native] Output: ${outputDir}`);

switch (platform) {
  case "darwin":
    compileMacOS();
    break;
  case "win32":
    compileWindows();
    break;
  case "linux":
    compileLinux();
    break;
  default:
    console.log(
      `[compile:native] Unsupported platform: ${platform}, skipping.`,
    );
}

if (failures.length > 0 && process.env.CI) {
  console.error(
    `\n[compile:native] FAILED in CI: could not compile ${failures.join(", ")}.\n` +
      "Packaged builds must never ship without their native binaries.\n",
  );
  process.exit(1);
}

console.log("\n[compile:native] Done.\n");
