#!/usr/bin/env node

/**
 * Local dev signing (specs/under-the-hood.md, "Testing on the owner's Mac").
 *
 * Ad-hoc signed binaries get a new identity on every rebuild, so macOS asks
 * for the Privacy permissions again. This helper signs local builds with the
 * self-signed identity "Openstyle Dev". The owner creates it once with
 * scripts/dev-signing-setup.sh.
 *
 * The identity is used only when all of these are true:
 *   - the platform is macOS
 *   - the CI env var is not set
 *   - OPENSTYLE_DEV_SIGN is not "0"
 *   - the identity exists (security find-identity -v -p codesigning)
 * Otherwise every function here does nothing, and today's behavior stays.
 *
 * OPENSTYLE_DEV_SIGN_IDENTITY selects another identity name or hash.
 *
 * CLI (run from apps/electron):
 *   node scripts/dev-sign.mjs electron               sign node_modules Electron.app
 *   node scripts/dev-sign.mjs builder <args...>      run electron-builder, signed
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_IDENTITY = "Openstyle Dev";

let cached;

function hashMatch(out, want) {
  return (
    /^[0-9A-Fa-f]{40}$/.test(want) &&
    out.toUpperCase().includes(want.toUpperCase())
  );
}

/** The identity to sign with, or null when local dev signing is off. */
export function devSignIdentity() {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== "darwin") return cached;
  if (process.env.CI || process.env.OPENSTYLE_DEV_SIGN === "0") return cached;
  const want = process.env.OPENSTYLE_DEV_SIGN_IDENTITY || DEFAULT_IDENTITY;
  const r = spawnSync(
    "security",
    ["find-identity", "-v", "-p", "codesigning"],
    {
      encoding: "utf8",
    },
  );
  // Match the quoted name (like the setup script) or a hash.
  if (
    r.status === 0 &&
    (r.stdout.includes(`"${want}"`) || hashMatch(r.stdout, want))
  )
    cached = want;
  else if (r.status === 0)
    console.log(
      `  dev-sign: identity "${want}" not found. Binaries stay ad-hoc signed. Owner: run scripts/dev-signing-setup.sh once.`,
    );
  return cached;
}

/**
 * Sign files or bundles with the dev identity. Does nothing without it.
 * A failure is reported in the return value. The caller decides to exit.
 */
export function devSign(paths, { deep = false } = {}) {
  const identity = devSignIdentity();
  if (!identity) return false;
  let ok = true;
  for (const p of paths) {
    const args = [
      "--force",
      "--sign",
      identity,
      ...(deep ? ["--deep"] : []),
      p,
    ];
    const r = spawnSync("codesign", args, { stdio: "inherit" });
    if (r.status === 0) {
      console.log(`  signed with "${identity}": ${p}`);
    } else {
      ok = false;
      console.error(`  ERROR: codesign failed for ${p}`);
    }
  }
  return ok;
}

/** The scratch HOME of isolated_run has no keychain. Refuse to sign there. */
function guardRealHome() {
  if (!devSignIdentity() && process.platform === "darwin") {
    const real = userInfo().homedir;
    if (process.env.HOME && process.env.HOME !== real) {
      console.error(
        `  ERROR: HOME (${process.env.HOME}) is not the real home (${real}). Run sign:dev outside isolated_run.`,
      );
      process.exit(1);
    }
  }
}

function signElectron() {
  const identity = devSignIdentity();
  if (!identity) return;
  // require("electron") returns <...>/dist/Electron.app/Contents/MacOS/Electron
  const bin = createRequire(import.meta.url)("electron");
  const app = dirname(dirname(dirname(bin)));
  const check = spawnSync("codesign", ["-dv", app], { encoding: "utf8" });
  // Authority shows the certificate name, so a hash identity always re-signs.
  if (check.stderr?.includes(`Authority=${identity}`)) return; // already signed
  if (!devSign([app], { deep: true })) process.exit(1);
}

function runBuilder(args) {
  const identity = devSignIdentity();
  const extra = identity
    ? [`-c.mac.identity=${identity}`, "-c.mac.notarize=false"]
    : [];
  // Without dev signing, stop electron-builder from finding the
  // "Openstyle Dev" identity in the keychain. A caller value wins.
  const env = identity
    ? process.env
    : { CSC_IDENTITY_AUTO_DISCOVERY: "false", ...process.env };
  const r = spawnSync("electron-builder", [...args, ...extra], {
    stdio: "inherit",
    env,
    shell: process.platform === "win32", // electron-builder is a .cmd file there
  });
  if (r.error) console.error(`  ERROR: electron-builder: ${r.error.message}`);
  process.exit(r.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "electron") {
    guardRealHome();
    signElectron();
  } else if (cmd === "builder") runBuilder(rest);
  else {
    console.error(
      "usage: dev-sign.mjs electron | builder <electron-builder args>",
    );
    process.exit(1);
  }
}
