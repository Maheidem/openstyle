/** The du-like disk use of the model folders (Models page disk use). */
import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskUsageBytes } from "../src/lib/model-disk-usage.js";

/** `du -sk <path>`, in KiB. */
function duKib(path: string): number {
  const out = execFileSync("du", ["-sk", path], { encoding: "utf8" });
  return Number(out.trim().split(/\s+/)[0]);
}

describe("diskUsageBytes", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "disk-usage-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches du -sk for an HF cache folder with blobs, links and a hard link", () => {
    const repo = join(dir, "models--org--name");
    const blobs = join(repo, "blobs");
    const snap = join(repo, "snapshots", "abc");
    mkdirSync(blobs, { recursive: true });
    mkdirSync(snap, { recursive: true });
    writeFileSync(join(blobs, "weights"), Buffer.alloc(300_000, 1));
    writeFileSync(join(blobs, "config"), "{}");
    symlinkSync("../../blobs/weights", join(snap, "model.safetensors"));
    symlinkSync("../../blobs/config", join(snap, "config.json"));
    // du counts a file with two names once.
    linkSync(join(blobs, "weights"), join(repo, "weights-hardlink"));

    const bytes = diskUsageBytes(repo);
    expect(bytes).toBeGreaterThanOrEqual(300_000);
    expect(Math.ceil(bytes / 1024)).toBe(duKib(repo));
  });

  it("is 0 for a path that does not exist", () => {
    expect(diskUsageBytes(join(dir, "missing"))).toBe(0);
  });
});
